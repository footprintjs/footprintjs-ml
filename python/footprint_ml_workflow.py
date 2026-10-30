"""Optional Python workflow capture and MLflow artifact binding, using stdlib only.

Importing this module starts no process and imports no numerical or MLflow package.
Capture explicitly starts the shipped Node bridge to the native foottrace writer
and existing ML contracts. Python application code controls its work and retries.
"""
from __future__ import annotations

from collections import deque
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import queue
import re
import stat
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Iterator

from footprint_ml_versions import SDK_VERSION, PYTHON_VERSION, FOOTTRACE_VERSION

__version__ = PYTHON_VERSION

MAX_REQUEST_BYTES = 1_048_576
MAX_VALUE_BYTES = 65_536
MAX_RESPONSE_BYTES = 16_777_216
MAX_SAFE_INTEGER = 2**53 - 1


class CaptureError(RuntimeError):
    """A bridge, protocol or lifecycle failure with an optional native code."""

    def __init__(self, message: str, *, code: str | None = None):
        super().__init__(message)
        self.code = code


def _json_bytes(value: Any, *, limit: int = MAX_REQUEST_BYTES) -> bytes:
    def check(item: Any, depth: int = 0) -> None:
        if depth > 128:
            raise ValueError("JSON nesting exceeds 128 levels")
        if item is None or type(item) in (str, bool):
            return
        if type(item) is int:
            if abs(item) > MAX_SAFE_INTEGER:
                raise ValueError("JSON integers must be exactly representable in JavaScript")
            return
        if type(item) is float:
            if not math.isfinite(item):
                raise ValueError("JSON numbers must be finite")
            return
        if type(item) is list:
            for child in item:
                check(child, depth + 1)
            return
        if type(item) is dict and all(type(key) is str for key in item):
            for child in item.values():
                check(child, depth + 1)
            return
        raise TypeError("Capture values must contain only plain JSON data")

    check(value)
    encoded = json.dumps(value, ensure_ascii=False, allow_nan=False,
                         separators=(",", ":")).encode("utf-8")
    if len(encoded) > limit:
        raise ValueError(f"JSON exceeds the {limit}-byte limit")
    return encoded


def _text(value: Any, name: str, *, limit: int = 4096) -> str:
    if type(value) is not str or not value.strip() or len(value) > limit or "\x00" in value:
        raise ValueError(f"{name} must be a nonempty string of at most {limit} characters")
    return value


def _object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON response key")
        result[key] = value
    return result


def _bad_constant(value: str) -> None:
    raise ValueError(f"Nonfinite JSON response: {value}")


def _stage_error(kind: Any, error: Any) -> dict[str, str]:
    safe_text = lambda value: value.encode("utf-8", errors="replace").decode("utf-8")
    payload = {"type": safe_text(kind.__name__[:128]), "message": safe_text(str(error)[:8192])}
    while True:
        try:
            _json_bytes(payload, limit=4096)
            return payload
        except ValueError:
            payload["message"] = payload["message"][:len(payload["message"]) // 2]


class _Scope:
    def __init__(self, capture: "WorkflowCapture", identity: dict[str, Any]):
        self._capture = capture
        self.runtime_stage_id = identity["runtimeStageId"]
        self.stage_id = identity["stageId"]

    def _read(self, key: str) -> dict[str, Any]:
        self._capture._assert_scope(self)
        result = self._capture._rpc("get", key=_text(key, "scope key", limit=1024))
        if type(result) is not dict or type(result.get("present")) is not bool:
            self._capture._protocol_error("Invalid scope-read response")
        if result["present"] and "value" not in result:
            self._capture._protocol_error("Scope-read response omitted its value")
        return result

    def __getitem__(self, key: str) -> Any:
        result = self._read(key)
        if not result["present"]:
            raise KeyError(key)
        return result["value"]

    def get(self, key: str, default: Any = None) -> Any:
        result = self._read(key)
        return result["value"] if result["present"] else default

    def __setitem__(self, key: str, value: Any) -> None:
        self._capture._assert_scope(self)
        _json_bytes(value, limit=MAX_VALUE_BYTES)
        self._capture._rpc("set", key=_text(key, "scope key", limit=1024), value=value)

    def set(self, key: str, value: Any) -> None:
        self[key] = value


class _Stage:
    def __init__(self, capture: "WorkflowCapture", arguments: dict[str, Any]):
        self._capture = capture
        self._arguments = arguments
        self._scope: _Scope | None = None

    def __enter__(self) -> _Scope:
        self._capture._require_started()
        if self._capture._active_scope is not None:
            raise CaptureError("Nested stages are not supported")
        identity = self._capture._rpc("begin", **self._arguments)
        if (type(identity) is not dict or type(identity.get("runtimeStageId")) is not str
                or type(identity.get("stageId")) is not str):
            self._capture._protocol_error("Invalid stage identity response")
        self._scope = _Scope(self._capture, identity)
        self._capture._active_scope = self._scope
        return self._scope

    def __exit__(self, kind: Any, error: Any, traceback: Any) -> bool:
        try:
            if kind is None:
                self._capture._rpc("commit")
            else:
                self._capture._rpc("discard", error=_stage_error(kind, error))
        except Exception as failure:
            self._capture._abort()
            if error is None:
                raise
            error.add_note(f"Capture could not discard the failed stage: {failure}")
        finally:
            self._capture._active_scope = None
        return False


class WorkflowCapture:
    """Synchronous, explicitly started capture bridge for one Python thread.

    Values are finite, plain JSON (64 KiB per value). Model arrays stay in the
    application. The optional worker comes from the SDK source layout or an
    explicitly installed virtual-environment runtime. Import and construction
    install nothing and launch nothing. There is no automatic retry or restart.
    """

    def __init__(self, recording_path: str | os.PathLike[str], command: list[str] | None = None,
                 timeout: float = 10, *, initial_state: dict[str, Any] | None = None,
                 runtime_dir: str | os.PathLike[str] | None = None):
        self.recording_path = Path(recording_path).expanduser().absolute()
        if type(timeout) not in (float, int) or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be positive and finite")
        self.timeout = float(timeout)
        if command is not None and runtime_dir is not None:
            raise ValueError("command and runtime_dir are mutually exclusive")
        source_worker = Path(__file__).resolve().parent.parent / "dist" / "adapter" / "capture-worker.js"
        self.runtime_dir = (Path(runtime_dir).expanduser().absolute() if runtime_dir is not None else
                            None if source_worker.is_file() else Path(sys.prefix) / "share" / "footprintjs-ml" / SDK_VERSION)
        default_worker = (source_worker if self.runtime_dir is None else
                          self.runtime_dir / "node_modules" / "footprintjs-ml" / "dist" / "adapter" / "capture-worker.js")
        self._default_worker = default_worker if command is None else None
        self.command = ["node", str(default_worker)] if command is None else list(command)
        if isinstance(command, (str, bytes)) or not self.command or any(type(x) is not str or not x for x in self.command):
            raise ValueError("command must be a nonempty argument list")
        if initial_state is not None and type(initial_state) is not dict:
            raise TypeError("initial_state must be a plain JSON object")
        self._initial_state = json.loads(_json_bytes(initial_state)) if initial_state is not None else None
        self._process: subprocess.Popen[bytes] | None = None
        self._responses: queue.Queue[Any] = queue.Queue(maxsize=2)
        self._stderr: deque[bytes] = deque(maxlen=4)
        self._request_id = 0
        self._owner: int | None = None
        self._active_scope: _Scope | None = None
        self._closed = False
        self._callback_active = False
        self._last_callback_id = 0
        self.run_id: str | None = None

    def __enter__(self) -> "WorkflowCapture":
        return self.start()

    def __exit__(self, kind: Any, error: Any, traceback: Any) -> bool:
        try:
            self.close()
        except Exception as failure:
            if error is None:
                raise
            error.add_note(f"Capture could not close: {failure}")
        return False

    def start(self) -> "WorkflowCapture":
        if self._closed:
            raise CaptureError("A closed capture cannot be restarted")
        if self._process is not None:
            self._require_started()
            return self
        if self._default_worker is not None:
            if not self._default_worker.is_file():
                raise CaptureError("The optional native capture runtime is not installed. Run "
                                   "`python -m footprint_ml_workflow setup` in this virtual environment, "
                                   "or select an installed runtime_dir / explicit command.", code="runtime-missing")
            if self.runtime_dir is not None:
                for name, version in (("footprintjs-ml", SDK_VERSION), ("foottrace", FOOTTRACE_VERSION)):
                    metadata = self.runtime_dir / "node_modules" / name / "package.json"
                    try:
                        installed = json.loads(metadata.read_text("utf-8"))
                        if type(installed) is not dict or installed.get("name") != name or installed.get("version") != version:
                            raise ValueError("Runtime package version mismatch")
                    except (OSError, ValueError) as error:
                        raise CaptureError(f"The capture runtime must contain {name}@{version}. "
                                           "Run `python -m footprint_ml_workflow doctor` with the selected --runtime-dir.",
                                           code="runtime-version") from error
        self._owner = threading.get_ident()
        try:
            self._process = subprocess.Popen(self.command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                             stderr=subprocess.PIPE)
            threading.Thread(target=self._read_responses, daemon=True).start()
            threading.Thread(target=self._read_stderr, daemon=True).start()
            arguments: dict[str, Any] = {"path": str(self.recording_path)}
            if self._initial_state is not None:
                arguments["initialState"] = self._initial_state
            result = self._rpc("open", **arguments)
            if type(result) is not dict or type(result.get("runId")) is not str:
                self._protocol_error("Invalid open response")
            self.run_id = result["runId"]
            return self
        except Exception:
            self._abort()
            raise

    def _read_responses(self) -> None:
        assert self._process is not None and self._process.stdout is not None
        try:
            while True:
                line = self._process.stdout.readline(MAX_RESPONSE_BYTES + 2)
                if not line:
                    raise EOFError("Capture worker closed stdout")
                if len(line) > MAX_RESPONSE_BYTES or not line.endswith(b"\n"):
                    raise ValueError("Capture response is oversized or is not a complete JSON line")
                response = json.loads(line.decode("utf-8"), object_pairs_hook=_object_pairs,
                                      parse_constant=_bad_constant)
                _json_bytes(response, limit=MAX_RESPONSE_BYTES)
                self._responses.put(response)
        except Exception as error:
            self._responses.put(error)

    def _read_stderr(self) -> None:
        assert self._process is not None and self._process.stderr is not None
        try:
            while True:
                chunk = self._process.stderr.read(4096)
                if not chunk:
                    return
                self._stderr.append(chunk)
        except (OSError, ValueError):
            return

    def _require_started(self) -> None:
        if self._callback_active:
            raise CaptureError("Capture and scope operations are forbidden inside release callbacks", code="capture-callback-reentry")
        if self._closed or self._process is None:
            raise CaptureError("Start the capture explicitly, or use it as a context manager")
        if self._owner != threading.get_ident():
            raise CaptureError("A capture must be used from the thread that started it")

    def _assert_scope(self, scope: _Scope) -> None:
        self._require_started()
        if self._active_scope is not scope:
            raise CaptureError("This scope belongs to a stage that is no longer active")

    def _protocol_error(self, message: str) -> Any:
        self._abort()
        raise CaptureError(message, code="capture-protocol-error")

    def _rpc(self, operation: str, *, _callbacks: dict[str, Any] | None = None, **arguments: Any) -> Any:
        self._require_started()
        self._request_id += 1
        request_id = self._request_id
        encoded = _json_bytes({"id": request_id, "op": operation, **arguments}) + b"\n"
        assert self._process is not None and self._process.stdin is not None
        deadline = time.monotonic() + self.timeout
        pipe = self._process.stdin

        def send(packet: bytes) -> None:
            written: queue.Queue[Any] = queue.Queue(maxsize=1)
            def write_request() -> None:
                try:
                    pipe.write(packet)
                    pipe.flush()
                    written.put(None)
                except (BrokenPipeError, OSError, ValueError) as error:
                    written.put(error)
            threading.Thread(target=write_request, daemon=True).start()
            write_error = written.get(timeout=max(0, deadline - time.monotonic()))
            if write_error is not None:
                self._protocol_error(f"Capture worker input failed during {operation}: {write_error}")

        try:
            send(encoded)
            while True:
                response = self._responses.get(timeout=max(0, deadline - time.monotonic()))
                if not (type(response) is dict and response.get("type") == "callback"):
                    break
                if (set(response) != {"type", "id", "callId", "method", "input"}
                        or type(response["id"]) is not int or response["id"] != request_id
                        or type(response["callId"]) is not int
                        or not self._last_callback_id < response["callId"] <= MAX_SAFE_INTEGER
                        or type(response["method"]) is not str or response["method"] not in (_callbacks or {})
                        or type(response["input"]) is not dict):
                    self._protocol_error("Release callback did not match its active request")
                try:
                    _json_bytes(response)
                except (TypeError, ValueError):
                    self._protocol_error("Release callback exceeded its JSON contract")
                self._last_callback_id = response["callId"]
                completed: queue.Queue[Any] = queue.Queue(maxsize=1)
                callback = (_callbacks or {})[response["method"]]
                callback_input = response["input"]
                def invoke() -> None:
                    try:
                        completed.put((True, callback(callback_input)))
                    except Exception as error:
                        completed.put((False, error))
                self._callback_active = True
                try:
                    threading.Thread(target=invoke, daemon=True).start()
                    ok, result = completed.get(timeout=max(0, deadline - time.monotonic()))
                finally:
                    self._callback_active = False
                reply = {"op": "callback_result", "id": request_id, "callId": response["callId"], "ok": ok}
                if ok:
                    try:
                        _json_bytes(result)
                        reply["result"] = result
                    except (TypeError, ValueError) as error:
                        ok, result = False, error
                        reply["ok"] = False
                if not ok:
                    details = _stage_error(type(result), result)
                    code = getattr(result, "code", None)
                    reply["error"] = {"code": code if type(code) is str and 0 < len(code) <= 128 else "python-callback-error",
                                      "message": details["message"]}
                send(_json_bytes(reply) + b"\n")
        except queue.Empty:
            self._abort()
            raise CaptureError(f"Capture worker timed out during {operation}", code="capture-timeout") from None
        except (BrokenPipeError, OSError, ValueError) as error:
            self._protocol_error(f"Capture worker input failed during {operation}: {error}")
        if isinstance(response, BaseException):
            detail = b"".join(self._stderr).decode("utf-8", errors="replace")[-4096:]
            self._protocol_error(f"Capture worker response failed: {response}" + (f"; {detail}" if detail else ""))
        if (type(response) is not dict or type(response.get("id")) is not int
                or response["id"] != request_id or type(response.get("ok")) is not bool):
            self._protocol_error("Capture response did not match its request")
        if not response["ok"]:
            error = response.get("error")
            if type(error) is not dict or type(error.get("message")) is not str:
                self._protocol_error("Capture response omitted its error details")
            raise CaptureError(error["message"], code=error.get("code"))
        if "result" not in response:
            self._protocol_error("Capture response omitted its result")
        return response["result"]

    def stage(self, stage_id: str, name: str | None = None, attempt: int | None = None,
              retry_of: str | None = None) -> _Stage:
        arguments: dict[str, Any] = {"stageId": _text(stage_id, "stage_id", limit=512)}
        if name is not None:
            arguments["name"] = _text(name, "name", limit=1024)
        if attempt is not None:
            if type(attempt) is not int or not 1 <= attempt <= MAX_SAFE_INTEGER:
                raise ValueError("attempt must be a positive safe integer")
            arguments["attempt"] = attempt
        if retry_of is not None:
            arguments["retryOf"] = _text(retry_of, "retry_of", limit=1024)
        return _Stage(self, arguments)

    def check_release(self, input: dict[str, Any]) -> Any:
        return self._rpc("check_release", input=input)

    def create_evaluation_receipt(self, input: dict[str, Any]) -> Any:
        return self._rpc("create_evaluation_receipt", input=input)

    def read_evaluation_receipt(self, input: dict[str, Any]) -> Any:
        """Validate persisted evaluation evidence through the existing SDK contract."""
        return self._rpc("read_evaluation_receipt", input=input)

    def create_data_lineage_receipt(self, input: dict[str, Any]) -> Any:
        """Snapshot actual backend observations; this does not measure data use."""
        return self._rpc("create_data_lineage_receipt", input=input)

    def read_data_lineage_receipt(self, input: dict[str, Any]) -> Any:
        """Validate persisted lineage evidence through the existing SDK contract."""
        return self._rpc("read_data_lineage_receipt", input=input)

    def check_data_lineage(self, input: dict[str, Any]) -> Any:
        """Compare observations with independently supplied data-use policy."""
        return self._rpc("check_data_lineage", input=input)

    def read_selection_manifest(self, input: dict[str, Any]) -> Any:
        """Validate the application's independently declared candidate comparison."""
        return self._rpc("read_selection_manifest", input=input)

    def create_selection_receipt(self, input: dict[str, Any]) -> Any:
        """Rank a complete declared comparison using the existing SDK contract."""
        return self._rpc("create_selection_receipt", input=input)

    def read_selection_receipt(self, input: dict[str, Any]) -> Any:
        """Validate persisted selection evidence and recompute its stated ranking."""
        return self._rpc("read_selection_receipt", input=input)

    def check_selection(self, input: dict[str, Any]) -> Any:
        """Check offered evidence against independent manifest and observations."""
        return self._rpc("check_selection", input=input)

    def create_prediction_contract(self, input: dict[str, Any]) -> Any:
        """Describe named tabular prediction semantics; no data is inspected."""
        return self._rpc("create_prediction_contract", input=input)

    def read_prediction_contract(self, input: dict[str, Any]) -> Any:
        """Validate a persisted prediction contract through the native SDK."""
        return self._rpc("read_prediction_contract", input=input)

    def create_inference_receipt(self, input: dict[str, Any]) -> Any:
        """Record actual backend observations, including unavailable identity."""
        return self._rpc("create_inference_receipt", input=input)

    def read_inference_receipt(self, input: dict[str, Any]) -> Any:
        """Validate saved prediction observations without repeating inference."""
        return self._rpc("read_inference_receipt", input=input)

    def check_inference(self, input: dict[str, Any]) -> Any:
        """Compare observed prediction use with independent request context."""
        return self._rpc("check_inference", input=input)

    def read_model_release_plan(self, input: dict[str, Any]) -> Any:
        """Validate independently supplied release authority through the core contract."""
        return self._rpc("read_model_release_plan", input=input)

    def put_release_artifact(self, file_path: str | os.PathLike[str], *,
                             store_root: str | os.PathLike[str], format: str) -> Any:
        """Import checked local-file bytes into the native managed release store."""
        return self._rpc("put_release_artifact", filePath=str(Path(file_path).expanduser().absolute()),
                         storeRoot=str(Path(store_root).expanduser().absolute()), format=_text(format, "format"))

    def _checked_release(self, operation: str, input: dict[str, Any], *, store_root: str | os.PathLike[str],
                         verify_model: Any = None, publisher: Any = None) -> Any:
        self._require_started()
        callbacks = {}
        if verify_model is not None:
            if not callable(verify_model):
                raise TypeError("verify_model must be callable")
            callbacks["verify_model"] = verify_model
        if operation == "prepare_model_release" and verify_model is None:
            raise TypeError("prepare_model_release requires verify_model")
        lookup = None
        if operation != "prepare_model_release":
            publish = getattr(publisher, "publish", None)
            lookup = getattr(publisher, "lookup", None)
            if not callable(publish) or (lookup is not None and not callable(lookup)):
                raise TypeError("publisher must provide publish(request) and an optional callable lookup(request)")
            callbacks["publisher.publish"] = publish
            if lookup is not None:
                callbacks["publisher.lookup"] = lookup
        return self._rpc(operation, _callbacks=callbacks, input=input,
                         storeRoot=str(Path(store_root).expanduser().absolute()),
                         verifyModel=verify_model is not None, publisherLookup=lookup is not None)

    def prepare_model_release(self, input: dict[str, Any], *, store_root: str | os.PathLike[str],
                              verify_model: Any) -> Any:
        return self._checked_release("prepare_model_release", input, store_root=store_root, verify_model=verify_model)

    def publish_model_release(self, input: dict[str, Any], *, store_root: str | os.PathLike[str],
                              publisher: Any, verify_model: Any = None) -> Any:
        return self._checked_release("publish_model_release", input, store_root=store_root,
                                     publisher=publisher, verify_model=verify_model)

    def release_model(self, input: dict[str, Any], *, store_root: str | os.PathLike[str],
                      publisher: Any, verify_model: Any = None) -> Any:
        return self._checked_release("release_model", input, store_root=store_root,
                                     publisher=publisher, verify_model=verify_model)

    def snapshot(self) -> dict[str, Any]:
        return self._rpc("snapshot")

    def close(self) -> Any:
        if self._callback_active:
            raise CaptureError("Capture and scope operations are forbidden inside release callbacks", code="capture-callback-reentry")
        if self._closed:
            return None
        if self._process is None:
            self._closed = True
            return None
        if self._active_scope is not None:
            self._abort()
            raise CaptureError("Exit the active stage before closing capture")
        try:
            result = self._rpc("close")
            self._process.wait(timeout=self.timeout)
            if self._process.returncode != 0:
                raise CaptureError(f"Capture worker exited with code {self._process.returncode}")
            return result
        except subprocess.TimeoutExpired:
            raise CaptureError("Capture worker did not exit after close", code="capture-timeout") from None
        finally:
            self._abort()

    def _abort(self) -> None:
        process = self._process
        self._closed = True
        self._active_scope = None
        if process is not None:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=1)
            for pipe in (process.stdin, process.stdout, process.stderr):
                if pipe is not None:
                    pipe.close()


def _run_id(value: Any) -> str:
    if type(value) is not str or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,255}", value):
        raise ValueError("run_id must be a simple nonempty MLflow run identifier")
    return value


def _artifact_path(value: Any) -> str:
    _text(value, "artifact_path")
    path = PurePosixPath(value)
    if (path.is_absolute() or "\\" in value or any(ord(c) < 32 for c in value)
            or any(part in (".", "..") for part in value.split("/")) or str(path) != value):
        raise ValueError("artifact_path must be a canonical relative file path")
    return value


def _open_regular(path: Path, root: Path | None = None) -> Any:
    if root is not None:
        try:
            relative = path.relative_to(root)
        except ValueError:
            raise ValueError("Downloaded artifact escaped its cache directory") from None
        if any(part in (".", "..") for part in relative.parts):
            raise ValueError("Downloaded artifact escaped its cache directory")
        cursor = root
        for part in relative.parts:
            cursor = cursor / part
            if cursor.is_symlink():
                raise ValueError("Artifact cache paths cannot contain symlinks")
    if not stat.S_ISREG(os.lstat(path).st_mode):
        raise ValueError("Artifact must be a regular file")
    flags = (os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
             | getattr(os, "O_NONBLOCK", 0))
    descriptor = os.open(path, flags)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError("Artifact must be a regular file")
        return os.fdopen(descriptor, "rb", buffering=0)
    except Exception:
        os.close(descriptor)
        raise


def _checked_chunks(source: Any, expected_bytes: int | None = None,
                    message: str = "Artifact changed while reading") -> Iterator[bytes]:
    before = os.fstat(source.fileno())
    if expected_bytes is not None and before.st_size != expected_bytes:
        raise ValueError(message)
    remaining = before.st_size
    while remaining:
        chunk = source.read(min(1_048_576, remaining))
        if not chunk:
            raise ValueError(message)
        remaining -= len(chunk)
        yield chunk
    if source.read(1):
        raise ValueError(message)
    after = os.fstat(source.fileno())
    if (after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (before.st_size, before.st_mtime_ns, before.st_ctime_ns):
        raise ValueError(message)


class MlflowArtifacts:
    """Explicit artifact operations through an application-supplied MLflow client.

    The client and its authentication are application owned. IDs and hashes bind
    downloaded bytes; tags are never treated as approval or trusted authority.
    """

    def __init__(self, client: Any, cache_dir: str | os.PathLike[str]):
        self.client = client
        self.cache_dir = Path(cache_dir).expanduser().absolute()
        self._bindings: dict[bytes, tuple[Path, Path]] = {}

    @staticmethod
    def _key(reference: dict[str, Any]) -> bytes:
        _json_bytes(reference)
        return json.dumps(reference, sort_keys=True, ensure_ascii=False,
                          allow_nan=False, separators=(",", ":")).encode("utf-8")

    def bind_artifact(self, run_id: str, artifact_path: str,
                      format: str = "application/octet-stream") -> dict[str, Any]:
        run_id = _run_id(run_id)
        artifact_path = _artifact_path(artifact_path)
        _text(format, "format", limit=256)
        run = self.client.get_run(run_id)
        actual_id = run.info.run_id
        experiment_id = _text(run.info.experiment_id, "MLflow experiment ID", limit=256)
        if actual_id != run_id:
            raise ValueError("MLflow returned inconsistent run metadata")
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        cache = Path(tempfile.mkdtemp(prefix="artifact-", dir=self.cache_dir))
        downloaded = Path(self.client.download_artifacts(run_id, artifact_path, dst_path=str(cache))).absolute()
        digest, count = hashlib.sha256(), 0
        with _open_regular(downloaded, cache) as source:
            for chunk in _checked_chunks(source):
                count += len(chunk)
                digest.update(chunk)
        reference = {"kind": "mlflow-artifact", "schemaVersion": 1, "runId": run_id,
                     "experimentId": experiment_id, "artifactPath": artifact_path,
                     "artifact": {"kind": "artifact", "path": f"runs:/{run_id}/{artifact_path}",
                                  "sha256": digest.hexdigest(), "bytes": count, "format": format}}
        self._bindings[self._key(reference)] = (downloaded, cache)
        return reference

    def _bound(self, reference: dict[str, Any]) -> tuple[Path, Path]:
        binding = self._bindings.get(self._key(reference))
        if binding is None:
            raise ValueError("This MLflow reference was not bound by this artifact client")
        return binding

    def read_bytes(self, reference: dict[str, Any]) -> bytes:
        path, cache = self._bound(reference)
        expected = reference["artifact"]
        with _open_regular(path, cache) as source:
            content = b"".join(_checked_chunks(source, expected["bytes"], "Downloaded artifact bytes changed after binding"))
        if len(content) != expected["bytes"] or hashlib.sha256(content).hexdigest() != expected["sha256"]:
            raise ValueError("Downloaded artifact bytes changed after binding")
        return content

    def local_path(self, reference: dict[str, Any]) -> Path:
        """Verify now, then return a path. Prefer read_bytes to consume checked bytes."""
        path, _ = self._bound(reference)
        self.read_bytes(reference)
        return path

    def log_recording(self, run_id: str, path: str | os.PathLike[str]) -> Any:
        """Explicit upload requested by the caller; never invoked by binding/capture."""
        run_id = _run_id(run_id)
        file = Path(path).expanduser().absolute()
        if file.is_symlink():
            raise ValueError("Recording upload requires a regular file")
        with _open_regular(file):
            pass
        return self.client.log_artifact(run_id, str(file))


__all__ = ["WorkflowCapture", "MlflowArtifacts", "CaptureError", "__version__"]


if __name__ == "__main__":
    from footprint_ml_setup import main
    raise SystemExit(main())
