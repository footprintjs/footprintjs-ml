import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {Readable,Writable} from 'node:stream';
import * as sdk from '../dist/index.js';
import {servePythonCapture} from '../dist/adapter/index.js';
import {openRecording,traceToolpack,callTraceTool} from 'agentfootprint/observe';
import {openWorkflowRecording} from '../lens/session.mjs';

const worker=fileURLToPath(new URL('../dist/adapter/capture-worker.js',import.meta.url));
const pythonRoot=fileURLToPath(new URL('../python',import.meta.url));
const python=process.env.TEST_PYTHON??'python3';
const NOW=1_800_000_000_000;
const clone=value=>structuredClone(value);
const artifact=digit=>({kind:'artifact',path:`fixtures/${digit}.json`,sha256:digit.repeat(64),bytes:128,format:'protocol-fixture/v1'});
const model=digit=>({kind:'model',sessionId:'contract-fixture',handle:parseInt(digit,16),originArtifact:artifact(digit),
  inferenceIdentity:{kind:'inference-identity',schemaVersion:1,profile:'fixture-complete-predictor/v1',sha256:digit.repeat(64)}});
const dataset=(digit,role)=>({kind:'dataset',sessionId:'contract-fixture',handle:parseInt(digit,16),artifact:artifact(digit),rows:20,shape:[20,2],role});
function fixtures(){
  const training=dataset('a','train'),validation=dataset('b','validation');
  const comparison={datasetRef:validation,preprocessingVersion:'measured-scaler/v1',evaluationMethodVersion:'fixture-mse/v1',parameters:{units:'original'}};
  const manifest={kind:'selection-manifest',schemaVersion:1,experimentId:'python-bridge-parity',
    candidates:[{candidateId:'candidate-b',configuration:{updates:60}},{candidateId:'candidate-a',configuration:{updates:30}}],
    comparison,policy:{metric:'mse',direction:'min',tieBreak:'candidate-id-ascending'}};
  const results=manifest.candidates.map((candidate,index)=>{
    const modelRef=model(index===0?'1':'2');
    return {...candidate,modelRef,evaluation:sdk.createEvaluationReceipt({evaluationId:`evaluation-${candidate.candidateId}`,createdAt:NOW,
      modelRef,...comparison,metrics:{mse:index===0?0.01:0.05}})};
  });
  const selectionInput={selectionId:'selection-1',createdAt:NOW+10,manifest,results};
  const selection=sdk.createSelectionReceipt(selectionInput);
  const selectionRequest={receipt:selection,manifest,results,modelRef:results[0].modelRef,now:NOW+20};
  const lineageInput={lineageId:'lineage-1',createdAt:NOW,modelRef:results[0].modelRef,datasetRef:validation,
    splitManifest:artifact('c'),trainingDatasetRef:training,
    overlap:{evidenceArtifact:artifact('d'),trainEvaluationRows:0,preprocessingEvaluationRows:0},
    preprocessing:{artifact:artifact('e'),fitDatasetRefs:[training]}};
  const lineage=sdk.createDataLineageReceipt(lineageInput);
  const lineageRequest={receipt:lineage,modelRef:lineage.modelRef,datasetRef:validation,splitManifest:lineage.splitManifest,
    policy:{trainingDatasetRef:training}};
  return {training,validation,comparison,manifest,results,selectionInput,selection,selectionRequest,lineageInput,lineage,lineageRequest};
}
const methods={create_evaluation_receipt:sdk.createEvaluationReceipt,read_evaluation_receipt:sdk.readEvaluationReceipt,
  create_data_lineage_receipt:sdk.createDataLineageReceipt,read_data_lineage_receipt:sdk.readDataLineageReceipt,check_data_lineage:sdk.checkDataLineage,
  read_selection_manifest:sdk.readSelectionManifest,create_selection_receipt:sdk.createSelectionReceipt,
  read_selection_receipt:sdk.readSelectionReceipt,check_selection:sdk.checkSelection};
const outcome=({operation,input})=>{
  try{return {ok:true,result:methods[operation](input)};}
  catch(error){return {ok:false,error:{code:error.code??'capture',message:error.message}};}
};
const pythonHeader=String.raw`
import json, sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from footprint_ml_workflow import WorkflowCapture, CaptureError
payload=json.loads(Path(sys.argv[4]).read_text())
capture=WorkflowCapture(sys.argv[5],command=[sys.argv[2],sys.argv[3]])
`;
async function runPython(t,payload,body){
  const root=await mkdtemp(resolve(tmpdir(),'footprint-python-contracts-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const input=resolve(root,'input.json'),recording=resolve(root,'recording.json');
  await writeFile(input,JSON.stringify(payload));
  const result=spawnSync(python,['-I','-S','-c',pythonHeader+'\n'+body,pythonRoot,process.execPath,worker,input,recording],
    {encoding:'utf8',timeout:20000,maxBuffer:5*1024*1024});
  if(result.error?.code==='ENOENT'){t.skip('Python is unavailable.');return;}
  assert.equal(result.status,0,result.stderr||result.stdout||String(result.error));
  return {result:JSON.parse(result.stdout),recording:JSON.parse(await readFile(recording,'utf8'))};
}
async function parity(t,requests){
  const result=await runPython(t,requests,String.raw`
answers=[]
with capture:
    for request in payload:
        try:
            answers.append(dict(ok=True,result=getattr(capture,request['operation'])(request['input'])))
        except CaptureError as error:
            answers.append(dict(ok=False,error=dict(code=error.code,message=str(error))))
    # Contract helpers do not invent scope reads or writes, even when a guard denies.
    assert capture.snapshot()['snapshot']['commitLog']==[]
    assert capture.snapshot()['snapshot']['sharedState']=={}
print(json.dumps(answers,allow_nan=False))
`);
  if(!result)return;
  assert.deepEqual(result.result,requests.map(outcome));
  assert.deepEqual(result.recording.snapshot.commitLog,[]);
  assert.equal(result.recording.supplemental.pythonCapture.lifecycle,'closed');
  return result.result;
}

test('Python receipt and manifest calls return the exact native TypeScript JSON, with no automatic commits',async t=>{
  const f=fixtures(),evaluationInput={evaluationId:'python-evaluation',createdAt:NOW,modelRef:f.results[0].modelRef,...f.comparison,metrics:{mse:0.01}};
  const requests=[
    {operation:'create_evaluation_receipt',input:evaluationInput},
    {operation:'read_evaluation_receipt',input:sdk.createEvaluationReceipt(evaluationInput)},
    {operation:'create_data_lineage_receipt',input:f.lineageInput},
    {operation:'read_data_lineage_receipt',input:clone(f.lineage)},
    {operation:'check_data_lineage',input:f.lineageRequest},
    {operation:'read_selection_manifest',input:f.manifest},
    {operation:'create_selection_receipt',input:f.selectionInput},
    {operation:'read_selection_receipt',input:clone(f.selection)},
    {operation:'check_selection',input:f.selectionRequest},
  ];
  const actual=await parity(t,requests);
  if(!actual)return;
  assert.equal(actual[4].result.allowed,true);assert.equal(actual[8].result.allowed,true);
  assert.equal(actual[6].result.selectedCandidateId,'candidate-b');
  assert.deepEqual(actual[5].result.candidates.map(candidate=>candidate.candidateId),['candidate-a','candidate-b']);
});

test('Python lineage guards preserve native deny and unknown semantics for actual fit use and independent policy',async t=>{
  const f=fixtures();
  const changed=(mutate)=>{const value=clone(f.lineageRequest);mutate(value);return value;};
  const requests=[
    {operation:'check_data_lineage',input:changed(value=>{value.receipt.preprocessing.fitDatasetRefs.push(clone(f.validation));})},
    {operation:'check_data_lineage',input:changed(value=>{delete value.receipt.overlap;})},
    {operation:'check_data_lineage',input:changed(value=>{value.receipt.overlap.trainEvaluationRows=1;delete value.receipt.preprocessing;})},
    {operation:'check_data_lineage',input:changed(value=>{value.policy.trainingDatasetRef.artifact.sha256='f'.repeat(64);})},
    {operation:'check_data_lineage',input:changed(value=>{value.modelRef=model('3');})},
    {operation:'check_data_lineage',input:changed(value=>{delete value.receipt;})},
    {operation:'check_data_lineage',input:changed(value=>{value.receipt.schemaVersion=99;})},
    {operation:'check_data_lineage',input:null},
    {operation:'read_data_lineage_receipt',input:{...clone(f.lineage),schemaVersion:99}},
    {operation:'create_data_lineage_receipt',input:{...clone(f.lineageInput),overlap:{trainEvaluationRows:0}}},
    {operation:'read_evaluation_receipt',input:{...clone(f.results[0].evaluation),schemaVersion:99}},
  ];
  const actual=await parity(t,requests);
  if(!actual)return;
  assert.deepEqual(actual.slice(0,8).map(item=>item.result.status),['deny','unknown','deny','deny','deny','unknown','unknown','unknown']);
  assert.ok(actual[0].result.reasons.some(reason=>reason.code==='preprocessing-fit-dataset-unauthorized'));
  assert.ok(actual[1].result.reasons.some(reason=>reason.code==='overlap-evidence-unavailable'));
  assert.ok(actual.slice(8).every(item=>item.ok===false));
});

test('Python selection guards retain independent declaration and source observations in both policy directions',async t=>{
  const f=fixtures(),requests=[];
  for(const direction of ['min','max']){
    const declared=clone(f.selectionInput);declared.manifest.policy.direction=direction;
    const receipt=sdk.createSelectionReceipt(declared),winner=declared.results.find(result=>result.candidateId===receipt.selectedCandidateId);
    const request={receipt,manifest:declared.manifest,results:declared.results,modelRef:winner.modelRef,now:NOW+20};
    requests.push({operation:'check_selection',input:request});
    const changed=clone(declared);changed.manifest.policy.direction=direction==='min'?'max':'min';
    const rewritten=sdk.createSelectionReceipt(changed);
    requests.push({operation:'check_selection',input:{...request,receipt:rewritten,modelRef:rewritten.selectedModelRef}});
    const fabricated=clone(declared);fabricated.results[0].evaluation.metrics.mse=0.5;
    const rewrittenObservations=sdk.createSelectionReceipt(fabricated);
    requests.push({operation:'check_selection',input:{...request,receipt:rewrittenObservations,modelRef:rewrittenObservations.selectedModelRef}});
  }
  const stale=clone(f.selectionRequest);stale.modelRef=model('3');
  const missing=clone(f.selectionRequest);delete missing.results;
  const malformed=clone(f.selectionRequest);malformed.receipt.schemaVersion=99;
  const future=clone(f.selectionRequest);future.receipt.createdAt=NOW+100;
  requests.push({operation:'check_selection',input:stale},{operation:'check_selection',input:missing},
    {operation:'check_selection',input:malformed},{operation:'check_selection',input:future},
    {operation:'check_selection',input:null},
    {operation:'read_selection_manifest',input:{...clone(f.manifest),schemaVersion:99}},
    {operation:'create_selection_receipt',input:{...clone(f.selectionInput),results:f.results.slice(0,1)}},
    {operation:'read_selection_receipt',input:{...clone(f.selection),selectedCandidateId:'invented-winner'}});
  const actual=await parity(t,requests);
  if(!actual)return;
  assert.deepEqual(actual.slice(0,11).map(item=>item.result.status),['allow','deny','deny','allow','deny','deny','deny','unknown','unknown','deny','unknown']);
  for(const index of [1,4])assert.ok(actual[index].result.reasons.some(reason=>reason.code==='selection-policy-mismatch'));
  for(const index of [2,5])assert.ok(actual[index].result.reasons.some(reason=>reason.code==='selection-results-mismatch'));
  assert.ok(actual.slice(11).every(item=>item.ok===false));
});

test('Python consumes real scope inputs and records native lineage/selection decision dependencies',async t=>{
  const f=fixtures();
  const actual=await runPython(t,f,String.raw`
with capture:
    with capture.stage('observations') as scope:
        scope['lineageInput']=payload['lineageInput']
        scope['lineageAuthority']={key:payload['lineageRequest'][key] for key in ['modelRef','datasetRef','splitManifest','policy']}
        scope['selectionInput']=payload['selectionInput']
        scope['selectionAuthority']={key:payload['selectionRequest'][key] for key in ['manifest','results','modelRef','now']}
    with capture.stage('receipt-construction') as scope:
        scope['lineageReceipt']=capture.create_data_lineage_receipt(scope['lineageInput'])
        scope['selectionReceipt']=capture.create_selection_receipt(scope['selectionInput'])
    with capture.stage('decision') as scope:
        scope['lineageDecision']=capture.check_data_lineage(dict(scope['lineageAuthority'],receipt=scope['lineageReceipt']))
        scope['selectionDecision']=capture.check_selection(dict(scope['selectionAuthority'],receipt=scope['selectionReceipt']))
    snapshot=capture.snapshot()
    assert snapshot['snapshot']['sharedState']['lineageDecision']['allowed'] is True
    assert snapshot['snapshot']['sharedState']['selectionDecision']['allowed'] is True
print(json.dumps(dict(commits=len(snapshot['snapshot']['commitLog']))))
`);
  if(!actual)return;
  assert.equal(actual.result.commits,3);
  const log=actual.recording.snapshot.commitLog;
  const receipts=log[1].trace,decisions=log[2].trace;
  assert.ok(receipts.find(row=>row.path==='lineageReceipt').readKeys.includes('lineageInput'));
  assert.ok(receipts.find(row=>row.path==='selectionReceipt').readKeys.includes('selectionInput'));
  assert.ok(decisions.find(row=>row.path==='lineageDecision').readKeys.includes('lineageReceipt'));
  assert.ok(decisions.find(row=>row.path==='selectionDecision').readKeys.includes('selectionAuthority'));
  const session=openWorkflowRecording(actual.recording,{openRecording,traceToolpack,callTraceTool});
  const answer=await session.backtrack('selectionDecision');
  for(const id of ['observations#0','receipt-construction#1','decision#2'])assert.ok(answer.result.includes(id),answer.result);
  assert.match(answer.result,/control edges unavailable/);
});

test('new contract operations preserve strict protocol fields, JSON limits and existing committed state',async t=>{
  const root=await mkdtemp(resolve(tmpdir(),'footprint-contract-protocol-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const path=resolve(root,'recording.json');
  const requests=[{id:1,op:'check_selection',input:{}},{id:2,op:'open',path,runId:'contract-protocol'},
    {id:3,op:'begin',stageId:'seed'},{id:4,op:'set',key:'stable',value:7},{id:5,op:'commit'},
    {id:6,op:'check_data_lineage',input:{},invented:true},
    {id:7,op:'create_selection_receipt'},
    {id:8,op:'read_selection_manifest',input:'x'.repeat(5000)},
    {id:9,op:'check_selection',input:{}},{id:10,op:'snapshot'},{id:11,op:'close'}];
  let output='';
  await servePythonCapture({maxPacketBytes:4096,input:Readable.from(requests.map(request=>JSON.stringify(request)+'\n')),
    output:new Writable({write(chunk,encoding,callback){output+=chunk.toString();callback();}})});
  const responses=output.trim().split('\n').map(line=>JSON.parse(line));
  for(const [id,code] of [[1,'state'],[6,'protocol'],[null,'limit']])assert.equal(responses.find(response=>response.id===id).error.code,code);
  assert.equal(responses.find(response=>response.id===7).ok,false);
  assert.equal(responses.find(response=>response.id===9).result.status,'unknown');
  const saved=JSON.parse(await readFile(path,'utf8'));
  assert.deepEqual(saved.snapshot.sharedState,{stable:7});assert.equal(saved.snapshot.commitLog.length,1);
});
