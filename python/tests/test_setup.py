"""Setup tests use stdlib fixtures, never a network install or optional ML import."""
from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

PYTHON = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PYTHON))

import footprint_ml_setup as setup
from footprint_ml_versions import PACKAGE_VERSIONS, SDK_VERSION
from footprint_ml_workflow import WorkflowCapture, CaptureError

READY = json.dumps({"importsReady": True, "captureStarted": False, "trainingStarted": False})
NODE = {"executable": "/fixture/node", "version": "v24.1.0", "major": 24, "minor": 1}


def fixture_runtime(root):
    for name, version in PACKAGE_VERSIONS.items():
        directory = root / "node_modules" / name
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "package.json").write_text(json.dumps({"name": name, "version": version}))
    worker = root / "node_modules" / "footprintjs-ml" / "dist" / "adapter" / "capture-worker.js"
    worker.parent.mkdir(parents=True)
    worker.write_text("// fixture only: never executed\n")
    return worker


def fixture_archive(root, version=SDK_VERSION):
    path = root / "sdk.tgz"
    metadata = json.dumps({"name": "footprintjs-ml", "version": version}).encode()
    with tarfile.open(path, "w:gz") as archive:
        entry = tarfile.TarInfo("package/package.json")
        entry.size = len(metadata)
        archive.addfile(entry, io.BytesIO(metadata))
    return path


class PythonSetupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="footprint setup ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def test_import_and_construction_have_no_subprocess_or_optional_dependency(self):
        script = """
import builtins, subprocess, sys
sys.path.insert(0, sys.argv[1])
original=builtins.__import__
def guarded(name,*args,**kwargs):
    if name.split('.')[0] in {'numpy','mlflow','sklearn','jax','torch','footprint_ml_adapter'}:
        raise AssertionError('Unexpected optional import '+name)
    return original(name,*args,**kwargs)
builtins.__import__=guarded
subprocess.Popen=lambda *args,**kwargs: (_ for _ in ()).throw(AssertionError('Unexpected process'))
import footprint_ml_workflow, footprint_ml_setup, footprint_ml_versions
footprint_ml_workflow.WorkflowCapture('recording.json', runtime_dir='runtime not installed')
"""
        result = subprocess.run([sys.executable, "-I", "-S", "-c", script, str(PYTHON)], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_doctor_checks_exact_versions_and_public_imports_without_installing(self):
        target = self.root / "runtime with spaces"
        fixture_runtime(target)
        with patch.object(setup, "_node", return_value=NODE), patch.object(setup, "_invoke", return_value=READY) as invoke:
            report = setup.doctor(target)
        self.assertTrue(report["ok"])
        self.assertEqual(report["packages"]["footprintjs-ml"]["actual"], SDK_VERSION)
        self.assertFalse(report["execution"]["networkRequested"])
        self.assertEqual(invoke.call_count, 1)
        self.assertIn("foottrace/write", invoke.call_args.args[0][-1])
        self.assertEqual(invoke.call_args.kwargs["cwd"], target)

    def test_doctor_wrong_package_version_does_not_import_unmatched_runtime(self):
        target = self.root / "runtime"
        fixture_runtime(target)
        (target / "node_modules" / "footprintjs-ml" / "package.json").write_text(json.dumps({"name": "footprintjs-ml", "version": "0.0.0"}))
        with patch.object(setup, "_node", return_value=NODE), patch.object(setup, "_invoke") as invoke:
            report = setup.doctor(target)
        self.assertFalse(report["ok"])
        self.assertFalse(report["checks"]["packageVersionsMatch"])
        invoke.assert_not_called()

    def test_default_setup_refuses_system_environment_without_any_command(self):
        with patch.object(setup.sys, "prefix", "/fixture/system"), patch.object(setup.sys, "base_prefix", "/fixture/system"), patch.object(setup, "_invoke") as invoke:
            with self.assertRaisesRegex(setup.SetupError, "virtual environment"):
                setup.setup()
        invoke.assert_not_called()

    def test_existing_invalid_target_is_preserved(self):
        target = self.root / "existing"
        target.mkdir()
        marker = target / "keep.txt"
        marker.write_text("unchanged")
        with patch.object(setup, "_node", return_value=NODE), patch.object(setup, "doctor", return_value={"ok": False}), patch.object(setup, "_invoke") as invoke:
            with self.assertRaisesRegex(setup.SetupError, "existing files were preserved"):
                setup.setup(target)
        self.assertEqual(marker.read_text(), "unchanged")
        invoke.assert_not_called()

    def test_install_failure_removes_only_owned_staging_directory(self):
        target = self.root / "new-runtime"
        marker = self.root / "keep.txt"
        marker.write_text("unchanged")
        with patch.object(setup, "_node", return_value=NODE), patch.object(setup.shutil, "which", return_value="/fixture/npm"), patch.object(setup, "_invoke", side_effect=setup.SetupError("Fixture install failed")):
            with self.assertRaisesRegex(setup.SetupError, "Fixture install failed"):
                setup.setup(target)
        self.assertFalse(target.exists())
        self.assertEqual(list(self.root.iterdir()), [marker])

    def test_explicit_setup_stages_pinned_install_then_validates_idempotent_repeat(self):
        target = self.root / "runtime with spaces"
        archive = fixture_archive(self.root)
        installs = []

        def command(arguments, **kwargs):
            if arguments[0] == "/fixture/npm":
                installs.append(arguments)
                staging = Path(arguments[arguments.index("--prefix") + 1])
                self.assertNotEqual(staging, target)
                self.assertEqual(staging.parent, target.parent)
                fixture_runtime(staging)
                return ""
            return READY

        with patch.object(setup, "_node", return_value=NODE), patch.object(setup.shutil, "which", return_value="/fixture/npm"), patch.object(setup, "_invoke", side_effect=command):
            installed = setup.setup(target, archive)
            again = setup.setup(target, archive)
        self.assertEqual(installed["status"], "installed")
        self.assertEqual(again["status"], "already-installed")
        self.assertFalse(again["networkRequested"])
        self.assertEqual(len(installs), 1)
        for flag in ("--ignore-scripts", "--no-audit", "--no-fund", "--save-exact"):
            self.assertIn(flag, installs[0])
        for name, version in PACKAGE_VERSIONS.items():
            if name != "footprintjs-ml":
                self.assertIn(f"{name}@{version}", installs[0])
        self.assertIn(str(archive), installs[0])
        self.assertEqual(len(installed["archiveSha256"]), 64)
        self.assertFalse(any(path.name.startswith(".runtime with spaces.setup-") for path in self.root.iterdir()))

    def test_wrong_local_archive_is_rejected_before_install(self):
        archive = fixture_archive(self.root, "0.0.0")
        with patch.object(setup, "_node", return_value=NODE), patch.object(setup.shutil, "which", return_value="/fixture/npm"), patch.object(setup, "_invoke") as invoke:
            with self.assertRaisesRegex(setup.SetupError, "archive must contain"):
                setup.setup(self.root / "runtime", archive)
        invoke.assert_not_called()
        self.assertFalse((self.root / "runtime").exists())

    def test_runtime_selection_is_explicit_and_missing_runtime_start_is_actionable(self):
        with patch("footprint_ml_workflow.subprocess.Popen") as process:
            capture = WorkflowCapture(self.root / "recording.json", runtime_dir=self.root / "missing")
            process.assert_not_called()
            with self.assertRaisesRegex(CaptureError, "footprint_ml_workflow setup"):
                capture.start()
            process.assert_not_called()
        with self.assertRaisesRegex(ValueError, "mutually exclusive"):
            WorkflowCapture(self.root / "recording.json", command=["node", "worker.js"], runtime_dir=self.root)
        target = self.root / "wrong-native-version"
        fixture_runtime(target)
        (target / "node_modules" / "foottrace" / "package.json").write_text(json.dumps({"name": "foottrace", "version": "0.0.0"}))
        with patch("footprint_ml_workflow.subprocess.Popen") as process:
            capture = WorkflowCapture(self.root / "recording.json", runtime_dir=target)
            with self.assertRaisesRegex(CaptureError, "foottrace@1.8.0"):
                capture.start()
            process.assert_not_called()

    def test_command_timeout_and_output_limits_are_enforced(self):
        with self.assertRaisesRegex(setup.SetupError, "timed out"):
            setup._invoke([sys.executable, "-I", "-S", "-c", "import time;time.sleep(10)"], timeout=0.05)
        with self.assertRaisesRegex(setup.SetupError, "output exceeded"):
            setup._invoke([sys.executable, "-I", "-S", "-c", f"import sys;sys.stdout.write('x'*{setup.MAX_COMMAND_BYTES+4096});sys.stdout.flush()"], timeout=5)

    def test_successful_example_stderr_is_forwarded_without_contaminating_stdout(self):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            result = setup._invoke([sys.executable, "-I", "-S", "-c", "import sys;print('json-result');print('numerical warning',file=sys.stderr)"], forward_stderr=True)
        self.assertEqual(result, "json-result")
        self.assertEqual(out.getvalue(), "")
        self.assertIn("numerical warning", err.getvalue())

    def test_promotion_launcher_uses_the_selected_installed_example_and_active_interpreter(self):
        runtime = self.root / "selected runtime with spaces"
        script = runtime / "node_modules" / "footprintjs-ml" / "examples" / "mlflow-promotion" / "run.py"
        script.parent.mkdir(parents=True)
        script.write_text("import json,sys; print(json.dumps({'entry':__file__,'python':sys.executable,'args':sys.argv[1:]}))")
        output = io.StringIO()
        destination = self.root / "new proof"
        with redirect_stdout(output), patch.object(setup, "_ready", return_value=(runtime, {})):
            code = setup.main(["example-promotion", "--out", str(destination), "--runtime-dir", str(runtime)])
        self.assertEqual(code, 0)
        report = json.loads(output.getvalue())
        self.assertEqual(report["exampleResult"]["entry"], str(script))
        self.assertEqual(Path(report["exampleResult"]["python"]).resolve(), Path(sys.executable).resolve())
        self.assertEqual(report["exampleResult"]["args"], ["--out", str(destination), "--runtime-dir", str(runtime)])
        self.assertFalse(destination.exists(), "The launcher must not create or replace the example's output itself")

    def test_cli_uses_json_failures_and_does_not_install_on_doctor(self):
        output = io.StringIO()
        with redirect_stdout(output), patch.object(setup, "doctor", return_value={"schema": "footprint-ml-python-doctor/v1", "ok": False}), patch.object(setup, "setup") as install:
            code = setup.main(["doctor", "--runtime-dir", str(self.root)])
        self.assertEqual(code, 1)
        self.assertFalse(json.loads(output.getvalue())["ok"])
        install.assert_not_called()
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(setup.main(["unknown"]), 1)
        self.assertEqual(json.loads(output.getvalue())["schema"], "footprint-ml-python-command-error/v1")


if __name__ == "__main__":
    unittest.main()
