"""Client protocol/lifecycle tests; checked ML release logic stays in TypeScript."""
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from footprint_ml_workflow import CaptureError,WorkflowCapture

WORKER=r'''
import json,sys
mode=sys.argv[1]
emit=lambda value:print(json.dumps(value),flush=True)
call_id=0
for line in sys.stdin:
    request=json.loads(line);identifier=request['id'];operation=request['op']
    if operation=='open':emit(dict(id=identifier,ok=True,result=dict(runId='client-protocol-test')))
    elif operation=='close':emit(dict(id=identifier,ok=True,result=dict(closed=True)));break
    elif operation=='snapshot':emit(dict(id=identifier,ok=True,result=dict(snapshot=dict(commitLog=[],sharedState={}))))
    else:
        call_id+=1
        packet=dict(type='callback',id=identifier,callId=call_id,method='verify_model',input=dict(modelRef={}))
        if mode=='foreign-parent':packet['id']+=1
        if mode=='foreign-method':packet['method']='publisher.publish'
        if mode=='oversized':packet['input']['large']='x'*1_048_576
        emit(packet)
        reply_line=sys.stdin.readline()
        if not reply_line:break
        reply=json.loads(reply_line)
        if mode=='duplicate':
            emit(packet)
            if not sys.stdin.readline():break
        emit(dict(id=identifier,ok=True,result=dict(callbackReply=reply)))
'''


class ReleaseBridgeClientTests(unittest.TestCase):
    def capture(self,mode='normal'):
        directory=tempfile.TemporaryDirectory();self.addCleanup(directory.cleanup)
        root=Path(directory.name);worker=root/'worker.py';worker.write_text(WORKER)
        capture=WorkflowCapture(root/'recording.json',command=[sys.executable,'-I','-S','-u',str(worker),mode])
        capture.start();self.addCleanup(capture.close);return capture,root

    def test_methods_do_not_spawn_or_install_implicitly(self):
        class Receiver:
            def publish(self,request):return {}
        with patch('subprocess.Popen',side_effect=AssertionError('Unexpected process')):
            capture=WorkflowCapture('recording.json')
            calls=[lambda:capture.read_model_release_plan({}),
                   lambda:capture.put_release_artifact('artifact.bin',store_root='store',format='fixture/v1'),
                   lambda:capture.prepare_model_release({},store_root='store',verify_model=lambda request:{}),
                   lambda:capture.publish_model_release({},store_root='store',publisher=Receiver()),
                   lambda:capture.release_model({},store_root='store',publisher=Receiver())]
            for call in calls:
                with self.assertRaisesRegex(CaptureError,'Start the capture explicitly'):call()
            self.assertIsNone(capture._process)

    def test_callback_reentry_is_refused_without_deadlock_and_errors_remain_correlated(self):
        capture,root=self.capture()
        result=capture.prepare_model_release({},store_root=root,verify_model=lambda request:capture.snapshot())
        reply=result['callbackReply']
        self.assertFalse(reply['ok']);self.assertEqual(reply['error']['code'],'capture-callback-reentry')
        self.assertEqual(reply['id'],2);self.assertEqual(reply['callId'],1)
        self.assertEqual(capture.snapshot()['snapshot']['commitLog'],[])

    def test_callbacks_cannot_close_the_capture_and_invalid_results_are_bounded_errors(self):
        capture,root=self.capture()
        closed=capture.prepare_model_release({},store_root=root,verify_model=lambda request:capture.close())
        self.assertEqual(closed['callbackReply']['error']['code'],'capture-callback-reentry')
        for value in (float('nan'),'x'*1_048_576,object()):
            result=capture.prepare_model_release({},store_root=root,verify_model=lambda request,value=value:value)
            self.assertFalse(result['callbackReply']['ok'])
            self.assertEqual(result['callbackReply']['error']['code'],'python-callback-error')
        self.assertEqual(capture.snapshot()['snapshot']['sharedState'],{})

    def test_foreign_duplicate_or_oversized_callbacks_abort_before_an_unmatched_callback_can_run(self):
        for mode,expected_calls in [('foreign-parent',0),('foreign-method',0),('duplicate',1),('oversized',0)]:
            with self.subTest(mode=mode):
                capture,root=self.capture(mode);calls=[]
                def verify(request):calls.append(request);return {}
                with self.assertRaises(CaptureError) as failure:
                    capture.prepare_model_release({},store_root=root,verify_model=verify)
                self.assertEqual(failure.exception.code,'capture-protocol-error')
                self.assertEqual(len(calls),expected_calls);self.assertTrue(capture._closed)

    def test_blocked_callback_times_out_closes_session_and_late_completion_sends_no_packet(self):
        capture,root=self.capture();capture.timeout=0.05
        release=threading.Event();finished=threading.Event()
        def verify(request):
            release.wait(2);finished.set();return {}
        try:
            with self.assertRaises(CaptureError) as failure:
                capture.prepare_model_release({},store_root=root,verify_model=verify)
            self.assertEqual(failure.exception.code,'capture-timeout')
            self.assertTrue(capture._closed);self.assertIsNotNone(capture._process.poll())
            with self.assertRaises(CaptureError):capture.snapshot()
        finally:release.set()
        self.assertTrue(finished.wait(1))

    def test_local_callback_configuration_errors_do_not_send_an_rpc(self):
        capture,root=self.capture();before=capture._request_id
        for call in [lambda:capture.prepare_model_release({},store_root=root,verify_model=None),
                     lambda:capture.publish_model_release({},store_root=root,publisher=object()),
                     lambda:capture.release_model({},store_root=root,publisher=object(),verify_model=3)]:
            with self.assertRaises(TypeError):call()
        self.assertEqual(capture._request_id,before)
        self.assertEqual(capture.snapshot()['snapshot']['commitLog'],[])


if __name__=='__main__':unittest.main()
