import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFile,lstat,mkdtemp,open,readFile,rm,truncate,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createTrainerAdapter} from '../dist/index.js';
import {createFileArtifactStore,createLocalModelPublisher} from '../dist/release/index.js';
import {modelPublicationPayloadSha256} from '../dist/release.js';
import {NOW,clone,fakePort,request} from './fixtures.mjs';

const encode=value=>new TextEncoder().encode(value);
const identity=ref=>({sha256:ref.sha256,bytes:ref.bytes,format:ref.format});
async function temporary(t){
  const root=await mkdtemp(join(tmpdir(),'footprint-platform-hardening-'));
  t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
async function fileHandlePrototype(root){
  const handle=await open(join(root,'prototype-probe'),'w');
  const prototype=Object.getPrototypeOf(handle);await handle.close();return prototype;
}
async function publicationFixture(t){
  const root=await temporary(t),source=createFileArtifactStore({root:join(root,'source')});
  const modelBytes=encode('approved model'),model=await source.put(modelBytes,{format:'test/checkpoint-v1'});
  const evidence=await source.putJson({observed:'evidence'}),preparedRef=await source.putJson({prepared:'evidence'});
  const payload={kind:'model-publication-payload',schemaVersion:1,releaseId:'release-a',idempotencyKey:'publish-a',
    target:{name:'production',expectedRevision:null},artifact:identity(model),candidateId:'candidate-a',inferenceIdentity:null,
    evidence:{plan:identity(evidence),manifest:identity(evidence),results:identity(evidence),selectionReceipt:identity(evidence)},
    qualityPolicy:{metric:'accuracy',operator:'gte',threshold:0.95},validUntil:null};
  const publisherRoot=join(root,'publisher');
  return{root,publisherRoot,publisher:createLocalModelPublisher({root:publisherRoot}),
    request:{payload,payloadSha256:await modelPublicationPayloadSha256(payload),modelBytes,preparedRef}};
}

test('Successful legacy evaluations remember externally created handles and reject changed checkpoints before another evaluation',async()=>{
  const {port,calls}=fakePort(),adapter=createTrainerAdapter(port,{clock:()=>NOW});
  assert.equal(port.inspect,undefined);
  const first=await adapter.evaluate(request());
  assert.equal(first.receipt.modelRef.originArtifact.sha256,request().modelRef.originArtifact.sha256);
  const changed=request();changed.modelRef.originArtifact.sha256='c'.repeat(64);
  await assert.rejects(adapter.evaluate(changed),error=>error.code==='runtime-handle-reused');
  assert.equal(calls.evaluate.length,1);
  assert.equal((await adapter.evaluate(request())).receipt.modelRef.handle,request().modelRef.handle);
});

test('A failed legacy evaluation does not register an unvalidated external handle',async()=>{
  let evaluations=0;
  const {port}=fakePort({async evaluate(input){
    evaluations++;return{...clone(input),evaluationId:'external-evaluation',metrics:{accuracy:evaluations===1?NaN:0.97}};
  }});
  const adapter=createTrainerAdapter(port,{clock:()=>NOW});
  await assert.rejects(adapter.evaluate(request()),error=>error.code==='invalid-number');
  const changed=request();changed.modelRef.originArtifact.sha256='c'.repeat(64);
  const result=await adapter.evaluate(changed);
  assert.equal(result.receipt.modelRef.originArtifact.sha256,'c'.repeat(64));
  assert.equal(evaluations,2);
});

test('A failed lock-owner write preserves its error, removes its lock, and permits a subsequent publication',async t=>{
  const fixture=await publicationFixture(t),prototype=await fileHandlePrototype(fixture.root);
  const original=prototype.writeFile;let injected=false,first;
  prototype.writeFile=async function(value,...args){
    if(!injected&&typeof value==='string'&&value.startsWith('{"token":')){
      injected=true;const error=new Error('Injected owner write failure');error.code='ENOSPC';throw error;
    }
    return original.call(this,value,...args);
  };
  try{first=await fixture.publisher.publish(fixture.request);}finally{prototype.writeFile=original;}
  assert.equal(injected,true);assert.equal(first.status,'unknown');assert.equal(first.reasons[0].code,'ENOSPC');
  assert.match(first.reasons[0].message,/Injected owner write failure/);
  await assert.rejects(lstat(join(fixture.publisherRoot,'.publication-lock')),error=>error.code==='ENOENT');
  const retry=await fixture.publisher.publish(fixture.request);
  assert.equal(retry.status,'published');assert.equal((await fixture.publisher.readState()).publications.length,1);
  assert.equal((await fixture.publisher.publish(fixture.request)).status,'already-published');
});

test('A wrong-sized sparse artifact is rejected before any content read or large allocation',async t=>{
  const root=await temporary(t),store=createFileArtifactStore({root});
  const ref=await store.put(encode('abc'),{format:'test/small-artifact-v1'}),path=join(root,ref.path);
  await truncate(path,2_147_483_648);
  const prototype=await fileHandlePrototype(root),originalRead=prototype.read,originalReadFile=prototype.readFile;let reads=0;
  const unexpectedRead=async function(){reads++;const error=new Error('Content read attempted before size check');error.code='UNEXPECTED_CONTENT_READ';throw error;};
  prototype.read=unexpectedRead;prototype.readFile=unexpectedRead;
  try{await assert.rejects(store.read(ref),error=>error.code==='artifact-bytes-mismatch');}
  finally{prototype.read=originalRead;prototype.readFile=originalReadFile;}
  assert.equal(reads,0);
});

test('Artifact growth after descriptor inspection is rejected after only its original bytes and a one-byte probe',async t=>{
  const root=await temporary(t),store=createFileArtifactStore({root}),ref=await store.put(encode('abc'),{format:'test/growth-v1'});
  const path=join(root,ref.path),prototype=await fileHandlePrototype(root),originalRead=prototype.read,originalReadFile=prototype.readFile;
  let grew=false,readFileCalls=0;const requestedLengths=[];
  prototype.read=async function(buffer,offset,length,position){
    requestedLengths.push(length);
    if(!grew){grew=true;await appendFile(path,new Uint8Array(1024*1024));}
    return originalRead.call(this,buffer,offset,length,position);
  };
  prototype.readFile=async function(...args){readFileCalls++;return originalReadFile.apply(this,args);};
  try{await assert.rejects(store.read(ref),error=>error.code==='artifact-bytes-mismatch');}
  finally{prototype.read=originalRead;prototype.readFile=originalReadFile;}
  assert.equal(grew,true);assert.equal(readFileCalls,0);
  assert.deepEqual(requestedLengths,[ref.bytes,1]);
});

test('Registry metadata accepts its exact byte limit and rejects oversized descriptors before reading content',async t=>{
  const root=await temporary(t),publisher=createLocalModelPublisher({root}),maximum=16*1024*1024;
  await publisher.readState();const path=join(root,'registry.json'),original=await readFile(path);
  const boundary=Buffer.alloc(maximum,32);original.copy(boundary);await writeFile(path,boundary);
  assert.equal((await publisher.readState()).publications.length,0);
  await truncate(path,maximum+1);
  const prototype=await fileHandlePrototype(root),originalRead=prototype.read,originalReadFile=prototype.readFile;let reads=0;
  const unexpectedRead=async function(){reads++;const error=new Error('Oversized metadata content read');error.code='UNEXPECTED_CONTENT_READ';throw error;};
  prototype.read=unexpectedRead;prototype.readFile=unexpectedRead;
  try{await assert.rejects(publisher.readState(),error=>error.code==='local-record-too-large');}
  finally{prototype.read=originalRead;prototype.readFile=originalReadFile;}
  assert.equal(reads,0);
  await assert.rejects(lstat(join(root,'.publication-lock')),error=>error.code==='ENOENT');
});

test('An oversized prospective registry is refused before replacing the last committed state',async t=>{
  const fixture=await publicationFixture(t),first=await fixture.publisher.publish(fixture.request);
  assert.equal(first.status,'published');
  const path=join(fixture.publisherRoot,'registry.json'),before=await readFile(path);
  const payload={...fixture.request.payload,releaseId:'r'.repeat(16*1024*1024),idempotencyKey:'publish-b',
    target:{name:'production',expectedRevision:first.receipt.revision}};
  const result=await fixture.publisher.publish({...fixture.request,payload,payloadSha256:await modelPublicationPayloadSha256(payload)});
  assert.equal(result.status,'deny');assert.equal(result.reasons[0].code,'local-record-too-large');
  assert.deepEqual(await readFile(path),before);
  assert.equal((await fixture.publisher.readState()).publications.length,1);
});

test('Empty managed artifacts remain readable and shrinking files fail closed',async t=>{
  const root=await temporary(t),store=createFileArtifactStore({root}),empty=await store.put(new Uint8Array(),{format:'test/empty-v1'});
  assert.deepEqual(await store.read(empty),new Uint8Array());
  const ref=await store.put(encode('abc'),{format:'test/shrink-v1'}),path=join(root,ref.path);
  const prototype=await fileHandlePrototype(root),originalRead=prototype.read;let shrank=false;
  prototype.read=async function(...args){if(!shrank){shrank=true;await truncate(path,1);}return originalRead.apply(this,args);};
  try{await assert.rejects(store.read(ref),error=>error.code==='artifact-bytes-mismatch');}
  finally{prototype.read=originalRead;}
  assert.equal(shrank,true);
});

test('A FIFO at a managed artifact path is rejected without waiting for a writer',{skip:process.platform==='win32'},async t=>{
  const root=await temporary(t),store=createFileArtifactStore({root}),ref=await store.put(encode('abc'),{format:'test/fifo-v1'});
  const path=join(root,ref.path);await unlink(path);
  const made=spawnSync('mkfifo',[path],{encoding:'utf8'});assert.equal(made.error,undefined);assert.equal(made.status,0,made.stderr);
  const source=`import {createFileArtifactStore} from ${JSON.stringify(new URL('../dist/release/index.js',import.meta.url).href)};
    try{await createFileArtifactStore({root:${JSON.stringify(root)}}).read(${JSON.stringify(ref)});process.exitCode=1;}
    catch(error){process.stdout.write(JSON.stringify({code:error.code}));}`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:3000});
  assert.equal(child.error,undefined,'Managed FIFO read must finish without a writer');
  assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).code,'unsafe-artifact-path');
});
