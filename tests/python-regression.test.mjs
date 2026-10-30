import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import * as sdk from '../dist/index.js';
import {openRecording,traceToolpack,callTraceTool} from 'agentfootprint/observe';
import {openWorkflowRecording} from '../lens/session.mjs';

const NOW=1_800_000_000_000,clone=value=>structuredClone(value);
const worker=fileURLToPath(new URL('../dist/adapter/capture-worker.js',import.meta.url));
const pythonRoot=fileURLToPath(new URL('../python',import.meta.url)),python=process.env.TEST_PYTHON??'python3';
const artifact=digit=>({kind:'artifact',path:`synthetic/${digit}.json`,sha256:digit.repeat(64),bytes:128,format:'synthetic/regression-v1'});
const model=digit=>({kind:'model',sessionId:'synthetic-worker',handle:parseInt(digit,16),originArtifact:artifact(digit),
  inferenceIdentity:{kind:'inference-identity',schemaVersion:1,profile:'synthetic/paired-predictor-v1',sha256:digit.repeat(64)}});
const dataset=(digit,rows)=>({kind:'dataset',sessionId:'synthetic-worker',handle:parseInt(digit,16),rows,shape:[rows,2],role:'validation',artifact:artifact(digit)});
function fixture(){
  const baseline=model('a'),candidate=model('b'),comparison={datasetRef:dataset('c',100),
    preprocessingVersion:'measured-scaler/v1',evaluationMethodVersion:'held-out-accuracy/v1',parameters:{mode:'labels'}};
  const groups=[{groupId:'overall',definitionRef:artifact('1'),membershipRef:artifact('2'),datasetRef:dataset('3',100),expectedRows:100},
    {groupId:'rural',definitionRef:artifact('4'),membershipRef:artifact('5'),datasetRef:dataset('6',20),expectedRows:20}];
  const manifest={kind:'regression-manifest',schemaVersion:1,comparisonId:'synthetic-baseline-challenger',baselineModelRef:baseline,candidateModelRef:candidate,
    comparison,groups,policies:groups.map(({groupId})=>({groupId,metric:'accuracy',direction:'max',maxDeterioration:0.05,minSamples:10})),maxAgeMs:100};
  const observations=groups.map((group,index)=>({groupId:group.groupId,definitionRef:group.definitionRef,membershipRef:group.membershipRef,rows:group.expectedRows,
    baseline:sdk.createEvaluationReceipt({evaluationId:`baseline-${group.groupId}`,createdAt:NOW,modelRef:baseline,...comparison,datasetRef:group.datasetRef,metrics:{accuracy:0.9}}),
    candidate:sdk.createEvaluationReceipt({evaluationId:`candidate-${group.groupId}`,createdAt:NOW,modelRef:candidate,...comparison,datasetRef:group.datasetRef,metrics:{accuracy:index===0?0.95:0.8}})}));
  const input={regressionId:'paired-observations',createdAt:NOW,manifest,observations},receipt=sdk.createRegressionReceipt(input);
  const request={receipt,manifest,observations,modelRef:candidate,now:NOW};return{manifest,observations,input,receipt,request};
}
const methods={read_regression_manifest:()=>sdk.readRegressionManifest,create_regression_receipt:()=>sdk.createRegressionReceipt,
  read_regression_receipt:()=>sdk.readRegressionReceipt,check_regression:()=>sdk.checkRegression};
const direct=({operation,input})=>{try{return{ok:true,result:methods[operation]()(input)};}
  catch(error){return{ok:false,error:{code:error.code??'capture',message:error.message}};}};
async function run(t,payload,body){
  const root=await mkdtemp(resolve(tmpdir(),'footprint-python-regression-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const input=resolve(root,'input.json'),path=resolve(root,'recording.json');await writeFile(input,JSON.stringify(payload));
  const header=String.raw`
import json,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from footprint_ml_workflow import WorkflowCapture,CaptureError
payload=json.loads(Path(sys.argv[4]).read_text())
capture=WorkflowCapture(sys.argv[5],command=[sys.argv[2],sys.argv[3]])
`;
  const result=spawnSync(python,['-I','-S','-c',header+'\n'+body,pythonRoot,process.execPath,worker,input,path],
    {encoding:'utf8',timeout:20000,maxBuffer:5*1024*1024});
  if(result.error?.code==='ENOENT'){t.skip('Python unavailable');return;}
  assert.equal(result.status,0,result.stderr||result.stdout||String(result.error));
  return{output:JSON.parse(result.stdout),recording:JSON.parse(await readFile(path,'utf8'))};
}
async function parity(t,requests){
  const result=await run(t,requests,String.raw`
answers=[]
with capture:
    for request in payload:
        try:answers.append(dict(ok=True,result=getattr(capture,request['operation'])(request['input'])))
        except CaptureError as error:answers.append(dict(ok=False,error=dict(code=error.code,message=str(error))))
    assert capture.snapshot()['snapshot']['commitLog']==[]
print(json.dumps(answers,allow_nan=False))
`);
  if(!result)return;assert.deepEqual(result.output,requests.map(direct));return result.output;
}

test('Python regression methods preserve exact native JSON and group regression despite a better overall score',async t=>{
  const f=fixture(),requests=[{operation:'read_regression_manifest',input:f.manifest},{operation:'create_regression_receipt',input:f.input},
    {operation:'read_regression_receipt',input:f.receipt},{operation:'check_regression',input:f.request}];
  const results=await parity(t,requests);if(!results)return;
  assert(results.every(value=>value.ok));assert.equal(results[3].result.allowed,false);assert.equal(results[3].result.status,'deny');
  const corrected=clone(f.input);corrected.observations[1].candidate.metrics.accuracy=0.92;
  const request={...f.request,receipt:sdk.createRegressionReceipt(corrected),observations:corrected.observations};
  const allowed=await parity(t,[{operation:'check_regression',input:request}]);if(allowed)assert.equal(allowed[0].result.allowed,true);
});

test('Independent manifest/observations and missing coverage stay authoritative across Python RPC',async t=>{
  const f=fixture(),corrected=clone(f.input);corrected.observations[1].candidate.metrics.accuracy=0.92;
  const valid={...f.request,receipt:sdk.createRegressionReceipt(corrected),observations:corrected.observations};
  const changed=mutate=>{const input=clone(valid);mutate(input);return{operation:'check_regression',input};};
  const missingGroup=clone(corrected);missingGroup.observations.pop();
  const requests=[changed(value=>{delete value.observations;}),changed(value=>{value.observations[1].candidate.metrics.accuracy=0.99;}),
    changed(value=>{value.manifest.groups[1].membershipRef.sha256='d'.repeat(64);}),changed(value=>{value.modelRef=model('d');}),
    {operation:'check_regression',input:{...valid,receipt:sdk.createRegressionReceipt(missingGroup),observations:missingGroup.observations}},
    changed(value=>{delete value.receipt;}),{operation:'read_regression_manifest',input:{...f.manifest,unexpected:true}},
    {operation:'read_regression_receipt',input:{...f.receipt,schemaVersion:99}}];
  const actual=await parity(t,requests);if(!actual)return;
  assert.deepEqual(actual.slice(0,6).map(value=>value.result.status),['unknown','deny','deny','deny','unknown','unknown']);
  assert(actual.slice(6).every(value=>value.ok===false));
});

test('Fresh regression receipts cannot hide stale or future paired evaluation timestamps',async t=>{
  const f=fixture(),valid=clone(f.input);valid.observations[1].candidate.metrics.accuracy=0.92;
  const requests=[];
  for(const mutate of [value=>{value.observations[0].baseline.createdAt=NOW-101;},
    value=>{value.observations[1].candidate.createdAt=NOW-101;},value=>{value.observations[1].baseline.createdAt=NOW+1;}]){
    const input=clone(valid);mutate(input);requests.push({operation:'check_regression',input:{...f.request,
      receipt:sdk.createRegressionReceipt(input),observations:input.observations}});
  }
  const actual=await parity(t,requests);if(actual)assert(actual.every(value=>value.result.status==='deny'));
});

test('Python callers record actual paired inputs through scope and saved backtracking follows them',async t=>{
  const f=fixture(),result=await run(t,f,String.raw`
with capture:
    with capture.stage('paired-evaluations') as scope:
        scope['declaredComparison']=payload['manifest'];scope['pairedScores']=payload['observations'];scope['candidate']=payload['request']['modelRef']
    with capture.stage('record-regression') as scope:
        scope['regressionReceipt']=capture.create_regression_receipt(dict(regressionId='from-scope',createdAt=payload['input']['createdAt'],
          manifest=scope['declaredComparison'],observations=scope['pairedScores']))
    with capture.stage('check-regression') as scope:
        scope['regressionDecision']=capture.check_regression(dict(receipt=scope['regressionReceipt'],manifest=scope['declaredComparison'],
          observations=scope['pairedScores'],modelRef=scope['candidate'],now=payload['request']['now']))
print(json.dumps(dict(closed=True)))
`);
  if(!result)return;assert.equal(result.recording.snapshot.sharedState.regressionDecision.status,'deny');
  const session=openWorkflowRecording(result.recording,{openRecording,traceToolpack,callTraceTool});
  const answer=await session.backtrack('regressionDecision');
  for(const stage of ['paired-evaluations#0','record-regression#1','check-regression#2'])assert(answer.result.includes(stage),answer.result);
});
