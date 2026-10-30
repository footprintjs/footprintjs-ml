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
const artifact=digit=>({kind:'artifact',path:`synthetic-monitoring/${digit}.json`,sha256:digit.repeat(64),bytes:128,format:'synthetic/monitoring-v1'});
const model=digit=>({kind:'model',sessionId:'synthetic-production-worker',handle:parseInt(digit,16),originArtifact:artifact(digit),
  inferenceIdentity:{kind:'inference-identity',schemaVersion:1,profile:'synthetic/monitored-predictor-v1',sha256:digit.repeat(64)}});
function fixture(){
  const modelRef=model('3'),publicationRef=artifact('2'),inputRef=artifact('5'),membershipRef=artifact('6'),outputRef=artifact('7'),labelRef=artifact('8');
  const contract=sdk.createPredictionContract({profile:'synthetic/tabular-v1',input:{fields:[{name:'x',dtype:'float64'}]},
    output:{fields:[{name:'prediction',dtype:'float64'}]},preprocessingVersion:'raw/v1',parameters:{}});
  const evaluation={preprocessingVersion:'raw/v1',evaluationMethodVersion:'held-out-mse/v1',parameters:{}};
  const deployment={targetName:'production',revision:'1'.repeat(64),modelRef,publicationRef};
  const window={windowId:'production-window-17',startAt:NOW-1000,endAt:NOW-500,inputRef,membershipRef,expectedRows:4,inferenceId:'window-inference-17'};
  const manifest={kind:'monitoring-manifest',schemaVersion:1,monitorId:'synthetic-production-health',deployment,window,contract,
    labelSource:{name:'measured-outcomes',version:'v1'},joinMode:'row-id-window-time/v1',evaluation,
    policy:{metric:'mse',operator:'lte',threshold:0.1,minSamples:3,minCoverage:0.75,maxAgeMs:100}};
  const joinedDatasetRef={kind:'dataset',sessionId:modelRef.sessionId,handle:100,role:'production-evaluation',rows:4,shape:[4,1],artifact:artifact('9')};
  const observation={deployment:{...deployment,observedAt:NOW-1001},
    window:{windowId:window.windowId,startAt:window.startAt,endAt:window.endAt,inputRef,membershipRef,rows:4,closedAt:NOW-499},
    prediction:sdk.createInferenceReceipt({inferenceId:window.inferenceId,createdAt:NOW-501,inputRef,outputRef,inputRows:4,outputRows:4,modelRef,contract}),
    labels:{batchId:'delayed-labels-17',windowId:window.windowId,source:manifest.labelSource,labelRef,availableAt:NOW-100},
    join:{joinMode:'row-id-window-time/v1',joinRef:artifact('b'),windowId:window.windowId,inputRef,outputRef,labelRef,membershipRef,joinedDatasetRef,
      matchedRows:4,missingRows:0,duplicateRows:0,unmatchedRows:0,crossWindowRows:0,createdAt:NOW-50},
    evaluation:sdk.createEvaluationReceipt({evaluationId:'production-evaluation-17',createdAt:NOW-40,modelRef,datasetRef:joinedDatasetRef,...evaluation,metrics:{mse:0.02}})};
  const input={monitoringId:'monitor-window-17',createdAt:NOW-10,manifest,observation},receipt=sdk.createMonitoringReceipt(input);
  return{manifest,observation,input,receipt,request:{receipt,manifest,observation,now:NOW}};
}
const methods={read_monitoring_manifest:()=>sdk.readMonitoringManifest,create_monitoring_receipt:()=>sdk.createMonitoringReceipt,
  read_monitoring_receipt:()=>sdk.readMonitoringReceipt,check_monitoring:()=>sdk.checkMonitoring};
const direct=({operation,input})=>{try{return{ok:true,result:methods[operation]()(input)};}
  catch(error){return{ok:false,error:{code:error.code??'capture',message:error.message}};}};
async function run(t,payload,body){
  const root=await mkdtemp(resolve(tmpdir(),'footprint-python-monitoring-'));t.after(()=>rm(root,{recursive:true,force:true}));
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
function check(f,mutate){
  const input=clone(f.input);mutate(input);
  return{operation:'check_monitoring',input:{receipt:sdk.createMonitoringReceipt(input),manifest:f.manifest,observation:input.observation,now:NOW}};
}

test('Python monitoring methods preserve native JSON and return healthy/degraded recommendations without effects',async t=>{
  const f=fixture(),requests=[{operation:'read_monitoring_manifest',input:f.manifest},{operation:'create_monitoring_receipt',input:f.input},
    {operation:'read_monitoring_receipt',input:f.receipt},{operation:'check_monitoring',input:f.request},
    check(f,input=>{input.observation.evaluation.metrics.mse=0.2;})];
  const actual=await parity(t,requests);if(!actual)return;
  assert(actual.every(value=>value.ok));assert.equal(actual[3].result.allowed,true);
  assert.equal(actual[3].result.health,'healthy');assert.equal(actual[3].result.recommendation,'none');
  assert.equal(actual[4].result.status,'deny');assert.equal(actual[4].result.health,'degraded');assert.equal(actual[4].result.recommendation,'review');
});

test('Pending labels/low coverage remain unknown while wrong revision/window/model and bad joins deny',async t=>{
  const f=fixture(),requests=[
    check(f,input=>{delete input.observation.labels;delete input.observation.join;delete input.observation.evaluation;}),
    check(f,input=>{input.observation.join.matchedRows=2;input.observation.join.missingRows=2;
      input.observation.join.joinedDatasetRef.rows=2;input.observation.join.joinedDatasetRef.shape=[2,1];delete input.observation.evaluation;}),
    check(f,input=>{input.observation.deployment.revision='a'.repeat(64);delete input.observation.labels;delete input.observation.join;delete input.observation.evaluation;}),
    check(f,input=>{input.observation.window.windowId='another-window';}),
    check(f,input=>{input.observation.deployment.modelRef=model('a');}),
    check(f,input=>{input.observation.join.labelRef=artifact('a');}),
    check(f,input=>{input.observation.join.duplicateRows=1;}),
    check(f,input=>{input.observation.join.unmatchedRows=1;delete input.observation.labels;}),
    check(f,input=>{input.observation.join.crossWindowRows=1;delete input.observation.labels;}),
    check(f,input=>{input.observation.deployment.observedAt=input.observation.prediction.createdAt+1;})];
  const actual=await parity(t,requests);if(!actual)return;
  assert.deepEqual(actual.slice(0,2).map(value=>value.result.status),['unknown','unknown']);
  for(const value of actual.slice(0,2)){assert.equal(value.result.health,null);assert.equal(value.result.recommendation,'wait');}
  for(const value of actual.slice(2)){assert.equal(value.result.status,'deny');assert.equal(value.result.health,null);assert.equal(value.result.recommendation,'review-evidence');}
});

test('Monitoring cannot borrow another independent observation or refresh an expired evaluation',async t=>{
  const f=fixture(),changed=clone(f.request);changed.observation.evaluation.metrics.mse=0.01;
  const missing=clone(f.request);delete missing.observation;
  const requests=[{operation:'check_monitoring',input:changed},{operation:'check_monitoring',input:missing},
    check(f,input=>{input.observation.labels.availableAt=NOW-200;input.observation.join.createdAt=NOW-150;
      input.observation.evaluation.createdAt=NOW-101;}),
    check(f,input=>{delete input.observation.labels;input.observation.join.createdAt=NOW-150;
      input.observation.evaluation.createdAt=NOW-101;}),
    {operation:'read_monitoring_manifest',input:{...f.manifest,unexpected:true}},
    {operation:'read_monitoring_receipt',input:{...f.receipt,schemaVersion:99}}];
  const actual=await parity(t,requests);if(!actual)return;
  assert.equal(actual[0].result.status,'deny');assert.equal(actual[1].result.status,'unknown');
  assert.equal(actual[2].result.allowed,false);assert.equal(actual[2].result.health,null);
  assert.equal(actual[3].result.status,'deny');assert.equal(actual[3].result.health,null);assert.equal(actual[3].result.recommendation,'review-evidence');
  assert(actual.slice(4).every(value=>value.ok===false));
});

test('Saved native backtracking follows consumed monitoring revision, window, join and performance evidence',async t=>{
  const f=fixture(),result=await run(t,f,String.raw`
with capture:
    with capture.stage('monitoring-requirements') as scope:scope['monitoringManifest']=payload['manifest']
    with capture.stage('observe-production-window') as scope:scope['windowObservation']=payload['observation']
    with capture.stage('retain-monitoring-evidence') as scope:
        scope['monitoringReceipt']=capture.create_monitoring_receipt(dict(monitoringId='observed-window',createdAt=payload['input']['createdAt'],
          manifest=scope['monitoringManifest'],observation=scope['windowObservation']))
    with capture.stage('check-production-health') as scope:
        scope['monitoringDecision']=capture.check_monitoring(dict(receipt=scope['monitoringReceipt'],manifest=scope['monitoringManifest'],
          observation=scope['windowObservation'],now=payload['request']['now']))
print(json.dumps(dict(closed=True)))
`);
  if(!result)return;assert.equal(result.recording.snapshot.sharedState.monitoringDecision.health,'healthy');
  const session=openWorkflowRecording(result.recording,{openRecording,traceToolpack,callTraceTool});
  const answer=await session.backtrack('monitoringDecision');
  for(const stage of ['monitoring-requirements#0','observe-production-window#1','retain-monitoring-evidence#2','check-production-health#3'])
    assert(answer.result.includes(stage),answer.result);
});
