import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {Readable,Writable} from 'node:stream';
import * as moduleApi from 'node:module';
import {openRecording,traceToolpack,callTraceTool} from 'agentfootprint/observe';
import {stateAt} from 'foottrace';
import {openWorkflowRecording} from '../lens/session.mjs';
import {servePythonCapture} from '../dist/adapter/index.js';

const worker=fileURLToPath(new URL('../dist/adapter/capture-worker.js',import.meta.url));
const python=process.env.TEST_PYTHON??'python3';
const header=String.raw`
import json, subprocess, sys
child=subprocess.Popen([sys.argv[1],sys.argv[2]],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
counter=0
def raw(line):
    child.stdin.write(line+'\n');child.stdin.flush()
    result=child.stdout.readline()
    assert result, child.stderr.read()
    return json.loads(result)
def request(op,**fields):
    global counter
    counter+=1
    result=raw(json.dumps(dict(id=counter,op=op,**fields),allow_nan=False))
    assert result['id']==counter,result
    return result
def ask(op,**fields):
    result=request(op,**fields)
    assert result['ok'],result
    return result['result']
def begin(stage,**fields):return ask('begin',stageId=stage,**fields)
def get(key):
    result=ask('get',key=key)
    assert result['present'],key
    return result['value']
def put(key,value):return ask('set',key=key,value=value)
def finish():
    child.stdin.close()
    assert child.wait(timeout=5)==0,child.stderr.read()
`;
async function runPython(t,body){
 const root=await mkdtemp(resolve(tmpdir(),'footprint-python-capture-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const path=resolve(root,'recording.json');
 const result=spawnSync(python,['-I','-S','-c',header+'\n'+body,process.execPath,worker,path],{encoding:'utf8',timeout:20000,maxBuffer:3*1024*1024});
 if(result.error?.code==='ENOENT'){t.skip('Python is unavailable.');return;}
 assert.equal(result.status,0,result.stderr||result.stdout||String(result.error));
 return {root,path,recording:JSON.parse(await readFile(path,'utf8')),stdout:result.stdout};
}

test('stdlib Python drives native live stage reads, failure discard, retry and existing release guards',async t=>{
 const result=await runPython(t,String.raw`
ask('open',path=sys.argv[3],runId='python-native-proof')
artifact=lambda digit:dict(kind='artifact',path='model-'+digit+'.npz',sha256=digit*64,bytes=1,format='protocol-fixture')
model=lambda digit:dict(kind='model',sessionId='python-fixture',handle=int(digit),originArtifact=artifact(digit),inferenceIdentity=dict(kind='inference-identity',schemaVersion=1,profile='protocol-fixture/v1',sha256=digit*64))
dataset=dict(kind='dataset',sessionId='python-fixture',handle=10,artifact=artifact('9'),rows=4,shape=[4,1],role='validation')
begin('inputs');put('datasetRef',dataset);put('policy',dict(metric='accuracy',operator='gte',threshold=0.9));put('parameters',{});ask('commit')
begin('train-a');put('modelRef',model('1'));ask('commit')
def evaluate(stage,score):
    begin(stage)
    observed=dict(evaluationId=stage,createdAt=1000,modelRef=get('modelRef'),datasetRef=get('datasetRef'),preprocessingVersion='scale-v1',evaluationMethodVersion='holdout-v1',parameters=get('parameters'),metrics=dict(accuracy=score))
    receipt=ask('create_evaluation_receipt',input=observed)
    assert receipt['schemaVersion']==2
    put('evaluationReceipt',receipt);ask('commit')
evaluate('evaluate-a',0.91)
failed=begin('train-b',attempt=1);get('modelRef');put('modelRef',model('3'))
ask('discard',error=dict(type='TrainingInterrupted',message='Intentional fixture failure'))
retry=begin('train-b',attempt=2,retryOf=failed['runtimeStageId'])
assert retry['runtimeStageId']!=failed['runtimeStageId']
assert get('modelRef')['handle']==1
put('modelRef',model('2'));ask('commit')
def guard(stage):
    begin(stage)
    operands=dict(modelRef=get('modelRef'),receipt=get('evaluationReceipt'),datasetRef=get('datasetRef'),parameters=get('parameters'),policy=get('policy'),preprocessingVersion='scale-v1',evaluationMethodVersion='holdout-v1',now=1000)
    decision=ask('check_release',input=operands)
    put('releaseDecision',decision);ask('commit');return decision
assert guard('guard-stale')['allowed']==False
evaluate('evaluate-b',0.93)
assert guard('guard-fresh')['allowed']==True
snapshot=ask('snapshot');assert snapshot['producer']['kind']=='python-orchestrator/native-foottrace-writer'
closed=ask('close');assert closed['commits']==7
finish()
`);
 if(!result)return;
 const {recording}=result,snapshot=recording.snapshot;
 assert.equal(recording.supplemental.pythonCapture.lifecycle,'closed');
 assert.equal(snapshot.commitLog.length,7);assert.equal(snapshot.sharedState.modelRef.handle,2);
 assert.equal(snapshot.sharedState.releaseDecision.allowed,true);
 assert.deepEqual(stateAt(snapshot,snapshot.commitLog.length-1).state,snapshot.sharedState);
 assert.ok(snapshot.commitLog.every(commit=>!commit.trace.some(row=>row.path==='modelRef'&&commit.overwrite.modelRef?.handle===3)));
 const observations=recording.supplemental.pythonCapture.stages;
 assert.equal(observations[3].status,'discarded');assert.equal(observations[4].retryOf,'train-b#3');
 assert.equal(Object.hasOwn(snapshot,'captureAssurance'),false);
 const session=openWorkflowRecording(recording,{openRecording,traceToolpack,callTraceTool});
 const stale=snapshot.commitLog.findIndex(commit=>commit.runtimeStageId==='guard-stale#5');
 const answer=await session.backtrack('releaseDecision',{before:stale+1});
 for(const id of ['guard-stale#5','evaluate-a#2','train-a#1','train-b#4','inputs#0'])assert.ok(answer.result.includes(id),answer.result);
 assert.doesNotMatch(answer.result,/train-b#3|evaluate-b#6|guard-fresh#7/);
 assert.match(answer.result,/control edges unavailable/);
 const actualReceipt=snapshot.commitLog.find(commit=>commit.runtimeStageId==='evaluate-a#2');
 assert.ok(actualReceipt.trace.find(row=>row.path==='evaluationReceipt').readKeys.includes('modelRef'));
});

test('malformed packets, oversized values and unsafe keys preserve prior committed state',async t=>{
 const result=await runPython(t,String.raw`
ask('open',path=sys.argv[3]);begin('seed');put('stable',dict(id='kept'));ask('commit')
assert raw('{not-json')['error']['code']=='protocol'
assert raw('x'*1048580)['error']['code']=='limit'
assert request('invented')['ok']==False
begin('invalid-write')
assert request('set',key='__proto__',value={})['error']['code']=='unsafe-key'
assert request('set',key='large',value='x'*65537)['error']['code']=='limit'
assert raw(json.dumps(dict(id=999,op='set',key='nan',value=float('nan'))))['ok']==False
assert request('get',key='absent')['result']==dict(present=False)
put('temporary',dict(id='discarded'))
ask('discard',error=dict(type='FixtureFailure',message='Reject staged mutation'))
snapshot=ask('snapshot');assert snapshot['snapshot']['sharedState']==dict(stable=dict(id='kept'))
assert len(snapshot['snapshot']['commitLog'])==1
assert snapshot['supplemental']['pythonCapture']['missingReads'][0]['key']=='absent'
ask('close');finish()
`);
 if(!result)return;
 assert.deepEqual(result.recording.snapshot.sharedState,{stable:{id:'kept'}});
 assert.equal(result.recording.snapshot.commitLog.length,1);
 assert.equal(result.recording.supplemental.pythonCapture.stages[1].status,'discarded');
});

test('native empty commits and JSON null stay distinct from a missing read',async t=>{
 const result=await runPython(t,String.raw`
ask('open',path=sys.argv[3],initialState=dict(nullable=None))
begin('read-only');assert ask('get',key='nullable')==dict(present=True,value=None)
assert ask('get',key='missing')==dict(present=False)
ask('commit');ask('close');finish()
`);
 if(!result)return;
 assert.equal(result.recording.snapshot.commitLog.length,1);
 assert.deepEqual(result.recording.snapshot.commitLog[0].trace,[]);
 assert.deepEqual(result.recording.snapshot.executionTree.stageReads,{nullable:'summary',missing:'missing'});
});

test('root stage addresses reject native runtime and subflow delimiters without consuming an execution id',async t=>{
 const result=await runPython(t,String.raw`
ask('open',path=sys.argv[3])
for invalid in ['parent/child','stage#2','/root']:
    assert request('begin',stageId=invalid)['error']['code']=='protocol'
assert begin('root-stage')['runtimeStageId']=='root-stage#0'
ask('commit');ask('close');finish()
`);
 if(!result)return;
 assert.equal(result.recording.snapshot.commitLog[0].runtimeStageId,'root-stage#0');
 assert.equal(result.recording.supplemental.pythonCapture.stages.length,1);
});

test('maxRecordingBytes bounds the actual formatted file rather than its compact JSON representation',async t=>{
 const root=await mkdtemp(resolve(tmpdir(),'footprint-capture-file-bound-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const base={reference:Object.fromEntries(Array.from({length:80},(_,index)=>[`field${index}`,index]))};
 const capture=async(path,maxRecordingBytes)=>{
  let encoded='';
  const input=Readable.from([JSON.stringify({id:1,op:'open',path,runId:'size-proof',initialState:base})+'\n']);
  const output=new Writable({write(chunk,encoding,callback){encoded+=chunk.toString();callback();}});
  await servePythonCapture({input,output,...(maxRecordingBytes===undefined?{}:{maxRecordingBytes})});
  return JSON.parse(encoded.trim());
 };
 const first=resolve(root,'a.json');assert.equal((await capture(first)).ok,true);
 const saved=JSON.parse(await readFile(first,'utf8'));saved.supplemental.pythonCapture.lifecycle='open';
 const compact=Buffer.byteLength(JSON.stringify(saved)),formatted=Buffer.byteLength(JSON.stringify(saved,null,2)+'\n');
 assert.ok(formatted>compact);
 const maximum=Math.floor((compact+formatted)/2),second=resolve(root,'b.json');
 const response=await capture(second,maximum);
 assert.equal(response.ok,false);assert.equal(response.error.code,'limit');
 await assert.rejects(readFile(second),error=>error.code==='ENOENT');
});

test('EOF discards a live failed stage and saves an explicitly interrupted record',async t=>{
 const result=await runPython(t,String.raw`
ask('open',path=sys.argv[3]);begin('seed');put('stable',1);ask('commit')
begin('unfinished');get('stable');put('stable',2)
finish()
`);
 if(!result)return;
 assert.equal(result.recording.snapshot.sharedState.stable,1);
 assert.equal(result.recording.snapshot.commitLog.length,1);
 assert.equal(result.recording.supplemental.pythonCapture.lifecycle,'interrupted');
 assert.equal(result.recording.supplemental.pythonCapture.stages[1].error.type,'CaptureTransportEnded');
});

test('the optional adapter and capture worker import no foottrace and start no process',t=>{
 if(typeof moduleApi.registerHooks!=='function'){t.skip('Module graph observation requires registerHooks.');return;}
 const source=`import {registerHooks} from 'node:module';
 const hook=registerHooks({resolve(name,context,next){if(name==='foottrace'||name.startsWith('foottrace/'))throw new Error('Premature foottrace load');return next(name,context);}});
 const adapter=await import('footprintjs-ml/adapter');
 if(typeof adapter.servePythonCapture!=='function')throw new Error('Missing explicit server entry');
 await import(${JSON.stringify(new URL('../dist/adapter/capture-worker.js',import.meta.url).href)});hook.deregister();`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:5000});
 assert.equal(result.status,0,result.stderr||String(result.error));
});
