"""Receiver contract/failure tests with a fake injected registry, not ML numerics."""
from __future__ import annotations
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from footprint_ml_promotion import MlflowModelPublisher, PromotionError, MAX_JOURNAL_BYTES


class NotFound(Exception):
    error_code = 'RESOURCE_DOES_NOT_EXIST'


class Registry:
    def __init__(self):
        self.versions = {}; self.content = {}; self.alias = None
        self.mutations = 0; self.calls = 0; self.alias_error = None; self.after_set = None

    def get_model_version(self, name, version):
        self.calls += 1
        return self.versions[version]

    def get_registered_model(self, name):
        self.calls += 1
        if self.alias_error: raise self.alias_error
        return SimpleNamespace(name=name, aliases={} if self.alias is None else {'champion':self.alias})

    def get_model_version_by_alias(self, name, alias):
        self.calls += 1
        if self.alias_error: raise self.alias_error
        if self.alias is None: raise NotFound()
        return SimpleNamespace(name=name, version=self.alias)

    def download_artifacts(self, run_id, artifact_path, dst_path):
        self.calls += 1
        path = Path(dst_path) / 'bundle.json'
        path.write_bytes(self.content[run_id])
        return str(path)

    def set_registered_model_alias(self, name, alias, version):
        self.calls += 1; self.mutations += 1; self.alias = version
        if self.after_set: self.after_set(self)


class PromotionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.store = self.root/'store'; self.store.mkdir()
        self.registry = Registry()
        self.bytes = b'{"weights":[2,3],"scaler":{"mean":4},"fields":["x"]}'
        self.model = self.put(self.bytes, 'test-predictor/v1'); self.prepared = self.put(b'{}','application/json')
        for version, blob in [('1',self.bytes),('2',b'{"different":true}')]:
            run = 'run-'+version
            self.registry.versions[version] = SimpleNamespace(name='model',version=version,run_id=run,source=f'runs:/{run}/model',status='READY')
            self.registry.content[run] = blob
        self.publisher = self.make()
        self.request = self.req()

    def put(self, content, format):
        sha = hashlib.sha256(content).hexdigest()
        name = f'sha256-{sha}-{hashlib.sha256(format.encode()).hexdigest()}.bin'
        (self.store/name).write_bytes(content)
        return {'kind':'artifact','path':name,'sha256':sha,'bytes':len(content),'format':format}

    def make(self, version='1', **options):
        return MlflowModelPublisher(self.registry,store_root=self.store,journal_dir=self.root/'journal',registry_id='local',model_name='model',alias='champion',
            binding={'version':version,'runId':'run-'+version,'source':f'runs:/run-{version}/model','artifactPath':'model/bundle.json'},**options)

    def req(self, key='key-1', revision=None, artifact=None):
        artifact = artifact or self.model
        payload={'kind':'model-publication-payload','schemaVersion':1,'releaseId':'release-'+key,'idempotencyKey':key,
            'target':{'name':self.publisher.target_name,'expectedRevision':revision},
            'artifact':{k:artifact[k] for k in ('sha256','bytes','format')},'validUntil':None}
        canonical=json.dumps(payload,sort_keys=True,separators=(',',':'))
        return {'payload':payload,'payloadCanonicalJson':canonical,'payloadSha256':hashlib.sha256(canonical.encode()).hexdigest(),
                'preparedRef':self.prepared,'modelArtifact':artifact}

    def lookup(self, request=None, publisher=None):
        req=copy.deepcopy(request or self.request);req.pop('modelArtifact')
        return (publisher or self.publisher).lookup(req)

    def test_import_construction_and_absent_lookup_start_no_client_or_storage(self):
        self.assertEqual(self.registry.calls,0);self.assertIsNone(self.lookup())
        self.assertEqual(self.registry.calls,0);self.assertFalse((self.root/'journal').exists())

    def test_exact_promotion_and_read_only_historical_retry(self):
        result=self.publisher.publish(self.request)
        self.assertEqual(result['status'],'published');self.assertEqual(self.registry.alias,'1')
        calls=self.registry.calls
        ack=self.lookup();self.assertEqual(ack['status'],'already-published')
        self.assertEqual(ack['receipt'],result['receipt']);self.assertEqual(self.registry.calls,calls)
        self.assertEqual(self.registry.mutations,1)
        self.assertEqual(self.make().publish(self.request)['status'],'already-published')
        self.assertEqual(self.registry.mutations,1)

    def test_timeout_inside_setter_never_becomes_success_from_matching_alias(self):
        def lost_reply(client): raise TimeoutError('reply lost after registry mutation')
        self.registry.after_set=lost_reply
        self.assertEqual(self.publisher.publish(self.request)['status'],'unknown')
        self.assertEqual(self.registry.alias,'1');self.assertEqual(self.registry.mutations,1)
        self.registry.after_set=None
        self.assertEqual(self.lookup()['status'],'unknown')
        self.assertEqual(self.make().publish(self.request)['status'],'unknown')
        self.assertEqual(self.publisher.read_state()['entries'][0]['status'],'pending')
        self.assertEqual(self.registry.mutations,1)
        self.assertEqual(self.publisher.publish(self.req('new-key'))['status'],'unknown')
        self.assertEqual(self.registry.mutations,1)

    def test_old_ack_does_not_rewind_new_promotion(self):
        first=self.publisher.publish(self.request)
        second_artifact=self.put(self.registry.content['run-2'],'test-predictor/v1')
        second=self.req('key-2',first['receipt']['revision'],second_artifact)
        pub2=self.make('2');self.assertEqual(pub2.publish(second)['status'],'published')
        self.assertEqual(self.registry.alias,'2');calls=self.registry.calls
        self.assertEqual(self.lookup()['status'],'already-published')
        self.assertEqual(self.registry.calls,calls);self.assertEqual(self.registry.alias,'2')

    def test_same_bytes_in_another_version_cannot_relabel_a_prior_receipt(self):
        self.assertEqual(self.publisher.publish(self.request)['status'],'published')
        self.registry.content['run-2']=self.bytes
        result=self.lookup(publisher=self.make('2'))
        self.assertEqual(result['status'],'deny');self.assertEqual(result['reasons'][0]['code'],'promotion-binding-conflict')

    def test_changed_artifact_or_source_stops_before_alias_change(self):
        for content in (b'X'*len(self.bytes),b'oversized different blob'):
            self.registry.content['run-1']=content
            self.assertEqual(self.publisher.publish(self.request)['status'],'deny')
            self.assertEqual(self.registry.mutations,0)
        self.registry.content['run-1']=self.bytes
        self.registry.versions['1'].source='runs:/wrong/model'
        self.assertEqual(self.publisher.publish(self.request)['status'],'deny')
        self.assertEqual(self.registry.mutations,0)

    def test_changed_managed_artifact_stops_before_any_client_call(self):
        (self.store/self.model['path']).write_bytes(b'bad')
        self.assertEqual(self.publisher.publish(self.request)['status'],'deny')
        self.assertEqual(self.registry.calls,0)

    def test_permission_failure_is_not_interpreted_as_absent_alias(self):
        self.registry.alias_error=PermissionError('not allowed')
        self.assertEqual(self.publisher.publish(self.request)['status'],'unknown')
        self.assertEqual(self.registry.mutations,0)

    def test_existing_uncoordinated_alias_and_wrong_revision_are_refused(self):
        self.registry.alias='2'
        self.assertEqual(self.publisher.publish(self.request)['status'],'unknown')
        self.assertEqual(self.registry.mutations,0)
        wrong=self.req('other', 'a'*64)
        self.assertEqual(self.publisher.publish(wrong)['status'],'deny')
        self.assertEqual(self.registry.mutations,0)

    def test_conflicting_idempotency_payload_is_denied(self):
        self.publisher.publish(self.request)
        other=self.req(artifact=self.put(b'another predictor','test-predictor/v1'))
        self.assertEqual(self.lookup(other)['status'],'deny');self.assertEqual(self.registry.mutations,1)

    def test_readback_artifact_or_alias_conflict_retains_pending(self):
        self.registry.after_set=lambda client: client.content.update({'run-1':b'changed'})
        self.assertEqual(self.publisher.publish(self.request)['status'],'unknown')
        self.assertEqual(self.publisher.read_state()['entries'][0]['status'],'pending')
        self.assertEqual(self.registry.mutations,1)

    def test_failed_commit_write_after_effect_retains_pending(self):
        original=self.publisher._write_journal; count=0
        def failing(state):
            nonlocal count
            count+=1
            if count==3: raise OSError('commit disk error')
            original(state)
        with patch.object(self.publisher,'_write_journal',side_effect=failing):
            self.assertEqual(self.publisher.publish(self.request)['status'],'unknown')
        self.assertEqual(self.lookup()['status'],'unknown');self.assertEqual(self.registry.mutations,1)

    def test_partial_owner_write_cleans_up_and_preserves_primary_error(self):
        original=Path.open; partial_writes=[]
        class Broken:
            def __init__(self,file):self.file=file
            def write(self,value):self.file.write(value[:4]);partial_writes.append(value[:4]);raise OSError('partial owner write')
            def close(self):self.file.close()
        def opening(path,*args,**kwargs):
            file=original(path,*args,**kwargs)
            return Broken(file) if path.name=='owner.json' else file
        with patch.object(Path,'open',opening):
            self.assertEqual(self.publisher.publish(self.request)['status'],'unknown')
        self.assertTrue(partial_writes)
        self.assertFalse((self.root/'journal'/'.promotion-lock').exists())
        self.assertEqual(self.publisher.publish(self.request)['status'],'published')

    def test_busy_lock_is_not_broken(self):
        lock=self.root/'journal'/'.promotion-lock';lock.mkdir(parents=True)
        self.assertEqual(self.publisher.publish(self.request)['status'],'unknown')
        self.assertTrue(lock.exists());self.assertEqual(self.registry.mutations,0)

    def test_corrupt_missing_or_oversized_journal_fails_closed(self):
        self.publisher.publish(self.request);journal=self.root/'journal'/'journal.json';original=journal.read_bytes()
        for content in (b'bad',b'{"kind": "future"}'):
            journal.write_bytes(content)
            self.assertFalse(self.lookup()['allowed'])
        journal.write_bytes(original);journal.unlink()
        self.assertFalse(self.lookup()['allowed'])
        with journal.open('wb') as file:file.truncate(MAX_JOURNAL_BYTES+1)
        self.assertFalse(self.lookup()['allowed']);self.assertEqual(self.registry.mutations,1)

    def test_unsupported_coordination_rejected_without_work(self):
        with self.assertRaises(PromotionError):self.make(coordination='distributed-uncoordinated')
        self.assertEqual(self.registry.calls,0)

    def test_noncanonical_source_or_escaping_artifact_binding_rejected(self):
        for source,path in [('models:/model/1','model/bundle.json'),('runs:/run-1/model','another/bundle.json')]:
            with self.assertRaises(ValueError):
                MlflowModelPublisher(self.registry,store_root=self.store,journal_dir=self.root/'bad',registry_id='local',model_name='model',alias='champion',binding={'version':'1','runId':'run-1','source':source,'artifactPath':path})

    def test_receiver_verifies_canonical_payload_bytes_and_managed_paths(self):
        for mutation in (lambda r:r.update(payloadCanonicalJson='{}'),lambda r:r['modelArtifact'].update(path='../escape')):
            req=copy.deepcopy(self.request);mutation(req)
            self.assertEqual(self.publisher.publish(req)['status'],'deny')
        self.assertEqual(self.registry.calls,0)


if __name__=='__main__':unittest.main()
