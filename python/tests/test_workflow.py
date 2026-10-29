"""Dependency/lifecycle tests for the stdlib Python capture facade.

The injected client and protocol fixtures are intentionally fake. The optional
native test exercises the shipped worker. Neither validates MLflow numerics.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

PYTHON_ROOT = Path(__file__).resolve().parent.parent
PACKAGE_ROOT = PYTHON_ROOT.parent
sys.path.insert(0, str(PYTHON_ROOT))
from footprint_ml_workflow import CaptureError, MlflowArtifacts, WorkflowCapture


class FakeClient:
    def __init__(self, content: bytes = b'{"weights":[1,2]}'):
        self.content = content
        self.calls = []

    def get_run(self, run_id):
        self.calls.append(("get_run", run_id))
        return SimpleNamespace(info=SimpleNamespace(run_id=run_id, experiment_id="experiment-7"))

    def download_artifacts(self, run_id, artifact_path, dst_path):
        self.calls.append(("download_artifacts", run_id, artifact_path))
        output = Path(dst_path) / artifact_path
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(self.content)
        return str(output)

    def log_artifact(self, run_id, path):
        self.calls.append(("log_artifact", run_id, path))


class WorkflowDependencyTests(unittest.TestCase):
    def test_standalone_import_and_artifact_binding_under_isolated_stdlib_python(self):
        script = textwrap.dedent('''
            import sys, tempfile
            from pathlib import Path
            from types import SimpleNamespace
            class BlockOptional:
                def find_spec(self, fullname, path=None, target=None):
                    if fullname.split('.')[0] in {'numpy','mlflow','sklearn','jax','torch','footprint_ml_adapter'}:
                        raise AssertionError('Unexpected optional import: ' + fullname)
            sys.meta_path.insert(0, BlockOptional())
            sys.path.insert(0, sys.argv[1])
            import footprint_ml_workflow as api
            class Client:
                def get_run(self, run_id):
                    return SimpleNamespace(info=SimpleNamespace(run_id=run_id, experiment_id='3'))
                def download_artifacts(self, run_id, artifact_path, dst_path):
                    file = Path(dst_path) / 'safe.json'; file.write_bytes(b'{}'); return str(file)
            with tempfile.TemporaryDirectory() as directory:
                binding = api.MlflowArtifacts(Client(), directory)
                ref = binding.bind_artifact('run-1', 'safe.json')
                assert binding.read_bytes(ref) == b'{}'
                capture = api.WorkflowCapture(Path(directory) / 'recording.json')
                assert capture.run_id is None and capture._process is None
                capture.close()
            assert not any(name.split('.')[0] in {'numpy','mlflow','sklearn','jax','torch','footprint_ml_adapter'} for name in sys.modules)
        ''')
        result = subprocess.run([sys.executable, "-I", "-S", "-c", script, str(PYTHON_ROOT)],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_construction_is_lazy_and_a_string_is_not_a_shell_command(self):
        with patch("subprocess.Popen", side_effect=AssertionError("Unexpected process")):
            capture = WorkflowCapture("recording.json")
            capture.close()
            with self.assertRaises(ValueError):
                WorkflowCapture("recording.json", command="node worker.js")
            with self.assertRaises(ValueError):
                WorkflowCapture("recording.json", timeout=float("nan"))


class ArtifactBindingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.client = FakeClient()
        self.artifacts = MlflowArtifacts(self.client, self.root / "cache")

    def test_identity_is_measured_from_downloaded_regular_file_and_upload_is_explicit(self):
        self.assertEqual(self.client.calls, [])
        ref = self.artifacts.bind_artifact("run-7", "models/state.json", format="json-state/v1")
        self.assertEqual(ref["experimentId"], "experiment-7")
        self.assertEqual(ref["artifact"]["path"], "runs:/run-7/models/state.json")
        self.assertEqual(ref["artifact"]["sha256"], hashlib.sha256(self.client.content).hexdigest())
        self.assertEqual(ref["artifact"]["bytes"], len(self.client.content))
        self.assertEqual(self.artifacts.read_bytes(ref), self.client.content)
        reordered = json.loads(json.dumps(ref, sort_keys=True))
        self.assertEqual(self.artifacts.read_bytes(reordered), self.client.content)
        self.assertFalse(any(call[0] == "log_artifact" for call in self.client.calls))
        recording = self.root / "recording.json"
        recording.write_text("{}")
        self.artifacts.log_recording("run-7", recording)
        self.assertEqual(self.client.calls[-1][0], "log_artifact")

    def test_changed_cached_bytes_and_forged_references_are_refused(self):
        ref = self.artifacts.bind_artifact("run-7", "model.json")
        path = self.artifacts.local_path(ref)
        path.write_bytes(b"modified")
        with self.assertRaisesRegex(ValueError, "bytes changed"):
            self.artifacts.read_bytes(ref)
        forged = json.loads(json.dumps(ref))
        forged["artifact"]["sha256"] = hashlib.sha256(b"modified").hexdigest()
        with self.assertRaisesRegex(ValueError, "not bound"):
            self.artifacts.read_bytes(forged)

    def test_invalid_paths_are_refused_before_download(self):
        for path in ("../state", "/state", "a/../state", "a//state", "a\\state", "./state"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.artifacts.bind_artifact("run-7", path)
        self.assertEqual(self.client.calls, [])

    def test_client_cannot_bind_a_directory_symlink_or_file_outside_its_download(self):
        outside = self.root / "outside.json"
        outside.write_bytes(b"{}")
        for mode in ("directory", "outside", "symlink"):
            client = FakeClient()
            def download(run_id, artifact_path, dst_path, mode=mode):
                if mode == "directory":
                    return dst_path
                if mode == "outside":
                    return str(outside)
                link = Path(dst_path) / "link.json"
                link.symlink_to(outside)
                return str(link)
            client.download_artifacts = download
            artifacts = MlflowArtifacts(client, self.root / mode)
            with self.subTest(mode=mode), self.assertRaises((ValueError, OSError)):
                artifacts.bind_artifact("run-7", "model.json")

    def test_wrong_returned_run_id_is_refused(self):
        self.client.get_run = lambda _: SimpleNamespace(info=SimpleNamespace(run_id="another-run", experiment_id="1"))
        with self.assertRaisesRegex(ValueError, "inconsistent run"):
            self.artifacts.bind_artifact("run-7", "model.json")


class ProtocolFailureTests(unittest.TestCase):
    def capture_with(self, program, *, timeout=0.3):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        worker = Path(directory.name) / "fixture.py"
        worker.write_text(program)
        return WorkflowCapture(Path(directory.name) / "recording.json",
                               command=[sys.executable, "-u", str(worker)], timeout=timeout)

    def test_protocol_timeout_terminates_worker_and_cannot_restart(self):
        capture = self.capture_with("import time; time.sleep(30)")
        started = time.monotonic()
        with self.assertRaisesRegex(CaptureError, "timed out"):
            capture.start()
        self.assertLess(time.monotonic() - started, 3)
        self.assertIsNotNone(capture._process.poll())
        with self.assertRaisesRegex(CaptureError, "cannot be restarted"):
            capture.start()

    def test_corrupt_and_uncorrelated_responses_terminate_worker(self):
        programs = ["print('not JSON', flush=True)",
                    "import json,sys; json.loads(sys.stdin.readline()); print(json.dumps({'id':99,'ok':True,'result':{}}),flush=True)",
                    "print('{\"id\":1,\"id\":1,\"ok\":true,\"result\":{}}',flush=True)"]
        for program in programs:
            capture = self.capture_with(program)
            with self.subTest(program=program), self.assertRaises(CaptureError):
                capture.start()
            self.assertIsNotNone(capture._process.poll())

    def test_timeout_also_bounds_a_write_to_a_worker_that_stops_reading(self):
        capture = self.capture_with("import json,sys,time; request=json.loads(sys.stdin.readline()); "
                                    "print(json.dumps({'id':request['id'],'ok':True,'result':{'runId':'fixture'}}),flush=True); time.sleep(30)")
        capture.start()
        started = time.monotonic()
        with self.assertRaisesRegex(CaptureError, "timed out"):
            capture.check_release({"large": "x" * 200_000})
        self.assertLess(time.monotonic() - started, 3)
        self.assertIsNotNone(capture._process.poll())


class NativeWorkerTests(unittest.TestCase):
    def test_native_capture_commits_reads_discards_failure_and_closes_recording(self):
        worker = PACKAGE_ROOT / "dist" / "adapter" / "capture-worker.js"
        if not worker.is_file() or shutil.which("node") is None:
            self.skipTest("Build the optional Node capture worker to exercise native RPC")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "recording.json"
            with WorkflowCapture(output) as capture:
                with capture.stage("inputs") as scope:
                    scope["value"] = 7
                    scope["nullable"] = None
                    self.assertEqual(scope.get("missing", "fallback"), "fallback")
                    self.assertIsNone(scope["nullable"])
                    with self.assertRaises(KeyError):
                        _ = scope["missing"]
                    with self.assertRaises((ValueError, TypeError)):
                        scope["bad"] = float("nan")
                failed = None
                with self.assertRaisesRegex(RuntimeError, "application failed"):
                    with capture.stage("attempt", attempt=1) as scope:
                        failed = scope.runtime_stage_id
                        scope["uncommitted"] = "must be discarded"
                        raise RuntimeError("application failed" + "\x00" * 10_000)
                with capture.stage("attempt", attempt=2, retry_of=failed) as scope:
                    scope["result"] = scope["value"] + 1
                snapshot = capture.snapshot()
                self.assertEqual(snapshot["snapshot"]["sharedState"]["result"], 8)
                self.assertNotIn("uncommitted", snapshot["snapshot"]["sharedState"])
            recording = json.loads(output.read_text())
            self.assertEqual(recording["schema"], "footprint-ml-python-capture/v1")
            self.assertEqual(recording["snapshot"]["sharedState"]["result"], 8)
            discarded = [stage for stage in recording["supplemental"]["pythonCapture"]["stages"]
                         if stage["status"] == "discarded"]
            self.assertEqual(len(discarded), 1)
            self.assertLess(len(json.dumps(discarded[0]["error"]).encode()), 4096)
            with self.assertRaises(CaptureError):
                _ = scope["value"]


if __name__ == "__main__":
    unittest.main()
