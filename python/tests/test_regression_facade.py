"""Regression facade lifecycle/JSON tests; the guard is implemented in TypeScript."""
from pathlib import Path
import json
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

PYTHON_ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(PYTHON_ROOT))
from footprint_ml_workflow import CaptureError,WorkflowCapture

METHODS=('read_regression_manifest','create_regression_receipt','read_regression_receipt','check_regression')


class RegressionFacadeLifecycleTests(unittest.TestCase):
    def test_regression_methods_do_not_start_or_restart_capture_implicitly(self):
        with patch('subprocess.Popen',side_effect=AssertionError('Unexpected process')):
            capture=WorkflowCapture('recording.json')
            for name in METHODS:
                with self.subTest(method=name),self.assertRaisesRegex(CaptureError,'Start the capture explicitly'):
                    getattr(capture,name)({})
            capture.close()
            for name in METHODS:
                with self.subTest(closed_method=name),self.assertRaises(CaptureError):getattr(capture,name)({})
            self.assertIsNone(capture._process)


class NativeRegressionFacadeTests(unittest.TestCase):
    def setUp(self):
        worker=PYTHON_ROOT.parent/'dist'/'adapter'/'capture-worker.js'
        if not worker.is_file() or shutil.which('node') is None:self.skipTest('Build the native capture worker for RPC tests')
        directory=tempfile.TemporaryDirectory();self.addCleanup(directory.cleanup)
        self.path=Path(directory.name)/'recording.json'
        self.capture=WorkflowCapture(self.path,command=['node',str(worker)])
        self.capture.start();self.addCleanup(self.capture.close)

    def test_missing_evidence_is_unknown_while_readers_reject_malformed_json_contracts(self):
        decision=self.capture.check_regression({})
        self.assertFalse(decision['allowed']);self.assertEqual(decision['status'],'unknown')
        for name in METHODS[:-1]:
            with self.subTest(method=name),self.assertRaises(CaptureError):getattr(self.capture,name)({})
        self.assertEqual(self.capture.snapshot()['snapshot']['commitLog'],[])

    def test_nonfinite_and_oversized_inputs_never_reach_the_node_guard(self):
        for name in METHODS:
            for value in ({'invalid':float('nan')},{'invalid':'x'*1_048_576}):
                with self.subTest(method=name),self.assertRaises(ValueError):getattr(self.capture,name)(value)
        self.assertEqual(self.capture.snapshot()['snapshot']['sharedState'],{})
        self.assertEqual(self.capture.snapshot()['snapshot']['commitLog'],[])

    def test_failed_contract_discards_only_its_active_stage_and_guard_calls_add_no_implicit_edges(self):
        with self.capture.stage('seed') as scope:scope['modelReference']={'id':'already-recorded'}
        with self.assertRaises(CaptureError):
            with self.capture.stage('invalid-contract') as scope:
                _=scope['modelReference'];scope['temporary']='must-discard'
                self.capture.read_regression_manifest({})
        with self.capture.stage('missing-coverage') as scope:
            _=scope['modelReference'];scope['regressionDecision']=self.capture.check_regression({})
        self.capture.close()
        record=json.loads(self.path.read_text())
        self.assertEqual(len(record['snapshot']['commitLog']),2)
        self.assertNotIn('temporary',record['snapshot']['sharedState'])
        self.assertEqual(record['snapshot']['sharedState']['regressionDecision']['status'],'unknown')
        self.assertEqual([stage['status'] for stage in record['supplemental']['pythonCapture']['stages']],
                         ['committed','discarded','committed'])


if __name__=='__main__':unittest.main()
