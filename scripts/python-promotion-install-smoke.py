"""Exercise an installed wheel's checked promotion using a synthetic client.

This is packaging/protocol acceptance, not numerical or real-registry evidence.
Run with the isolated installed interpreter after explicit native helper setup.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import sys
import time
from types import SimpleNamespace

from footprint_ml_workflow import WorkflowCapture
from footprint_ml_promotion import MlflowModelPublisher


def main(out):
    import footprint_ml_promotion
    assert Path(footprint_ml_promotion.__file__).resolve().is_relative_to(Path(sys.prefix).resolve())
    out = Path(out).resolve(); out.mkdir()
    store = out / 'store'
    count = 0
    model_content = b'{"syntheticPredictor":true}'
    class Client:
        alias = None
        mutations = 0
        def get_registered_model(self, name):
            return SimpleNamespace(name=name,aliases={} if self.alias is None else {'champion':self.alias})
        def get_model_version(self, name, version):
            return SimpleNamespace(name=name,version=version,run_id='install-run',source='runs:/install-run/model',status='READY')
        def get_model_version_by_alias(self, name, alias):
            return SimpleNamespace(name=name,version=self.alias)
        def download_artifacts(self, run, path, dst_path):
            target=Path(dst_path)/'bundle.json';target.write_bytes(model_content);return str(target)
        def set_registered_model_alias(self, name, alias, version):
            self.mutations+=1;self.alias=version
    client=Client()
    publisher=MlflowModelPublisher(client,store_root=store,journal_dir=out/'journal',registry_id='installed',model_name='fixture',alias='champion',
        binding={'version':'1','runId':'install-run','source':'runs:/install-run/model','artifactPath':'model/bundle.json'})
    with WorkflowCapture(out/'recording.json') as capture:
        def put(content, format='application/json'):
            nonlocal count
            count+=1;path=out/f'input-{count}.json'
            path.write_bytes(content if isinstance(content,bytes) else json.dumps(content,separators=(',',':'),allow_nan=False).encode())
            return capture.put_release_artifact(path,store_root=store,format=format)
        artifact=put(model_content,'synthetic-install-predictor/v1')
        model={'kind':'model','sessionId':'installed-synthetic-release','handle':1,'originArtifact':artifact,
            'inferenceIdentity':{'kind':'inference-identity','schemaVersion':1,'profile':'synthetic-installed-predictor/v1','sha256':hashlib.sha256(model_content).hexdigest()}}
        dataset={'kind':'dataset','sessionId':model['sessionId'],'handle':1,'rows':1,'shape':[1,1],'role':'validation','artifact':put(b'{"row":1}','synthetic-data/v1')}
        comparison={'datasetRef':dataset,'preprocessingVersion':'synthetic/v1','evaluationMethodVersion':'synthetic/v1','parameters':{}}
        evaluation=capture.create_evaluation_receipt({**comparison,'modelRef':model,'evaluationId':'installed-synthetic','createdAt':1,'metrics':{'mse':0}})
        manifest=capture.read_selection_manifest({'kind':'selection-manifest','schemaVersion':1,'experimentId':'installed-synthetic',
            'candidates':[{'candidateId':'a','configuration':{'seed':1}}],'comparison':comparison,
            'policy':{'metric':'mse','direction':'min','tieBreak':'candidate-id-ascending'}})
        results=[{'candidateId':'a','configuration':{'seed':1},'modelRef':model,'evaluation':evaluation}]
        selected=capture.create_selection_receipt({'selectionId':'installed-selection','createdAt':1,'manifest':manifest,'results':results})
        group={'groupId':'all','definitionRef':put({'where':'all rows'}),'membershipRef':put([0]),'datasetRef':dataset,'expectedRows':1}
        regression_manifest=capture.read_regression_manifest({'kind':'regression-manifest','schemaVersion':1,'comparisonId':'installed-paired',
            'baselineModelRef':model,'candidateModelRef':model,'comparison':comparison,'groups':[group],
            'policies':[{'groupId':'all','metric':'mse','direction':'min','maxDeterioration':0,'minSamples':1}]})
        observations=[{'groupId':'all','definitionRef':group['definitionRef'],'membershipRef':group['membershipRef'],'rows':1,
            'baseline':evaluation,'candidate':evaluation}]
        regression_receipt=capture.create_regression_receipt({'regressionId':'installed-regression','createdAt':1,
            'manifest':regression_manifest,'observations':observations})
        assert capture.read_regression_receipt(regression_receipt)==regression_receipt
        assert capture.check_regression({'manifest':regression_manifest,'observations':observations,
            'receipt':regression_receipt,'modelRef':model,'now':2})['allowed']
        plan=capture.read_model_release_plan({'kind':'model-release-plan','schemaVersion':1,'releaseId':'installed-release','idempotencyKey':'installed-key',
            'target':{'name':publisher.target_name,'expectedRevision':None},'modelArtifact':artifact,
            'manifestRef':put(manifest),'resultsRef':put(results),'selectionReceiptRef':put(selected),
            'qualityPolicy':{'metric':'mse','operator':'lte','threshold':0},
            'regression':{'manifestRef':put(regression_manifest),'observationsRef':put(observations),'receiptRef':put(regression_receipt)}})
        plan_ref=put(plan)
        def compact(value):
            # Full native responses remain intact in managed evidence; scope
            # keeps a small exact approval/status/preparation projection.
            return {'allowed':value['allowed'],'status':value['status'],'preparedRef':value['preparedRef'],
                'responseRef':put(value),'publisherReceipt':value.get('publisherReceipt'),'regressionAllowed':value['decision']['checks']['regression']['allowed']}
        def verify(request):
            observed=copy.deepcopy(request['modelRef'])
            assert observed['originArtifact']['sha256']==hashlib.sha256(model_content).hexdigest()
            return observed
        with capture.stage('installed-prepare') as scope:
            scope['planRef']=plan_ref;scope['modelRef']=model
            scope['preparation']=compact(capture.prepare_model_release({'planRef':scope['planRef'],'modelRef':scope['modelRef']},store_root=store,verify_model=verify))
        with capture.stage('installed-publish') as scope:
            prepared=scope['preparation'];assert prepared['allowed'],prepared
            scope['publication']=compact(capture.publish_model_release({'planRef':scope['planRef'],'preparedRef':prepared['preparedRef'],'modelRef':scope['modelRef']},
                store_root=store,publisher=publisher,verify_model=verify))
            assert scope['publication']['status']=='published',scope['publication']
        with capture.stage('installed-acknowledge') as scope:
            scope['retry']=compact(capture.publish_model_release({'planRef':scope['planRef'],'preparedRef':scope['preparation']['preparedRef']},store_root=store,publisher=publisher))
            assert scope['retry']['status']=='already-published',scope['retry']
        with capture.stage('installed-monitoring') as scope:
            clock=int(time.time()*1000)
            contract=capture.create_prediction_contract({'profile':'synthetic-install-input-output/v1',
                'input':{'fields':[{'name':'x','dtype':'float64'}]},'output':{'fields':[{'name':'y','dtype':'float64'}]},
                'preprocessingVersion':'synthetic/v1','parameters':{}})
            receipt=scope['publication']['publisherReceipt']
            deployment={'targetName':receipt['targetName'],'revision':receipt['revision'],'modelRef':scope['modelRef'],'publicationRef':put(receipt)}
            window={'windowId':'installed-window','startAt':clock-20,'endAt':clock-10,'inputRef':dataset['artifact'],
                'membershipRef':put({'rowIds':['p1']}),'expectedRows':1,'inferenceId':'installed-invocation'}
            declared=capture.read_monitoring_manifest({'kind':'monitoring-manifest','schemaVersion':1,'monitorId':'installed-monitor',
                'deployment':deployment,'window':window,'contract':contract,'labelSource':{'name':'installed-labels','version':'1'},
                'joinMode':'row-id-window-time/v1','evaluation':{key:comparison[key] for key in ('preprocessingVersion','evaluationMethodVersion','parameters')},
                'policy':{'metric':'mse','operator':'lte','threshold':0,'minSamples':1,'minCoverage':1,'maxAgeMs':1000}})
            output_ref=put({'prediction':1});label_ref=put({'outcome':1})
            prediction=capture.create_inference_receipt({'inferenceId':window['inferenceId'],'createdAt':clock+1,
                'inputRef':window['inputRef'],'outputRef':output_ref,'inputRows':1,'outputRows':1,'modelRef':model,'contract':contract})
            observed={'deployment':{**deployment,'observedAt':clock},'window':{key:window[key] for key in ('windowId','startAt','endAt','inputRef','membershipRef')},
                'prediction':prediction}
            observed['window'].update(rows=1,closedAt=clock-1)
            pending=capture.create_monitoring_receipt({'monitoringId':'installed-pending','createdAt':clock+2,'manifest':declared,'observation':observed})
            delayed=capture.check_monitoring({'receipt':pending,'manifest':declared,'observation':observed,'now':clock+10})
            assert delayed['status']=='unknown' and delayed['health'] is None,delayed
            joined_dataset={**dataset,'artifact':put({'rowId':'p1','prediction':1,'outcome':1}),'role':'monitoring'}
            measured=capture.create_evaluation_receipt({**comparison,'datasetRef':joined_dataset,'modelRef':model,
                'evaluationId':'installed-monitoring-eval','createdAt':clock+4,'metrics':{'mse':0}})
            observed.update(labels={'batchId':'installed-label-batch','windowId':window['windowId'],'source':declared['labelSource'],
                    'labelRef':label_ref,'availableAt':clock+2},
                join={'windowId':window['windowId'],'joinMode':declared['joinMode'],'joinRef':put({'matchedRows':1}),
                    'inputRef':window['inputRef'],'outputRef':output_ref,'labelRef':label_ref,'membershipRef':window['membershipRef'],
                    'joinedDatasetRef':joined_dataset,'matchedRows':1,'missingRows':0,'duplicateRows':0,'unmatchedRows':0,'crossWindowRows':0,'createdAt':clock+3},
                evaluation=measured)
            scope['monitoringManifest']=declared;scope['monitoringObservation']=observed
            scope['monitoringReceipt']=capture.create_monitoring_receipt({'monitoringId':'installed-complete','createdAt':clock+5,
                'manifest':scope['monitoringManifest'],'observation':scope['monitoringObservation']})
            assert capture.read_monitoring_receipt(scope['monitoringReceipt'])==scope['monitoringReceipt']
            result=capture.check_monitoring({'receipt':scope['monitoringReceipt'],'manifest':scope['monitoringManifest'],
                'observation':scope['monitoringObservation'],'now':clock+10})
            assert result['allowed'] and result['health']=='healthy',result
            wrong=copy.deepcopy(declared);wrong['window']['windowId']='another-window'
            borrowed=capture.check_monitoring({'receipt':scope['monitoringReceipt'],'manifest':wrong,'observation':scope['monitoringObservation'],'now':clock+10})
            assert borrowed['status']=='deny' and borrowed['health'] is None,borrowed
            scope['monitoringStatus']={'complete':result['status'],'delayed':delayed['status'],'borrowed':borrowed['status']}
    assert client.mutations==1 and client.alias=='1'
    return {'passed':True,'installedModule':True,'nativeCheckedReleaseCallbacks':True,'receiverConsumesApprovedArtifact':True,
            'historicalRetryWithoutVerifier':True,'aliasMutations':client.mutations,'syntheticClient':True,'numericalTraining':False,'installedRegressionContracts':True,'requiredRegressionInPublication':True,'installedMonitoringContracts':True,'delayedMonitoringUnknown':True,'borrowedMonitoringEvidenceDenied':True}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--out',required=True)
    print(json.dumps(main(parser.parse_args().out)))
