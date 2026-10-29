"""Python facade lifecycle and native error boundaries; algorithms stay in TypeScript.

The cross-language Node test compares complete results with the public SDK.
These tests exercise the Python caller's lifecycle, JSON and stage behavior.
"""
from __future__ import annotations

import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

PYTHON_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PYTHON_ROOT))
from footprint_ml_workflow import CaptureError, WorkflowCapture

METHODS = (
    "read_evaluation_receipt", "create_data_lineage_receipt", "read_data_lineage_receipt",
    "check_data_lineage", "read_selection_manifest", "create_selection_receipt",
    "read_selection_receipt", "check_selection",
)


class MLContractLifecycleTests(unittest.TestCase):
    def test_contract_methods_never_start_a_capture_implicitly(self):
        with patch("subprocess.Popen", side_effect=AssertionError("Unexpected process")):
            capture = WorkflowCapture("recording.json")
            for name in METHODS:
                with self.subTest(method=name), self.assertRaisesRegex(CaptureError, "Start the capture explicitly"):
                    getattr(capture, name)({})
            capture.close()
            for name in METHODS:
                with self.subTest(closed_method=name), self.assertRaises(CaptureError):
                    getattr(capture, name)({})
            self.assertIsNone(capture._process)


class NativeMLContractTests(unittest.TestCase):
    def setUp(self):
        worker = PYTHON_ROOT.parent / "dist" / "adapter" / "capture-worker.js"
        if not worker.is_file() or shutil.which("node") is None:
            self.skipTest("Build the optional Node capture worker to exercise native RPC")
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.output = Path(self.directory.name) / "recording.json"
        self.capture = WorkflowCapture(self.output, command=["node", str(worker)])
        self.capture.start()
        self.addCleanup(self.capture.close)

    def test_native_guards_return_unknown_while_readers_reject_malformed_saved_evidence(self):
        for name in ("check_data_lineage", "check_selection"):
            with self.subTest(guard=name):
                decision = getattr(self.capture, name)({})
                self.assertEqual(decision["status"], "unknown")
                self.assertIs(decision["allowed"], False)
                self.assertTrue(decision["reasons"])
        for name in ("read_evaluation_receipt", "create_data_lineage_receipt", "read_data_lineage_receipt",
                     "read_selection_manifest", "create_selection_receipt", "read_selection_receipt"):
            with self.subTest(reader=name), self.assertRaises(CaptureError) as failure:
                getattr(self.capture, name)({})
            self.assertIsNotNone(failure.exception.code)
        snapshot = self.capture.snapshot()["snapshot"]
        self.assertEqual(snapshot["commitLog"], [])
        self.assertEqual(snapshot["sharedState"], {})

    def test_nonfinite_and_oversized_contract_inputs_never_reach_or_mutate_the_worker(self):
        for name in METHODS:
            for input in ({"invalid": float("nan")}, {"invalid": "x" * 1_048_576}):
                with self.subTest(method=name, invalid=type(input["invalid"]).__name__), self.assertRaises(ValueError):
                    getattr(self.capture, name)(input)
        snapshot = self.capture.snapshot()["snapshot"]
        self.assertEqual(snapshot["commitLog"], [])
        self.assertEqual(snapshot["sharedState"], {})

    def test_native_contract_exception_discards_only_the_active_stage_and_capture_can_continue(self):
        with self.capture.stage("seed") as scope:
            scope["retained"] = {"reference": "already-committed"}
        with self.assertRaises(CaptureError):
            with self.capture.stage("malformed-evidence") as scope:
                _ = scope["retained"]
                scope["uncommitted"] = "must be discarded"
                self.capture.create_data_lineage_receipt({})
        with self.capture.stage("check-missing-evidence") as scope:
            _ = scope["retained"]
            scope["selectionDecision"] = self.capture.check_selection({})
        self.capture.close()
        recording = json.loads(self.output.read_text("utf-8"))
        self.assertEqual(len(recording["snapshot"]["commitLog"]), 2)
        self.assertNotIn("uncommitted", recording["snapshot"]["sharedState"])
        self.assertEqual(recording["snapshot"]["sharedState"]["selectionDecision"]["status"], "unknown")
        attempts = recording["supplemental"]["pythonCapture"]["stages"]
        self.assertEqual([stage["status"] for stage in attempts], ["committed", "discarded", "committed"])
        self.assertEqual(attempts[1]["error"]["type"], "CaptureError")


if __name__ == "__main__":
    unittest.main()
