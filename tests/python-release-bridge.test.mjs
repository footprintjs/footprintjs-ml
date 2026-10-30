import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {PassThrough,Writable} from 'node:stream';
import {createEvaluationReceipt,createSelectionReceipt,prepareModelRelease,readModelReleasePlan} from '../dist/index.js';
import {createFileArtifactStore} from '../dist/release/index.js';
import {servePythonCapture} from '../dist/adapter/index.js';

const NOW=1_800_000_000_000,encode=value=>new TextEncoder().encode(value);
const worker=fileURLToPath(new URL('../dist/adapter/capture-worker.js',import.meta.url));
const pythonRoot=fileURLToPath(new URL('../python',import.meta.url)),python=process.env.TEST_PYTHON??'python3';
async function fixture(t){
  const root=await mkdtemp(resolve(tmpdir(),'footprint-python-release-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const storeRoot=resolve(root,'store'),store=createFileArtifactStore({root:storeRoot}),models=[];
  for(const digit of ['a','b'])models.push({kind:'model',sessionId:'synthetic-release-worker',handle:models.length+1,
    originArtifact:await store.put(encode('synthetic-checkpoint-'+digit),{format:'synthetic/checkpoint-v1'}),
    inferenceIdentity:{kind:'inference-identity',schemaVersion:1,profile:'synthetic/predictor-v1',sha256:digit.repeat(64)}});
  const datasetRef={kind:'dataset',sessionId:'synthetic-release-worker',handle:3,rows:2,shape:[2,1],role:'validation',
    artifact:await store.put(encode('synthetic-evaluation-data'),{format:'synthetic/data-v1'})};
  const manifest={kind:'selection-manifest',schemaVersion:1,experimentId:'python-release-bridge',
    candidates:[{candidateId:'a',configuration:{steps:1}},{candidateId:'b',configuration:{steps:2}}],
    comparison:{datasetRef,preprocessingVersion:'synthetic/v1',evaluationMethodVersion:'synthetic/v1',parameters:{}},
    policy:{metric:'mse',direction:'min',tieBreak:'candidate-id-ascending'}};
  const results=models.map((modelRef,index)=>({...manifest.candidates[index],modelRef,
    evaluation:createEvaluationReceipt({evaluationId:'evaluation-'+index,createdAt:NOW,modelRef,...manifest.comparison,metrics:{mse:[0.01,0.02][index]}})}));
  const selection=createSelectionReceipt({selectionId:'selection',createdAt:NOW,manifest,results});
  const plan={kind:'model-release-plan',schemaVersion:1,releaseId:'release-a',idempotencyKey:'publication-a',
    target:{name:'production',expectedRevision:null},modelArtifact:models[0].originArtifact,
    manifestRef:await store.putJson(manifest),resultsRef:await store.putJson(results),selectionReceiptRef:await store.putJson(selection),
    qualityPolicy:{metric:'mse',operator:'lte',threshold:0.03,maxAgeMs:100}};
  const planRef=await store.putJson(plan),input={planRef,modelRef:models[0],now:NOW};
  const expected=await prepareModelRelease({...input,store,verifyModel:async()=>models[0]});assert.equal(expected.allowed,true);
  const source=resolve(root,'checkpoint-source.bin');await writeFile(source,encode('synthetic-checkpoint-a'));
  return{root,storeRoot,models,plan,planRef,input,expected,source};
}
const header=String.raw`
import hashlib,json,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from footprint_ml_workflow import WorkflowCapture,CaptureError
f=json.loads(Path(sys.argv[4]).read_text())
capture=WorkflowCapture(sys.argv[5],command=[sys.argv[2],sys.argv[3]])
`;
async function run(t,f,body){
  const input=resolve(f.root,'input.json'),recording=resolve(f.root,'recording.json');await writeFile(input,JSON.stringify(f));
  const result=spawnSync(python,['-I','-S','-c',header+'\n'+body,pythonRoot,process.execPath,worker,input,recording],
    {encoding:'utf8',timeout:20000,maxBuffer:4*1024*1024});
  if(result.error?.code==='ENOENT'){t.skip('Python unavailable');return;}
  assert.equal(result.status,0,result.stderr||result.stdout||String(result.error));
  return{output:JSON.parse(result.stdout),recording:JSON.parse(await readFile(recording,'utf8'))};
}

test('Python preparation/import returns exact core JSON, rejects a swapped live model, and supports one-shot checked publication',async t=>{
  const f=await fixture(t),result=await run(t,f,String.raw`
calls=[]
class Receiver:
    def publish(self,request):
        calls.append(request)
        assert 'modelBytes' not in request and set(request)=={'payload','payloadCanonicalJson','payloadSha256','preparedRef','modelArtifact'}
        payload=request['payload'];assert json.loads(request['payloadCanonicalJson'])==payload
        assert hashlib.sha256(request['payloadCanonicalJson'].encode()).hexdigest()==request['payloadSha256']
        ref=request['modelArtifact'];content=(Path(f['storeRoot'])/ref['path']).read_bytes()
        assert content==b'synthetic-checkpoint-a' and hashlib.sha256(content).hexdigest()==payload['artifact']['sha256']
        receipt=dict(kind='model-publication-receipt',schemaVersion=1,releaseId=payload['releaseId'],idempotencyKey=payload['idempotencyKey'],
          targetName=payload['target']['name'],revision=request['payloadSha256'],payloadSha256=request['payloadSha256'],
          artifact=ref,preparedRef=request['preparedRef'],committedAt=f['input']['now'])
        return dict(allowed=True,status='published',reasons=[],receipt=receipt)
with capture:
    assert capture.read_model_release_plan(f['plan'])==f['plan']
    imported=capture.put_release_artifact(f['source'],store_root=f['storeRoot'],format='synthetic/checkpoint-v1')
    assert imported==f['models'][0]['originArtifact']
    prepared=capture.prepare_model_release(f['input'],store_root=f['storeRoot'],verify_model=lambda request:f['models'][0])
    assert prepared==f['expected']
    swapped=capture.publish_model_release({**f['input'],'preparedRef':prepared['preparedRef']},store_root=f['storeRoot'],
      verify_model=lambda request:f['models'][1],publisher=Receiver())
    assert swapped['allowed'] is False and not calls
    published=capture.release_model(f['input'],store_root=f['storeRoot'],verify_model=lambda request:f['models'][0],publisher=Receiver())
    assert published['status']=='published' and len(calls)==1
    assert capture.snapshot()['snapshot']['commitLog']==[]
print(json.dumps(dict(prepared=prepared,swapped=swapped,published=published,calls=calls)))
`);
  if(!result)return;
  assert.deepEqual(result.output.prepared,f.expected);assert.deepEqual(readModelReleasePlan(f.plan),f.plan);
  assert.equal(result.output.published.publisherReceipt.artifact.sha256,f.models[0].originArtifact.sha256);
  assert.equal(result.recording.snapshot.commitLog.length,0,'Release callbacks must not fabricate scope provenance');
});

test('A lost callback acknowledgement stays unknown and retries the original publication by lookup without a verifier',async t=>{
  const f=await fixture(t),result=await run(t,f,String.raw`
class Receiver:
    def __init__(self):self.receipt=None;self.effects=0;self.lookups=0
    def lookup(self,request):
        self.lookups+=1
        assert set(request)=={'payload','payloadCanonicalJson','payloadSha256','preparedRef'}
        if self.receipt:return dict(allowed=True,status='already-published',reasons=[],receipt=self.receipt)
        return None
    def publish(self,request):
        self.effects+=1;payload=request['payload']
        self.receipt=dict(kind='model-publication-receipt',schemaVersion=1,releaseId=payload['releaseId'],idempotencyKey=payload['idempotencyKey'],
          targetName=payload['target']['name'],revision=request['payloadSha256'],payloadSha256=request['payloadSha256'],
          artifact=request['modelArtifact'],preparedRef=request['preparedRef'],committedAt=f['input']['now'])
        raise OSError('Acknowledgement lost after synthetic receiver committed')
receiver=Receiver()
with capture:
    prepared=capture.prepare_model_release(f['input'],store_root=f['storeRoot'],verify_model=lambda request:f['models'][0])
    request={**f['input'],'preparedRef':prepared['preparedRef']}
    first=capture.publish_model_release(request,store_root=f['storeRoot'],verify_model=lambda request:f['models'][0],publisher=receiver)
    assert first['status']=='unknown' and receiver.effects==1
    recovered=capture.publish_model_release({'planRef':f['planRef'],'preparedRef':prepared['preparedRef'],'now':f['input']['now']+1000},
      store_root=f['storeRoot'],publisher=receiver)
    assert recovered['status']=='already-published' and recovered['publisherReceipt']==receiver.receipt and receiver.effects==1
    assert recovered['decision']['basis']=='historical-acknowledgement'
print(json.dumps(dict(first=first,recovered=recovered,effects=receiver.effects,lookups=receiver.lookups)))
`);
  if(!result)return;assert.equal(result.output.effects,1);assert.equal(result.output.lookups,2);
});

test('Wrong store roots and changed pinned checkpoint bytes fail before verification or publication callbacks',async t=>{
  const f=await fixture(t),result=await run(t,f,String.raw`
calls=[]
def verify(request):calls.append(request);return f['models'][0]
with capture:
    absent=capture.prepare_model_release(f['input'],store_root=Path(f['root'])/'absent-store',verify_model=verify)
    assert absent['allowed'] is False and not calls
    file=Path(f['storeRoot'])/f['models'][0]['originArtifact']['path'];old=file.read_bytes();file.write_bytes(b'x'*len(old))
    tampered=capture.prepare_model_release(f['input'],store_root=f['storeRoot'],verify_model=verify)
    assert tampered['allowed'] is False and not calls
    file.write_bytes(old)
    try:capture.put_release_artifact(f['storeRoot'],store_root=f['storeRoot'],format='fixture/v1')
    except CaptureError as error:assert error.code=='unsafe-artifact-path'
    else:raise AssertionError('A directory was imported as checkpoint bytes')
    corrected=capture.prepare_model_release(f['input'],store_root=f['storeRoot'],verify_model=verify)
    assert corrected['allowed'] is True and len(calls)==1
print(json.dumps(dict(absent=absent,tampered=tampered,corrected=corrected)))
`);
  if(!result)return;assert.equal(result.output.corrected.allowed,true);
});

test('Malformed callback IDs fail closed before the publisher runs and preserve the saved record',async t=>{
  const f=await fixture(t),input=new PassThrough(),packets=[];let buffered='';
  const output=new Writable({write(chunk,_encoding,done){buffered+=chunk;let boundary;
    while((boundary=buffered.indexOf('\n'))>=0){packets.push(JSON.parse(buffered.slice(0,boundary)));buffered=buffered.slice(boundary+1);}done();}});
  const serving=servePythonCapture({input,output});
  const send=value=>input.write(JSON.stringify(value)+'\n');
  const wait=async predicate=>{for(let i=0;i<200;i++){const found=packets.find(predicate);if(found)return found;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Missing expected protocol packet');};
  const recording=resolve(f.root,'protocol-recording.json');send({id:1,op:'open',path:recording});await wait(value=>value.id===1&&value.ok===true);
  send({id:2,op:'prepare_model_release',input:f.input,storeRoot:f.storeRoot,verifyModel:true,publisherLookup:false});
  const callback=await wait(value=>value.type==='callback');
  send({op:'callback_result',id:2,callId:callback.callId+1,ok:true,result:f.models[0]});
  await serving;
  assert(!packets.some(value=>value.method==='publisher.publish'));
  const result=packets.find(value=>value.id===2&&value.ok===true);assert.equal(result.result.allowed,false);
  assert.equal(JSON.parse(await readFile(recording,'utf8')).supplemental.pythonCapture.lifecycle,'interrupted');
});
