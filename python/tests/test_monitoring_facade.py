"""Monitoring facade lifecycle/transport tests; monitoring rules stay in TypeScript."""
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

METHODS=('read_monitoring_manifest','create_monitoring_receipt','read_monitoring_receipt','check_monitoring')


class MonitoringFacadeLifecycleTests(unittest.TestCase):
    def test_monitoring_methods_require_explicit_capture_and_never_install_or_spawn(self):
        with patch('subprocess.Popen',side_effect=AssertionError('Unexpected process')):
            capture=WorkflowCapture('recording.json')
            for name in METHODS:
                with self.subTest(method=name),self.assertRaisesRegex(CaptureError,'Start the capture explicitly'):
                    getattr(capture,name)({})
            capture.close()
            for name in METHODS:
                with self.subTest(closed_method=name),self.assertRaises(CaptureError):getattr(capture,name)({})
            self.assertIsNone(capture._process)


class NativeMonitoringFacadeTests(unittest.TestCase):
    def setUp(self):
        worker=PYTHON_ROOT.parent/'dist'/'adapter'/'capture-worker.js'
        if not worker.is_file() or shutil.which('node') is None:self.skipTest('Build the capture worker for native RPC tests')
        directory=tempfile.TemporaryDirectory();self.addCleanup(directory.cleanup)
        self.path=Path(directory.name)/'recording.json'
        self.capture=WorkflowCapture(self.path,command=['node',str(worker)])
        self.capture.start();self.addCleanup(self.capture.close)

    def test_missing_monitoring_evidence_remains_unknown_and_readers_reject_invalid_contracts(self):
        self.assertEqual(self.capture.check_monitoring({})['status'],'unknown')
        for name in METHODS[:-1]:
            with self.subTest(method=name),self.assertRaises(CaptureError):getattr(self.capture,name)({})
        self.assertEqual(self.capture.snapshot()['snapshot']['commitLog'],[])

    def test_nonfinite_and_oversized_values_fail_before_the_native_contract(self):
        for name in METHODS:
            for value in ({'invalid':float('nan')},{'invalid':'x'*1_048_576}):
                with self.subTest(method=name),self.assertRaises(ValueError):getattr(self.capture,name)(value)
        self.assertEqual(self.capture.snapshot()['snapshot']['sharedState'],{})
        self.assertEqual(self.capture.snapshot()['snapshot']['commitLog'],[])

    def test_failed_monitoring_contract_discards_stage_without_changing_prior_evidence(self):
        with self.capture.stage('record-production-reference') as scope:scope['productionReference']={'revision':'retained'}
        with self.assertRaises(CaptureError):
            with self.capture.stage('invalid-monitoring-evidence') as scope:
                _=scope['productionReference'];scope['uncommitted']='must-discard'
                self.capture.read_monitoring_manifest({})
        with self.capture.stage('missing-monitoring-evidence') as scope:
            _=scope['productionReference'];scope['monitoringDecision']=self.capture.check_monitoring({})
        self.capture.close();record=json.loads(self.path.read_text())
        self.assertEqual(len(record['snapshot']['commitLog']),2)
        self.assertNotIn('uncommitted',record['snapshot']['sharedState'])
        self.assertEqual(record['snapshot']['sharedState']['monitoringDecision']['status'],'unknown')
        self.assertEqual([stage['status'] for stage in record['supplemental']['pythonCapture']['stages']],
                         ['committed','discarded','committed'])


if __name__=='__main__':unittest.main()
