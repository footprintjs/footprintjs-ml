"""Adversarial saved-audit controls on disposable copies of a completed run."""
import argparse
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tempfile

SPEC = importlib.util.spec_from_file_location('regression_saved_audit', Path(__file__).with_name('audit.py'))
audit_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit_module)


def verify(source, output):
    source = Path(source).resolve(strict=True)
    output = Path(output).resolve()
    if output.exists():
        raise ValueError('Choose a new report file')
    before = {name: (source/name).read_bytes() for name in ('recording.json','outcome.json','numerical-observations.json')}
    controls = {}
    def empty_observations(state, outcome): state['pooledObservations'] = []
    def missing_response(state, outcome): del outcome['fullNativeResponses']['pooledDecision']
    def no_responses(state, outcome): outcome['fullNativeResponses'] = {}
    def rebind_policy(state, outcome): state['pooledManifest']['policies'][0]['maxDeterioration'] = 999
    def different_observation(state, outcome): state['pooledObservations'][0]['candidate']['metrics']['mse'] = .001
    def different_response_ref(state, outcome): outcome['fullNativeResponses']['pooledDecision'] = state['unchangedDecisionRef']
    def missing_receipt_observation(state, outcome): state['pooledReceipt']['observations'] = []
    def different_training_configuration(state, outcome): state['candidateConfigurations'][0]['configuration']['weighting'] = 'equal-row-mass'
    mutations = {'emptyPairedObservations':empty_observations, 'missingNativeResponse':missing_response,
        'emptyNativeResponseSet':no_responses, 'rewrittenDeclaredPolicy':rebind_policy,
        'differentPairedMetric':different_observation,'differentPinnedNativeResponse':different_response_ref,
        'emptyOfferedReceiptObservations':missing_receipt_observation,'differentDeclaredTrainingConfiguration':different_training_configuration}
    with tempfile.TemporaryDirectory(prefix='footprint-regression-audit-') as temporary:
        for name, mutate in [('complete',None), *mutations.items()]:
            folder = Path(temporary)/name
            shutil.copytree(source, folder)
            # The verifier uses exclusive report creation; retain any prior report
            # under a different name inside this disposable copy.
            prior = folder/'audit.json'
            if prior.exists(): prior.rename(folder/'prior-audit.json')
            recording=json.loads(before['recording.json']); outcome=json.loads(before['outcome.json'])
            if mutate:
                mutate(recording['snapshot']['sharedState'],outcome)
                recording['snapshot']['sharedState']['outcome']=outcome
                (folder/'recording.json').write_text(json.dumps(recording,allow_nan=False))
                (folder/'outcome.json').write_text(json.dumps(outcome,allow_nan=False))
            try:
                with contextlib.redirect_stdout(io.StringIO()): audit_module.audit(folder)
            except (ValueError,KeyError,TypeError) as error:
                if mutate is None: raise
                controls[name]={'rejected':True,'reason':str(error)}
            else:
                if mutate is not None: raise AssertionError('Malformed saved evidence passed: '+name)
                controls[name]={'accepted':True}
    if any((source/name).read_bytes()!=content for name,content in before.items()):
        raise AssertionError('Source recording changed')
    report={'schema':'footprint-ml-regression-audit-controls/v1','passed':True,'controls':controls,
        'execution':{'sourceUnchanged':True,'trainingStarted':False,'guardRecomputed':False,'publicationPerformed':False},
        'boundary':'Saved-evidence checker acceptance controls; no producer authentication or numerical training.'}
    output.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'passed':True,'controls':len(controls),'report':str(output)}))
    return report


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--run',required=True);parser.add_argument('--out',required=True)
    args=parser.parse_args();verify(args.run,args.out)
