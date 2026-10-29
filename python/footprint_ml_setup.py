"""Explicit setup and read-only diagnostics for the optional native capture host.

No installer, subprocess or network activity happens on import. Only ``setup``
installs the disclosed, pinned Node SDK and its optional investigation peers.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
from typing import Any

from footprint_ml_versions import PACKAGE_VERSIONS, PYTHON_VERSION, SDK_VERSION

MAX_COMMAND_BYTES = 262_144
COMMAND_TIMEOUT = 120.0
DOCTOR_TIMEOUT = 20.0


class SetupError(RuntimeError):
    pass


def runtime_directory(value: str | os.PathLike[str] | None = None) -> Path:
    return (Path(value).expanduser().absolute() if value is not None else
            Path(sys.prefix) / "share" / "footprintjs-ml" / SDK_VERSION)


def sdk_directory(runtime_dir: str | os.PathLike[str] | None = None) -> Path:
    return runtime_directory(runtime_dir) / "node_modules" / "footprintjs-ml"


def _invoke(arguments: list[str], *, cwd: Path | None = None,
            timeout: float = DOCTOR_TIMEOUT, forward_stderr: bool = False) -> str:
    """Bound both execution time and retained command output; never invoke a shell."""
    process = subprocess.Popen(arguments, cwd=cwd, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    buffers = [bytearray(), bytearray()]
    overflow = threading.Event()

    def drain(pipe: Any, buffer: bytearray) -> None:
        try:
            while chunk := pipe.read(4096):
                remaining = MAX_COMMAND_BYTES - len(buffer)
                buffer.extend(chunk[:max(0, remaining)])
                if len(chunk) > remaining:
                    overflow.set()
                    try:
                        process.terminate()
                    except OSError:
                        pass
                    return
        except (OSError, ValueError):
            return

    assert process.stdout is not None and process.stderr is not None
    threads = [threading.Thread(target=drain, args=(process.stdout, buffers[0]), daemon=True),
               threading.Thread(target=drain, args=(process.stderr, buffers[1]), daemon=True)]
    for thread in threads:
        thread.start()
    try:
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
            raise SetupError(f"Command timed out after {timeout:g}s: {Path(arguments[0]).name}") from None
        for thread in threads:
            thread.join(timeout=1)
        if overflow.is_set():
            raise SetupError("Command output exceeded its byte limit")
        out, err = (bytes(buffer).decode("utf-8", errors="replace") for buffer in buffers)
        if process.returncode != 0:
            raise SetupError(f"{Path(arguments[0]).name} failed (exit {process.returncode}): {(err or out)[-8192:].strip()}")
        if forward_stderr and err:
            sys.stderr.write(err)
            if not err.endswith("\n"):
                sys.stderr.write("\n")
        return out.strip()
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        process.stdout.close()
        process.stderr.close()


def _node() -> dict[str, Any]:
    executable = shutil.which("node")
    if executable is None:
        raise SetupError("Node.js 22+ is required. Install Node explicitly, then run doctor again.")
    version = _invoke([executable, "--version"])
    match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)(?:[-+].*)?", version)
    if match is None or int(match[1]) < 22:
        raise SetupError(f"Node.js 22+ is required; found {version!r} at {executable}.")
    return {"executable": executable, "version": version, "major": int(match[1]), "minor": int(match[2])}


_IMPORT_CHECK = """
const write = await import('foottrace/write');
const observe = await import('agentfootprint/observe');
const adapter = await import('footprintjs-ml/adapter');
await import('./node_modules/footprintjs-ml/dist/adapter/capture-worker.js');
for (const value of [write.SharedMemory, write.EventLog, write.RecordFrame,
  observe.openRecording, observe.traceToolpack, observe.callTraceTool, adapter.servePythonCapture]) {
  if (typeof value !== 'function') throw new Error('Installed helper API is unavailable');
}
console.log(JSON.stringify({importsReady:true,captureStarted:false,trainingStarted:false}));
"""


def doctor(runtime_dir: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    """Read files and explicitly inspect Node APIs, without opening capture or installing anything."""
    root = runtime_directory(runtime_dir)
    report: dict[str, Any] = {"schema": "footprint-ml-python-doctor/v1", "ok": False,
        "sdkVersion": SDK_VERSION, "pythonVersion": PYTHON_VERSION, "runtimeDir": str(root),
        "packages": {}, "checks": {"nodeCompatible": False, "packageVersionsMatch": False,
        "workerPresent": False, "importsReady": False}, "errors": [],
        "execution": {"installsStarted": False, "captureStarted": False, "trainingStarted": False,
                      "mlflowImported": False, "networkRequested": False}}
    try:
        report["node"] = _node()
        report["checks"]["nodeCompatible"] = True
    except Exception as error:
        report["errors"].append(str(error))
    versions_match = True
    for name, expected in PACKAGE_VERSIONS.items():
        actual = None
        try:
            metadata = json.loads((root / "node_modules" / name / "package.json").read_text("utf-8"))
            if type(metadata) is not dict or metadata.get("name") != name:
                raise ValueError(f"Unexpected package name for {name}")
            actual = metadata.get("version")
        except (OSError, ValueError) as error:
            report["errors"].append(f"Cannot read installed {name}: {error}")
        report["packages"][name] = {"expected": expected, "actual": actual}
        if actual != expected:
            versions_match = False
            report["errors"].append(f"Expected {name}@{expected}; found {actual!r}.")
    report["checks"]["packageVersionsMatch"] = versions_match
    worker = sdk_directory(root) / "dist" / "adapter" / "capture-worker.js"
    report["worker"] = str(worker)
    report["checks"]["workerPresent"] = worker.is_file()
    if not worker.is_file():
        report["errors"].append("The installed capture worker is missing. Run explicit setup for this SDK version.")
    if report["checks"]["nodeCompatible"] and versions_match and worker.is_file():
        try:
            result = json.loads(_invoke([report["node"]["executable"], "--input-type=module", "-e", _IMPORT_CHECK], cwd=root))
            if result != {"importsReady": True, "captureStarted": False, "trainingStarted": False}:
                raise SetupError("Unexpected helper import-readiness result")
            report["checks"]["importsReady"] = True
        except Exception as error:
            report["errors"].append(str(error))
    report["ok"] = all(report["checks"].values())
    report["captureCommand"] = [report.get("node", {}).get("executable", "node"), str(worker)]
    report["usage"] = {"python": sys.executable,
                       "capture": f"WorkflowCapture('recording.json', runtime_dir={str(root)!r})"}
    return report


def _archive(path: str | os.PathLike[str]) -> tuple[str, str]:
    source = Path(path).expanduser().absolute()
    if not source.is_file():
        raise SetupError("--archive must name a local SDK .tgz file")
    try:
        with tarfile.open(source, "r:gz") as archive:
            entry = archive.getmember("package/package.json")
            if not entry.isfile() or entry.size > 65_536:
                raise SetupError("SDK archive has invalid package metadata")
            stream = archive.extractfile(entry)
            assert stream is not None
            metadata = json.loads(stream.read())
    except (OSError, ValueError, KeyError, tarfile.TarError) as error:
        raise SetupError(f"Cannot read SDK archive metadata: {error}") from None
    if type(metadata) is not dict or metadata.get("name") != "footprintjs-ml" or metadata.get("version") != SDK_VERSION:
        raise SetupError(f"The SDK archive must contain footprintjs-ml@{SDK_VERSION}")
    digest = hashlib.sha256()
    with source.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1_048_576), b""):
            digest.update(chunk)
    return str(source), digest.hexdigest()


def setup(runtime_dir: str | os.PathLike[str] | None = None,
          archive: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    """Explicit network/install entry. Existing targets are never repaired or overwritten."""
    if runtime_dir is None and sys.prefix == sys.base_prefix:
        raise SetupError("Use a Python virtual environment, or explicitly choose --runtime-dir. No system runtime was changed.")
    root = runtime_directory(runtime_dir)
    node = _node()
    if root.exists() or root.is_symlink():
        existing = doctor(root)
        if not existing["ok"]:
            raise SetupError("The runtime target already exists but does not pass doctor. Choose a new --runtime-dir; existing files were preserved.")
        return {"schema": "footprint-ml-python-setup/v1", "ok": True, "status": "already-installed",
                "runtimeDir": str(root), "doctor": existing, "networkRequested": False}
    npm = shutil.which("npm")
    if npm is None:
        raise SetupError("npm is required for explicit setup. Install it with Node.js, then retry setup.")
    archive_path, archive_sha = _archive(archive) if archive is not None else (
        f"https://github.com/footprintjs/footprintjs-ml/releases/download/v{SDK_VERSION}/footprintjs-ml-{SDK_VERSION}.tgz", None)
    root.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{root.name}.setup-", dir=root.parent))
    try:
        (staging / "package.json").write_text(json.dumps({"name": "footprint-ml-python-runtime", "private": True}), "utf-8")
        arguments = [npm, "install", "--prefix", str(staging), archive_path,
                     *[f"{name}@{version}" for name, version in PACKAGE_VERSIONS.items() if name != "footprintjs-ml"],
                     "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "--loglevel=error"]
        _invoke(arguments, cwd=staging, timeout=COMMAND_TIMEOUT)
        checked = doctor(staging)
        if not checked["ok"]:
            raise SetupError("Installed runtime failed doctor: " + "; ".join(checked["errors"]))
        manifest = {"schema": "footprint-ml-python-runtime/v1", "sdkVersion": SDK_VERSION,
                    "packages": PACKAGE_VERSIONS, "source": archive_path, "archiveSha256": archive_sha}
        (staging / "footprint-runtime.json").write_text(json.dumps(manifest, indent=2) + "\n", "utf-8")
        if root.exists() or root.is_symlink():
            raise SetupError("Runtime target appeared during setup. Existing files were preserved.")
        staging.rename(root)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    final = doctor(root)
    if not final["ok"]:
        raise SetupError("The installed runtime is not ready at its final location: " + "; ".join(final["errors"]))
    return {"schema": "footprint-ml-python-setup/v1", "ok": True, "status": "installed",
            "runtimeDir": str(root), "node": node, "doctor": final, "networkRequested": True,
            "archiveSha256": archive_sha}


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise SetupError(message)


def _ready(runtime_dir: str | os.PathLike[str] | None) -> tuple[Path, dict[str, Any]]:
    report = doctor(runtime_dir)
    if not report["ok"]:
        raise SetupError("Run explicit setup first; doctor failed: " + "; ".join(report["errors"]))
    return runtime_directory(runtime_dir), report


def main(arguments: list[str] | None = None) -> int:
    parser = _Parser(prog="python -m footprint_ml_workflow")
    commands = parser.add_subparsers(dest="command", required=True)
    install = commands.add_parser("setup")
    install.add_argument("--archive")
    install.add_argument("--runtime-dir")
    inspect = commands.add_parser("doctor")
    inspect.add_argument("--runtime-dir")
    for name in ("example-mlflow", "example-guards"):
        example = commands.add_parser(name)
        example.add_argument("--out", required=True)
        example.add_argument("--runtime-dir")
    investigate = commands.add_parser("investigate")
    investigate.add_argument("--run", required=True)
    investigate.add_argument("--variable", required=True)
    investigate.add_argument("--before", type=int)
    investigate.add_argument("--runtime-dir")
    try:
        args = parser.parse_args(arguments)
        if args.command == "setup":
            result = setup(args.runtime_dir, args.archive)
        elif args.command == "doctor":
            result = doctor(args.runtime_dir)
        elif args.command in ("example-mlflow", "example-guards"):
            root, ready = _ready(args.runtime_dir)
            folder = "mlflow" if args.command == "example-mlflow" else "python-guards"
            script = sdk_directory(root) / "examples" / folder / "run.py"
            if not script.is_file():
                raise SetupError(f"The installed {folder} example is missing")
            output = _invoke([sys.executable, str(script), "--out", str(Path(args.out).expanduser().absolute()),
                              "--runtime-dir", str(root)], timeout=COMMAND_TIMEOUT, forward_stderr=True)
            result = {"schema": "footprint-ml-python-example/v1", "ok": True, "runtimeDir": str(root),
                      "exampleResult": json.loads(output), "python": sys.executable}
        else:
            if args.before is not None and (args.before < 0 or args.before > 2**53 - 1):
                raise SetupError("--before must be a nonnegative safe integer")
            root, ready = _ready(args.runtime_dir)
            source = Path(args.run).expanduser().resolve()
            folder = source if source.is_dir() else source.parent
            node = ready["node"]
            permission = "--experimental-permission" if node["major"] == 22 and node["minor"] < 13 else "--permission"
            cli = sdk_directory(root) / "examples" / "quickstart" / "cli.mjs"
            command = [node["executable"], permission, f"--allow-fs-read={root}",
                       f"--allow-fs-read={folder}", f"--allow-fs-write={folder}", str(cli),
                       "investigate", "--run", str(source), "--variable", args.variable]
            if args.before is not None:
                command.extend(["--before", str(args.before)])
            output = _invoke(command)
            result = {"schema": "footprint-ml-python-investigation/v1", "ok": True,
                      "runtimeDir": str(root), "report": str(folder / "investigation-variable.json"),
                      "nativeOutput": output, "childProcessesAllowed": False, "trainingStarted": False}
        print(json.dumps(result, indent=2, allow_nan=False))
        return 0 if result["ok"] else 1
    except Exception as error:
        print(json.dumps({"schema": "footprint-ml-python-command-error/v1", "ok": False,
                          "error": {"type": type(error).__name__, "message": str(error)}}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
