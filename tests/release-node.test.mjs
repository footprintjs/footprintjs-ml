import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,unlink,symlink,mkdir,rmdir,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createFileArtifactStore,createLocalModelPublisher} from '../dist/release/index.js';
import {modelPublicationPayloadSha256,releaseBytesSha256} from '../dist/release.js';

const encode=s=>new TextEncoder().encode(s);
const identity=ref=>({sha256:ref.sha256,bytes:ref.bytes,format:ref.format});
const lookupRequest=({payload,payloadSha256,preparedRef})=>({payload,payloadSha256,preparedRef});
const temporary=async t=>{const root=await mkdtemp(join(tmpdir(),'footprint-release-node-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;};
async function setup(t){
  const root=await temporary(t),sourceRoot=join(root,'source'),publisherRoot=join(root,'receiver');
  const store=createFileArtifactStore({root:sourceRoot});
  const evidence=await store.putJson({fixture:'trusted caller unit test'},'footprint/test-evidence-json/v1');
  const preparedRef=await store.putJson({fixture:'prepared observation'},'footprint/test-prepared-json/v1');
  async function request({candidate='candidate-a',key='key-a',target='production',expectedRevision=null,validUntil=null,prepared=preparedRef}={}){
    const modelBytes=encode('numerical-artifact-for-'+candidate),model=await store.put(modelBytes,{format:'footprint/test-model-bytes/v1'});
    const payload={kind:'model-publication-payload',schemaVersion:1,releaseId:'release-'+candidate,idempotencyKey:key,
      target:{name:target,expectedRevision},artifact:identity(model),candidateId:candidate,inferenceIdentity:null,
      evidence:{plan:identity(evidence),manifest:identity(evidence),results:identity(evidence),selectionReceipt:identity(evidence)},
      qualityPolicy:{metric:'mse',operator:'lte',threshold:0.01},validUntil};
    return{payload,payloadSha256:await modelPublicationPayloadSha256(payload),modelBytes,preparedRef:prepared};
  }
  return{root,sourceRoot,publisherRoot,store,preparedRef,request,publisher:createLocalModelPublisher({root:publisherRoot})};
}
async function child(root,request,inputRoot){
  const file=join(inputRoot,'request-'+randomUUID()+'.json');await writeFile(file,JSON.stringify({...request,modelBytes:Buffer.from(request.modelBytes).toString('base64')}));
  return new Promise((resolve,reject)=>{const proc=spawn(process.execPath,[fileURLToPath(new URL('release-node-child.mjs',import.meta.url)),root,file],{stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';proc.stdout.on('data',data=>stdout+=data);proc.stderr.on('data',data=>stderr+=data);
    proc.once('error',reject);proc.once('close',code=>{if(code!==0)reject(new Error('Child failed: '+stderr));else{try{resolve(JSON.parse(stdout));}catch(error){reject(error);}}});});
}

test('File store snapshots source bytes, reuses immutable content, binds the format label and checks actual stored bytes',async t=>{
  const root=await temporary(t),store=createFileArtifactStore({root});const bytes=encode('checkpoint-bytes');
  const pending=store.put(bytes,{format:'checkpoint/v1'});bytes.fill(88);const ref=await pending;
  assert.deepEqual(await store.read(ref),encode('checkpoint-bytes'));
  assert.deepEqual(await store.put(encode('checkpoint-bytes'),{format:'checkpoint/v1'}),ref);
  await assert.rejects(store.read({...ref,format:'checkpoint/v2'}),error=>error.code==='unsafe-artifact-path');
  await writeFile(join(root,ref.path),encode('tampered'));
  await assert.rejects(store.read(ref),error=>error.code==='artifact-bytes-mismatch');
  await assert.rejects(store.put(encode('checkpoint-bytes'),{format:'checkpoint/v1'}),error=>error.code==='artifact-bytes-mismatch');
  assert.deepEqual(await readFile(join(root,ref.path)),Buffer.from('tampered'));
});

test('Managed store refuses traversal, observed symlinks and a symlink root',async t=>{
  const root=await temporary(t),store=createFileArtifactStore({root:join(root,'store')}),ref=await store.put(encode('safe'),{format:'test/v1'});
  await assert.rejects(store.read({...ref,path:'../outside'}),error=>error.code==='unsafe-artifact-path');
  const outside=join(root,'outside');await writeFile(outside,'safe');await unlink(join(root,'store',ref.path));await symlink(outside,join(root,'store',ref.path));
  await assert.rejects(store.read(ref));
  await symlink(join(root,'store'),join(root,'linked-root'));
  await assert.rejects(createFileArtifactStore({root:join(root,'linked-root')}).put(encode('new'),{format:'test/v1'}),error=>error.code==='unsafe-artifact-root');
});

test('Receiver independently refuses swapped model bytes and payload hashes without publishing',async t=>{
  const s=await setup(t),request=await s.request();
  const swapped=await s.publisher.publish({...request,modelBytes:encode('another model')});
  assert.equal(swapped.allowed,false);assert.equal(swapped.reasons[0].code,'publication-artifact-mismatch');
  const hashSwap=await s.publisher.publish({...request,payloadSha256:'0'.repeat(64)});
  assert.equal(hashSwap.allowed,false);assert.equal(hashSwap.reasons[0].code,'publication-payload-mismatch');
  const extra=await s.publisher.publish({...request,futureVersion:true});assert.equal(extra.allowed,false);
  assert.equal((await s.publisher.readState()).publications.length,0);
});

test('Receiver owns its byte/payload snapshots and never rereads a later-mutated source artifact',async t=>{
  const s=await setup(t),request=await s.request();const approvedBytes=new Uint8Array(request.modelBytes),source=await s.store.put(approvedBytes,{format:request.payload.artifact.format});
  const pending=s.publisher.publish(request);
  request.modelBytes.fill(0);request.payload.target.name='changed-by-caller';request.payload.candidateId='changed-by-caller';request.preparedRef={...request.preparedRef,path:'../outside'};
  await writeFile(join(s.sourceRoot,source.path),encode('source changed after approved snapshot'));
  const result=await pending;assert.equal(result.status,'published');assert.equal(result.receipt.targetName,'production');
  const receiverStore=createFileArtifactStore({root:s.publisherRoot});assert.deepEqual(await receiverStore.read(result.receipt.artifact),approvedBytes);
  assert.equal(result.receipt.artifact.sha256,await releaseBytesSha256(approvedBytes));
});

test('A lost acknowledgement retries in a fresh process with the unchanged original receipt',async t=>{
  const s=await setup(t),request=await s.request();let original;
  await assert.rejects(async()=>{original=await s.publisher.publish(request);assert.equal(original.status,'published');throw new Error('Transport acknowledgement lost after receiver committed and returned');},/acknowledgement lost/);
  const newPreparation=await s.store.putJson({fixture:'fresh process preparation'},'footprint/test-prepared-json/v1');
  const result=await child(s.publisherRoot,{...request,preparedRef:newPreparation},s.root);
  assert.equal(result.status,'already-published');assert.deepEqual(result.receipt,original.receipt);
  assert.equal((await s.publisher.readState()).publications.length,1);
});

test('Same-key conflicts and target CAS refuse changes; historical A retry never rolls back newer B',async t=>{
  const s=await setup(t),a=await s.request(),first=await s.publisher.publish(a);assert.equal(first.status,'published');
  const changedSameKey=await s.request({candidate:'candidate-b'});const conflict=await s.publisher.publish(changedSameKey);
  assert.equal(conflict.status,'deny');assert.equal(conflict.reasons[0].code,'idempotency-key-conflict');
  const staleTarget=await s.request({candidate:'candidate-b',key:'key-b'});const rejected=await s.publisher.publish(staleTarget);
  assert.equal(rejected.reasons[0].code,'target-revision-conflict');
  const b=await s.request({candidate:'candidate-b',key:'key-b',expectedRevision:first.receipt.revision});const second=await s.publisher.publish(b);assert.equal(second.status,'published');
  const historical=await createLocalModelPublisher({root:s.publisherRoot}).publish(a);
  assert.equal(historical.status,'already-published');assert.deepEqual(historical.receipt,first.receipt);
  assert.deepEqual(await s.publisher.readTarget('production'),second.receipt);
  const state=await s.publisher.readState();assert.equal(state.publications.length,2);assert.equal(state.targets.length,1);
  assert.throws(()=>state.targets.push({name:'caller mutation'}));
});

test('Expired approvals are refused at the receiver, including expiry while waiting for its lock',async t=>{
  const s=await setup(t);await s.publisher.readState();
  const expired=await s.request({validUntil:Date.now()-1});const first=await s.publisher.publish(expired);
  assert.equal(first.allowed,false);assert.equal(first.reasons[0].code,'publication-expired');
  const lock=join(s.publisherRoot,'.publication-lock');await mkdir(lock);
  const inFlight=await s.request({validUntil:Date.now()+30});const pending=s.publisher.publish(inFlight);
  await new Promise(resolve=>setTimeout(resolve,70));await rmdir(lock);
  const result=await pending;assert.equal(result.allowed,false);assert.equal(result.reasons[0].code,'publication-expired');
  assert.equal((await s.publisher.readState()).publications.length,0);
});

test('Corrupt, future or internally inconsistent registries fail closed without repair',async t=>{
  for(const change of [state=>({...state,schemaVersion:99}),state=>({...state,unknown:true}),state=>({...state,idempotency:[]}),state=>({...state,targets:[{name:'production',revision:'0'.repeat(64),publicationIndex:0}]})]){
    const s=await setup(t),request=await s.request();await s.publisher.publish(request);
    const state=await s.publisher.readState(),bytes=JSON.stringify(change(state));await writeFile(join(s.publisherRoot,'registry.json'),bytes);
    assert.equal((await s.publisher.publish(request)).allowed,false);await assert.rejects(s.publisher.readState());
    assert.equal(await readFile(join(s.publisherRoot,'registry.json'),'utf8'),bytes);
  }
  const s=await setup(t),request=await s.request();await s.publisher.publish(request);await unlink(join(s.publisherRoot,'registry.json'));
  assert.equal((await s.publisher.publish(request)).allowed,false);
});

test('Missing or corrupt initialization markers cannot convert an initialized registry into a new empty target',async t=>{
  for(const marker of [null,'local-model-registry/v99\n']){
    const s=await setup(t),request=await s.request();const first=await s.publisher.publish(request);assert.equal(first.status,'published');
    if(marker===null)await unlink(join(s.publisherRoot,'registry.initialized'));else await writeFile(join(s.publisherRoot,'registry.initialized'),marker);
    const preserved=await readFile(join(s.publisherRoot,'registry.json'));
    const retry=await s.publisher.publish(request);assert.equal(retry.allowed,false);assert.equal(retry.reasons[0].code,'invalid-local-registry');
    assert.deepEqual(await readFile(join(s.publisherRoot,'registry.json')),preserved);
  }
});

test('A previously published blob cannot be silently corrupted and acknowledged again',async t=>{
  const s=await setup(t),request=await s.request(),first=await s.publisher.publish(request);
  await writeFile(join(s.publisherRoot,first.receipt.artifact.path),encode('bad received checkpoint'));
  const retry=await s.publisher.publish(request);assert.equal(retry.allowed,false);assert.equal(retry.reasons[0].code,'artifact-bytes-mismatch');
  const lookup=await s.publisher.lookup(lookupRequest(request));assert.equal(lookup.allowed,false);assert.equal(lookup.reasons[0].code,'artifact-bytes-mismatch');
});

test('Read-only lookup does not initialize missing storage or create a publication for an uncommitted key',async t=>{
  const s=await setup(t),request=await s.request();
  assert.equal(await s.publisher.lookup(lookupRequest(request)),null);
  await assert.rejects(lstat(s.publisherRoot),error=>error.code==='ENOENT');
  await s.publisher.readState();const before=await readFile(join(s.publisherRoot,'registry.json'));
  assert.equal(await s.publisher.lookup(lookupRequest(request)),null);
  assert.deepEqual(await readFile(join(s.publisherRoot,'registry.json')),before);
});

test('Historical lookup acknowledges after expiry and later target advancement without writes or backend access',async t=>{
  const s=await setup(t),a=await s.request({validUntil:Date.now()+300}),first=await s.publisher.publish(a);assert.equal(first.status,'published');
  const b=await s.request({candidate:'candidate-b',key:'key-b',expectedRevision:first.receipt.revision}),second=await s.publisher.publish(b);assert.equal(second.status,'published');
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,a.payload.validUntil-Date.now()+10)));
  const before=await readFile(join(s.publisherRoot,'registry.json'));
  // A stale writer lock also cannot force this read-only acknowledgement down
  // the new-publication path. No model bytes or live backend are supplied.
  await mkdir(join(s.publisherRoot,'.publication-lock'));
  const result=await createLocalModelPublisher({root:s.publisherRoot}).lookup(lookupRequest(a));
  await rmdir(join(s.publisherRoot,'.publication-lock'));
  assert.equal(result.status,'already-published');assert.deepEqual(result.receipt,first.receipt);
  assert.deepEqual(await readFile(join(s.publisherRoot,'registry.json')),before);
  assert.deepEqual(await s.publisher.readTarget('production'),second.receipt);
  const expiredNew=await s.request({candidate:'candidate-c',key:'key-c',expectedRevision:second.receipt.revision,validUntil:Date.now()-1});
  assert.equal(await s.publisher.lookup(lookupRequest(expiredNew)),null);
  const refused=await s.publisher.publish(expiredNew);assert.equal(refused.allowed,false);assert.equal(refused.reasons[0].code,'publication-expired');
  assert.deepEqual(await readFile(join(s.publisherRoot,'registry.json')),before);
});

test('Read-only lookup refuses a changed key payload or a corrupt acknowledgement binding',async t=>{
  const s=await setup(t),a=await s.request(),first=await s.publisher.publish(a);assert.equal(first.status,'published');
  const changed=await s.request({candidate:'candidate-b'});const conflict=await s.publisher.lookup(lookupRequest(changed));
  assert.equal(conflict.allowed,false);assert.equal(conflict.reasons[0].code,'idempotency-key-conflict');
  const b=await s.request({candidate:'candidate-b',key:'key-b',target:'staging'});await s.publisher.publish(b);
  const altered=JSON.parse(await readFile(join(s.publisherRoot,'registry.json'),'utf8'));
  altered.publications[0].artifact=altered.publications[1].artifact;
  await writeFile(join(s.publisherRoot,'registry.json'),JSON.stringify(altered));
  const result=await s.publisher.lookup(lookupRequest(a));assert.equal(result.allowed,false);assert.equal(result.reasons[0].code,'invalid-local-registry');
});

test('Concurrent fresh-process retries create one publication and return the same original receipt',async t=>{
  const s=await setup(t),request=await s.request();
  const results=await Promise.all(Array.from({length:4},()=>child(s.publisherRoot,request,s.root)));
  assert.equal(results.filter(result=>result.status==='published').length,1);
  assert.equal(results.filter(result=>result.status==='already-published').length,3);
  for(const result of results)assert.deepEqual(result.receipt,results[0].receipt);
  assert.equal((await s.publisher.readState()).publications.length,1);
});

test('Concurrent independent target updates are retained and competing CAS updates cannot both commit',async t=>{
  const s=await setup(t),a=await s.request({target:'east'}),b=await s.request({candidate:'candidate-b',key:'key-b',target:'west'});
  const initial=await Promise.all([child(s.publisherRoot,a,s.root),child(s.publisherRoot,b,s.root)]);
  assert(initial.every(result=>result.status==='published'));assert.equal((await s.publisher.readState()).publications.length,2);
  const revision=(await s.publisher.readTarget('east')).revision;
  const c=await s.request({candidate:'candidate-c',key:'key-c',target:'east',expectedRevision:revision}),d=await s.request({candidate:'candidate-d',key:'key-d',target:'east',expectedRevision:revision});
  const raced=await Promise.all([child(s.publisherRoot,c,s.root),child(s.publisherRoot,d,s.root)]);
  assert.equal(raced.filter(result=>result.status==='published').length,1);
  assert.equal(raced.filter(result=>result.reasons[0].code==='target-revision-conflict').length,1);
  const state=await s.publisher.readState();assert.equal(state.publications.length,3);assert.equal(state.targets.length,2);
});
