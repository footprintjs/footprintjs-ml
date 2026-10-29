import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import * as sdk from '../dist/index.js';
import {openRecording,traceToolpack,callTraceTool} from 'agentfootprint/observe';
import {openWorkflowRecording} from '../lens/session.mjs';

// These are wire-contract fixtures, not trained models or numerical predictions.
const NOW=1_800_000_000_000;
const artifact=letter=>({kind:'artifact',path:`fixture-${letter}.json`,sha256:letter.repeat(64),bytes:100,format:'protocol-fixture/v1'});
const model=letter=>({kind:'model',sessionId:'inference-protocol',handle:letter==='a'?1:2,originArtifact:artifact(letter),
  inferenceIdentity:{kind:'inference-identity',schemaVersion:1,profile:'protocol-fixture/v1',sha256:letter.repeat(64)}});
const contractInput={profile:'protocol-table/v1',input:{fields:[{name:'age',dtype:'float64',unit:'years'},{name:'amount',dtype:'float64',unit:'USD'}]},
 output:{fields:[{name:'label',dtype:'int64',unit:'class-index'}]},preprocessingVersion:'fixture-v1',classLabels:[0,1]};
function fixtures(){
 const contract=sdk.createPredictionContract(contractInput);
 const input={inferenceId:'request-1',createdAt:NOW,inputRef:artifact('c'),outputRef:artifact('d'),inputRows:2,outputRows:2,modelRef:model('a'),contract};
 const receipt=sdk.createInferenceReceipt(input);
 return {contract,input,receipt,request:{receipt,modelRef:model('a'),contract,inputRef:artifact('c'),rows:2,inferenceId:'request-1',now:NOW+1}};
}
const methods={create_prediction_contract:sdk.createPredictionContract,read_prediction_contract:sdk.readPredictionContract,
 create_inference_receipt:sdk.createInferenceReceipt,read_inference_receipt:sdk.readInferenceReceipt,check_inference:sdk.checkInference};
const pythonRoot=fileURLToPath(new URL('../python',import.meta.url));
const worker=fileURLToPath(new URL('../dist/adapter/capture-worker.js',import.meta.url));
const header=String.raw`
import json,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from footprint_ml_workflow import WorkflowCapture,CaptureError
payload=json.loads(Path(sys.argv[4]).read_text())
capture=WorkflowCapture(sys.argv[5],command=[sys.argv[2],sys.argv[3]])
`;
async function pythonRun(t,payload,body){
 const root=await mkdtemp(resolve(tmpdir(),'footprint-inference-wire-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const input=resolve(root,'input.json'),recording=resolve(root,'recording.json');await writeFile(input,JSON.stringify(payload));
 const result=spawnSync(process.env.TEST_PYTHON??'python3',['-I','-S','-c',header+'\n'+body,pythonRoot,process.execPath,worker,input,recording],
   {encoding:'utf8',timeout:20000,maxBuffer:4*1024*1024});
 if(result.error?.code==='ENOENT'){t.skip('Python is unavailable');return;}
 assert.equal(result.status,0,result.stderr||result.stdout||String(result.error));
 return {result:JSON.parse(result.stdout),recording:JSON.parse(await readFile(recording,'utf8'))};
}

test('all five Python inference methods preserve exact native JSON and constructor errors without inventing history',async t=>{
 const f=fixtures(),requests=[
  {operation:'create_prediction_contract',input:contractInput},{operation:'read_prediction_contract',input:f.contract},
  {operation:'create_inference_receipt',input:f.input},{operation:'read_inference_receipt',input:f.receipt},
  {operation:'check_inference',input:f.request},{operation:'read_inference_receipt',input:{...f.receipt,schemaVersion:99}},
  {operation:'create_prediction_contract',input:{...contractInput,input:{fields:[]}}},
 ];
 const value=await pythonRun(t,requests,String.raw`
answers=[]
with capture:
    for request in payload:
        try:answers.append(dict(ok=True,result=getattr(capture,request['operation'])(request['input'])))
        except CaptureError as error:answers.append(dict(ok=False,error=dict(code=error.code,message=str(error))))
    assert capture.snapshot()['snapshot']['sharedState']=={}
print(json.dumps(answers,allow_nan=False))
`);
 if(!value)return;
 assert.deepEqual(value.result,requests.map(({operation,input})=>{
  try{return {ok:true,result:methods[operation](input)};}catch(error){return {ok:false,error:{code:error.code??'capture',message:error.message}};}
 }));
 assert.equal(value.result[4].result.allowed,true);assert.deepEqual(value.recording.snapshot.commitLog,[]);
});

test('Python and native inference guards agree on stale cache, field order, missing evidence and invocation/input binding',async t=>{
 const f=fixtures(),changed=modify=>{const value=structuredClone(f.request);modify(value);return value;};
 const requests=[f.request,
  changed(value=>{value.receipt.modelRef=model('b');}),
  changed(value=>{value.receipt.contract.input.fields.reverse();}),
  changed(value=>{delete value.receipt.modelRef;delete value.receipt.contract;}),
  changed(value=>{value.receipt.modelRef=model('b');delete value.receipt.contract;}),
  changed(value=>{value.inferenceId='different-request';}),
  changed(value=>{value.inputRef.sha256='e'.repeat(64);}),
  changed(value=>{value.receipt.outputRows=1;}),
  changed(value=>{value.maxAgeMs=0;}),
 ];
 const value=await pythonRun(t,requests,String.raw`
with capture:
    answers=[capture.check_inference(request) for request in payload]
print(json.dumps(answers,allow_nan=False))
`);
 if(!value)return;
 assert.deepEqual(value.result,requests.map(request=>sdk.checkInference(request)));
 assert.deepEqual(value.result.map(row=>row.status),['allow','deny','deny','unknown','deny','deny','deny','deny','deny']);
 assert.deepEqual(value.recording.snapshot.commitLog,[]);
});

test('native saved backtracking follows the actual cached model, independently approved model and observed receipt',async t=>{
 const f=fixtures();
 const value=await pythonRun(t,{...f,modelA:model('a'),modelB:model('b')},String.raw`
with capture:
    with capture.stage('approve-a') as scope:
        scope['approvedModel']=payload['modelA'];scope['expectedContract']=payload['contract'];scope['inputRef']=payload['input']['inputRef']
    with capture.stage('cache-b') as scope:scope['cachedModel']=payload['modelB']
    with capture.stage('observe-wrong-inference') as scope:
        observed=dict(payload['input'],modelRef=scope['cachedModel'],contract=scope['expectedContract'],inputRef=scope['inputRef'])
        scope['wrongReceipt']=capture.create_inference_receipt(observed)
    with capture.stage('check-wrong-inference') as scope:
        scope['wrongDecision']=capture.check_inference(dict(payload['request'],receipt=scope['wrongReceipt'],modelRef=scope['approvedModel'],contract=scope['expectedContract'],inputRef=scope['inputRef']))
    with capture.stage('repair-cache') as scope:scope['cachedModel']=scope['approvedModel']
    with capture.stage('observe-corrected-inference') as scope:
        observed=dict(payload['input'],modelRef=scope['cachedModel'],contract=scope['expectedContract'],inputRef=scope['inputRef'])
        scope['correctedReceipt']=capture.create_inference_receipt(observed)
    with capture.stage('check-corrected-inference') as scope:
        scope['correctedDecision']=capture.check_inference(dict(payload['request'],receipt=scope['correctedReceipt'],modelRef=scope['approvedModel'],contract=scope['expectedContract'],inputRef=scope['inputRef']))
    snapshot=capture.snapshot()
print(json.dumps(dict(wrong=snapshot['snapshot']['sharedState']['wrongDecision']['status'],corrected=snapshot['snapshot']['sharedState']['correctedDecision']['status'])))
`);
 if(!value)return;
 assert.deepEqual(value.result,{wrong:'deny',corrected:'allow'});
 const session=openWorkflowRecording(value.recording,{openRecording,traceToolpack,callTraceTool});
 const chain=(await session.backtrack('wrongDecision',{maxDepth:12,maxNodes:60})).result;
 for(const stage of ['approve-a#0','cache-b#1','observe-wrong-inference#2','check-wrong-inference#3'])assert(chain.includes(stage));
 for(const stage of ['repair-cache#4','observe-corrected-inference#5','check-corrected-inference#6'])assert(!chain.includes(stage));
 assert(chain.includes('control edges unavailable'));
});
