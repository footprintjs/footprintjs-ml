"""Regression checks for bounded consumption, without running an ML trainer."""
from pathlib import Path
import hashlib
import os
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

PACKAGE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(PACKAGE))
from footprint_ml_adapter.runtime import AdapterRuntime, MAX_ARCHIVE_BYTES, _checkpoint_bytes
from footprint_ml_workflow import MlflowArtifacts
from test_runtime import PLUGIN


class CheckpointReadTests(unittest.TestCase):
    def test_oversized_checkpoint_is_refused_before_payload_read(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory);plugin=base/'plugin.py';plugin.write_text(PLUGIN)
            runtime=AdapterRuntime();runtime.initialize({'root':str(base/'run'),'pluginPath':str(plugin),'config':{}})
            large=base/'run'/'large.npz'
            with large.open('wb') as file:file.truncate(MAX_ARCHIVE_BYTES+1)
            reference={'kind':'artifact','path':large.name,'sha256':'a'*64,'bytes':MAX_ARCHIVE_BYTES+1,
                       'format':'footprint-ml-adapter-kit/trainstate-npz-v1'}
            with patch('footprint_ml_adapter.runtime.os.read',side_effect=AssertionError('Payload must not be read')):
                with self.assertRaisesRegex(ValueError,'archive size'):
                    runtime.load({'checkpoint':{'kind':'checkpoint','artifact':reference}})
            self.assertEqual(len(runtime._models),0)

    def test_checkpoint_growth_shrink_and_same_size_mutation_are_refused_with_bounded_reads(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'checkpoint';original_read=os.read
            for change in ('grow','shrink','rewrite'):
                path.write_bytes(b'abc');calls=[]
                def consume(descriptor,size):
                    calls.append(size);result=original_read(descriptor,size)
                    if len(calls)==1:
                        if change=='grow':
                            with path.open('ab') as file:file.write(b'x'*100000)
                        elif change=='shrink':path.write_bytes(b'')
                        else:
                            previous=path.stat();path.write_bytes(b'xyz')
                            os.utime(path,ns=(previous.st_atime_ns,previous.st_mtime_ns+1_000_000_000))
                    return result
                with self.subTest(change=change),patch('footprint_ml_adapter.runtime.os.read',side_effect=consume):
                    with self.assertRaisesRegex(ValueError,'changed|grew'):_checkpoint_bytes(path)
                self.assertLessEqual(sum(calls),4)

    @unittest.skipUnless(hasattr(os,'mkfifo'),'FIFO requires POSIX')
    def test_checkpoint_fifo_is_rejected_without_waiting_for_a_writer(self):
        with tempfile.TemporaryDirectory() as directory:
            fifo=Path(directory)/'not-a-checkpoint';os.mkfifo(fifo)
            program="import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from footprint_ml_adapter.runtime import _checkpoint_bytes; _checkpoint_bytes(Path(sys.argv[2]))"
            result=subprocess.run([sys.executable,'-I','-c',program,str(PACKAGE),str(fifo)],
                                  capture_output=True,text=True,timeout=5)
            self.assertNotEqual(result.returncode,0);self.assertIn('regular file',result.stderr)


class Client:
    def get_run(self,identifier):return SimpleNamespace(info=SimpleNamespace(run_id=identifier,experiment_id='1'))
    def download_artifacts(self,run_id,artifact_path,dst_path):
        file=Path(dst_path)/'download.bin';file.write_bytes(b'abc');return str(file)


class ObservedFile:
    def __init__(self,source,calls,after_first=None):self.source,self.calls,self.after_first=source,calls,after_first
    def __enter__(self):return self
    def __exit__(self,*args):return self.source.__exit__(*args)
    def fileno(self):return self.source.fileno()
    def read(self,size):
        self.calls.append(size);result=self.source.read(size)
        if len(self.calls)==1 and self.after_first:self.after_first()
        return result


class MlflowReadTests(unittest.TestCase):
    def test_wrong_size_cache_is_rejected_before_content_read(self):
        import footprint_ml_workflow as workflow
        with tempfile.TemporaryDirectory() as directory:
            artifacts=MlflowArtifacts(Client(),Path(directory)/'cache');reference=artifacts.bind_artifact('run-1','weights')
            file=artifacts.local_path(reference)
            with file.open('wb') as output:output.truncate(128*1024*1024)
            original=workflow._open_regular;calls=[]
            with patch.object(workflow,'_open_regular',side_effect=lambda *args:ObservedFile(original(*args),calls)):
                with self.assertRaisesRegex(ValueError,'bytes changed'):artifacts.read_bytes(reference)
            self.assertEqual(calls,[])

    def test_cache_growth_is_bounded_and_same_sized_corruption_still_fails_hash(self):
        import footprint_ml_workflow as workflow
        with tempfile.TemporaryDirectory() as directory:
            artifacts=MlflowArtifacts(Client(),Path(directory)/'cache');reference=artifacts.bind_artifact('run-1','weights')
            file=artifacts.local_path(reference);original=workflow._open_regular;calls=[]
            def grow():
                with file.open('ab') as output:output.write(b'x'*100000)
            with patch.object(workflow,'_open_regular',side_effect=lambda *args:ObservedFile(original(*args),calls,grow)):
                with self.assertRaisesRegex(ValueError,'bytes changed'):artifacts.read_bytes(reference)
            self.assertEqual(calls,[3,1])
            file.write_bytes(b'xyz')
            with self.assertRaisesRegex(ValueError,'bytes changed'):artifacts.read_bytes(reference)
            file.write_bytes(b'abc');self.assertEqual(artifacts.read_bytes(reference),b'abc')
            self.assertEqual(reference['artifact']['sha256'],hashlib.sha256(b'abc').hexdigest())


if __name__=='__main__':unittest.main()
