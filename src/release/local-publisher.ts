import {mkdir,lstat,realpath,open,rename,unlink,rmdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {canonicalJson,detached,fail,nonempty} from '../contracts.js';
import type {ArtifactRef,ReleaseReason,JsonValue} from '../contracts.js';
import {readModelPublicationPayload,modelPublicationPayloadSha256} from '../release.js';
import type {ModelPublicationPayload,ModelPublicationRequest,ModelPublicationReceipt,ModelPublisherResult,ModelPublisher} from '../release.js';
import {createFileArtifactStore,exactFields,managedReference,readPlainFile,safeOpenNew,trustedDirectory} from './files.js';

export interface LocalModelRegistry{
  readonly kind:'local-model-registry';readonly schemaVersion:1;
  readonly publications:readonly ModelPublicationReceipt[];
  readonly targets:readonly {readonly name:string;readonly revision:string;readonly publicationIndex:number}[];
  readonly idempotency:readonly {readonly key:string;readonly payloadSha256:string;readonly publicationIndex:number}[];
}
export interface LocalModelPublisher extends ModelPublisher{
  lookup(request:Pick<ModelPublicationRequest,'payload'|'payloadSha256'|'preparedRef'>):Promise<ModelPublisherResult|null>;
  readTarget(name:string):Promise<ModelPublicationReceipt|null>;
  readState():Promise<LocalModelRegistry>;
}
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const MAX_LOCAL_REGISTRY_BYTES=16*1024*1024;
const REGISTRY_MARKER='local-model-registry/v1\n';
const empty=():LocalModelRegistry=>({kind:'local-model-registry',schemaVersion:1,publications:[],targets:[],idempotency:[]});
function digest(value:unknown,label:string):string{
  if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))fail('invalid-local-registry',label+' must be a lowercase SHA-256 digest');return value;
}
function index(value:unknown,length:number):number{
  if(!Number.isSafeInteger(value)||(value as number)<0||(value as number)>=length)fail('invalid-local-registry','Registry index is out of bounds');return value as number;
}
function receipt(value:unknown):ModelPublicationReceipt{
  exactFields(value,['kind','schemaVersion','releaseId','idempotencyKey','targetName','revision','payloadSha256','artifact','preparedRef','committedAt'],'publication receipt');
  if(value.kind!=='model-publication-receipt'||value.schemaVersion!==1)fail('invalid-local-registry','Unsupported publication receipt schema');
  const revision=digest(value.revision,'revision');if(revision!==digest(value.payloadSha256,'payloadSha256'))fail('invalid-local-registry','Revision differs from payload identity');
  if(typeof value.committedAt!=='number'||!Number.isSafeInteger(value.committedAt)||value.committedAt<0)fail('invalid-local-registry','Invalid publication timestamp');
  return detached({kind:'model-publication-receipt' as const,schemaVersion:1 as const,
    releaseId:nonempty(value.releaseId,'releaseId'),idempotencyKey:nonempty(value.idempotencyKey,'idempotencyKey'),
    targetName:nonempty(value.targetName,'targetName'),revision,payloadSha256:revision,
    artifact:managedReference(value.artifact),preparedRef:managedReference(value.preparedRef),committedAt:value.committedAt});
}
function validateLedger(value:unknown):LocalModelRegistry{
  exactFields(value,['kind','schemaVersion','publications','targets','idempotency'],'local registry');
  if(value.kind!=='local-model-registry'||value.schemaVersion!==1||!Array.isArray(value.publications)||!Array.isArray(value.targets)||!Array.isArray(value.idempotency))fail('invalid-local-registry','Unsupported local registry schema');
  const publications=value.publications.map(receipt),targets=value.targets as unknown[],idempotency=value.idempotency as unknown[];
  if(idempotency.length!==publications.length)fail('invalid-local-registry','Every publication needs one idempotency entry');
  const seenKeys=new Set<string>(),seenIndices=new Set<number>();
  for(const row of idempotency){exactFields(row,['key','payloadSha256','publicationIndex'],'idempotency entry');
    const key=nonempty(row.key,'idempotency key'),i=index(row.publicationIndex,publications.length),published=publications[i];
    if(seenKeys.has(key)||seenIndices.has(i)||key!==published.idempotencyKey||digest(row.payloadSha256,'idempotency payload')!==published.payloadSha256)fail('invalid-local-registry','Idempotency index is inconsistent');
    seenKeys.add(key);seenIndices.add(i);
  }
  const latest=new Map<string,number>();publications.forEach((r,i)=>latest.set(r.targetName,i));
  if(targets.length!==latest.size)fail('invalid-local-registry','Target index does not cover publication history');
  const names=new Set<string>();for(const row of targets){exactFields(row,['name','revision','publicationIndex'],'target entry');
    const name=nonempty(row.name,'target name'),i=index(row.publicationIndex,publications.length);
    if(names.has(name)||latest.get(name)!==i||publications[i].targetName!==name||digest(row.revision,'target revision')!==publications[i].revision)fail('invalid-local-registry','Target index is inconsistent');names.add(name);
  }
  return detached({kind:'local-model-registry' as const,schemaVersion:1 as const,publications,
    targets:targets as LocalModelRegistry['targets'],idempotency:idempotency as LocalModelRegistry['idempotency']});
}
const reason=(code:string,message:string):ReleaseReason=>({code,message});
const reject=(status:'deny'|'unknown',code:string,message:string):ModelPublisherResult=>detached({allowed:false,status,reasons:[reason(code,message)],receipt:null});

/** A single-host, cooperating-process local publisher. Root and its parents
 * must be trusted. mkdir serializes the complete registry read/check/replace;
 * rename alone is not its concurrency protection. A stale lock is not broken
 * automatically. No fsync/power-loss, hostile-FS, network-FS or distributed
 * exactly-once guarantee is made. Historical acknowledgements do not claim
 * that their revision is still the current target. */
export function createLocalModelPublisher(options:{readonly root:string}):LocalModelPublisher{
  const requestedRoot=resolve(nonempty(options.root,'root'));
  const directory=trustedDirectory(requestedRoot),store=createFileArtifactStore({root:requestedRoot});
  const withLock=async<T>(operation:(root:string)=>Promise<T>):Promise<T>=>{
    const root=await directory(),lock=join(root,'.publication-lock'),token=randomUUID(),until=Date.now()+5000;
    for(;;){try{await mkdir(lock);break;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      let info;try{info=await lstat(lock);}catch(inspect){if((inspect as NodeJS.ErrnoException).code==='ENOENT')continue;throw inspect;}
      if(!info.isDirectory()||info.isSymbolicLink())fail('invalid-local-registry','The publication lock is not a real directory');
      if(Date.now()>=until)fail('registry-lock-unavailable','Publication lock is busy or requires operator recovery');await new Promise(resolve=>setTimeout(resolve,20));}}
    const owner=join(lock,'owner.json');let ownerCreated=false,primaryFailed=false;
    try{const file=await open(owner,safeOpenNew,0o600);ownerCreated=true;let writeFailed=false;
      try{await file.writeFile(JSON.stringify({token,pid:process.pid}));}catch(error){writeFailed=true;throw error;}
      finally{try{await file.close();}catch(error){if(!writeFailed)throw error;}}
      return await operation(root);
    }catch(error){primaryFailed=true;throw error;}
    finally{let cleanupError:unknown;
      try{if(ownerCreated)await unlink(owner);}catch(error){cleanupError=error;}
      try{await rmdir(lock);}catch(error){cleanupError??=error;}
      if(!primaryFailed&&cleanupError!==undefined)throw cleanupError;}
  };
  const writeLedger=async(root:string,state:LocalModelRegistry,beforeCommit?:()=>void)=>{
    const serialized=canonicalJson(state as unknown as JsonValue)+'\n';
    if(serialized.length>MAX_LOCAL_REGISTRY_BYTES||Buffer.byteLength(serialized,'utf8')>MAX_LOCAL_REGISTRY_BYTES)
      fail('local-record-too-large','The local registry exceeds its 16 MiB metadata limit');
    const temporary=join(root,'.registry-'+process.pid+'-'+randomUUID()+'.tmp');let owned=false;
    try{const file=await open(temporary,safeOpenNew,0o600);owned=true;
      try{await file.writeFile(serialized);}finally{await file.close();}
      beforeCommit?.();await rename(temporary,join(root,'registry.json'));owned=false;
    }finally{if(owned)await unlink(temporary).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});}
  };
  // Atomic registry replacement and immutable blobs make this snapshot read
  // safe without acquiring/creating a lock. In particular lookup performs no
  // initialization, target update, file write or publication.
  const existingLedger=async(root:string):Promise<LocalModelRegistry|null>=>{
    let bytes:Uint8Array;try{bytes=await readPlainFile(join(root,'registry.json'),{maxBytes:MAX_LOCAL_REGISTRY_BYTES});}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      try{await lstat(join(root,'registry.initialized'));fail('invalid-local-registry','The initialized registry document is missing');}
      catch(marker){if((marker as NodeJS.ErrnoException).code!=='ENOENT')throw marker;}
      return null;
    }
    let parsed:unknown;try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('invalid-local-registry','The registry document is corrupt');}
    const state=validateLedger(parsed);
    let marker:Uint8Array;try{marker=await readPlainFile(join(root,'registry.initialized'),{expectedBytes:Buffer.byteLength(REGISTRY_MARKER,'utf8')});}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')fail('invalid-local-registry','The registry initialization marker is missing; operator recovery is required');
      if((error as {code?:string}).code==='artifact-bytes-mismatch')fail('invalid-local-registry','The registry initialization marker is corrupt');throw error;}
    if(new TextDecoder().decode(marker)!==REGISTRY_MARKER)fail('invalid-local-registry','The registry initialization marker is corrupt');
    for(const publication of state.publications){const content=await readPlainFile(join(root,publication.artifact.path),{expectedBytes:publication.artifact.bytes});
      if(content.length!==publication.artifact.bytes||hash(content)!==publication.artifact.sha256)fail('artifact-bytes-mismatch','A published artifact differs from its stored identity');}
    return state;
  };
  const readLedger=async(root:string):Promise<LocalModelRegistry>=>{
    const state=await existingLedger(root);if(state!==null)return state;
    const initial=empty();await writeLedger(root,initial);
    const marker=await open(join(root,'registry.initialized'),safeOpenNew,0o600);
    try{await marker.writeFile(REGISTRY_MARKER);}finally{await marker.close();}return detached(initial);
  };
  const acknowledgement=(state:LocalModelRegistry,approved:ModelPublicationPayload,claimed:string):ModelPublisherResult|null=>{
    const existing=state.idempotency.find(row=>row.key===approved.idempotencyKey);if(!existing)return null;
    if(existing.payloadSha256!==claimed)return reject('deny','idempotency-key-conflict','This idempotency key already identifies a different publication payload');
    const original=state.publications[existing.publicationIndex];
    if(original.releaseId!==approved.releaseId||original.targetName!==approved.target.name||original.idempotencyKey!==approved.idempotencyKey||
      original.payloadSha256!==claimed||original.artifact.sha256!==approved.artifact.sha256||original.artifact.bytes!==approved.artifact.bytes||original.artifact.format!==approved.artifact.format)
      return reject('deny','invalid-local-registry','The stored acknowledgement does not match the supplied publication payload');
    return detached({allowed:true,status:'already-published' as const,reasons:[reason('publication-already-recorded','The original publication is acknowledged without changing the current target')],receipt:original});
  };
  const lookup=async(request:Pick<ModelPublicationRequest,'payload'|'payloadSha256'|'preparedRef'>):Promise<ModelPublisherResult|null>=>{
    let payload:ModelPublicationPayload,claimed:string;
    try{exactFields(request,['payload','payloadSha256','preparedRef'],'publication lookup');
      payload=readModelPublicationPayload(request.payload);claimed=digest(request.payloadSha256,'payloadSha256');managedReference(request.preparedRef);
      if(await modelPublicationPayloadSha256(payload)!==claimed)return reject('deny','publication-payload-mismatch','The lookup payload differs from its supplied identity');
    }catch(error){return reject('deny',(error as {code?:string}).code??'invalid-publication-request',error instanceof Error?error.message:'Invalid publication lookup');}
    try{let info;try{info=await lstat(requestedRoot);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
      if(!info.isDirectory()||info.isSymbolicLink())fail('unsafe-artifact-root','The managed root must be a real directory');
      const state=await existingLedger(await realpath(requestedRoot));return state===null?null:acknowledgement(state,payload,claimed);
    }catch(error){const code=(error as {code?:string}).code??'local-publication-unconfirmed';
      const denied=['invalid-local-record','invalid-local-registry','local-record-too-large','unsafe-artifact-root','unsafe-artifact-path','artifact-bytes-mismatch'].includes(code);
      return reject(denied?'deny':'unknown',code,error instanceof Error?error.message:'Historical publication could not be confirmed');}
  };
  const readState=()=>withLock(root=>readLedger(root));
  return{lookup,readState,readTarget:async(name)=>{const target=nonempty(name,'target name'),state=await readState(),row=state.targets.find(row=>row.name===target);return row?state.publications[row.publicationIndex]:null;},
    publish:async(request:ModelPublicationRequest):Promise<ModelPublisherResult>=>{
      // Snapshot every caller-owned value before the first await, including a
      // Uint8Array/Buffer that the caller might mutate while storage is pending.
      let payload,bytes:Uint8Array,prepared:ArtifactRef,claimed:string;
      try{exactFields(request,['payload','payloadSha256','modelBytes','preparedRef'],'publication request');
        payload=readModelPublicationPayload(request.payload);claimed=digest(request.payloadSha256,'payloadSha256');prepared=managedReference(request.preparedRef);
        if(!(request.modelBytes instanceof Uint8Array))fail('invalid-release-bytes','Model content must be Uint8Array bytes');bytes=new Uint8Array(request.modelBytes);
        if(bytes.length!==payload.artifact.bytes||hash(bytes)!==payload.artifact.sha256)return reject('deny','publication-artifact-mismatch','Received model bytes differ from the approved artifact identity');
        if(await modelPublicationPayloadSha256(payload)!==claimed)return reject('deny','publication-payload-mismatch','Received publication payload differs from its approved identity');
      }catch(error){return reject('deny',(error as {code?:string}).code??'invalid-publication-request',error instanceof Error?error.message:'Invalid publication request');}
      const approved=payload;
      try{return await withLock(async root=>{
        const state=await readLedger(root),existing=acknowledgement(state,approved,claimed);if(existing!==null)return existing;
        const current=state.targets.find(row=>row.name===approved.target.name);
        if((current?.revision??null)!==approved.target.expectedRevision)return reject('deny','target-revision-conflict','The current target revision differs from the approved compare-and-swap expectation');
        const fresh=()=>{if(approved.validUntil!==null&&Date.now()>approved.validUntil)fail('publication-expired','The approved publication expired before a new local commit');};fresh();
        const artifact=await store.put(bytes,{format:approved.artifact.format});
        const published=detached({kind:'model-publication-receipt' as const,schemaVersion:1 as const,releaseId:approved.releaseId,
          idempotencyKey:approved.idempotencyKey,targetName:approved.target.name,revision:claimed,payloadSha256:claimed,artifact,preparedRef:prepared,committedAt:Date.now()});
        const publicationIndex=state.publications.length,next:LocalModelRegistry={kind:'local-model-registry',schemaVersion:1,publications:[...state.publications,published],
          targets:[...state.targets.filter(row=>row.name!==approved.target.name),{name:approved.target.name,revision:claimed,publicationIndex}],
          idempotency:[...state.idempotency,{key:approved.idempotencyKey,payloadSha256:claimed,publicationIndex}]};
        await writeLedger(root,next,fresh);
        return detached({allowed:true,status:'published' as const,reasons:[reason('publication-committed','One local registry document atomically records publication, target and idempotency binding')],receipt:published});
      });}catch(error){const code=(error as {code?:string}).code??'local-publication-unconfirmed';
        const denied=['invalid-local-record','invalid-local-registry','local-record-too-large','unsafe-artifact-path','artifact-bytes-mismatch','publication-expired'].includes(code);
        return reject(denied?'deny':'unknown',code,error instanceof Error?error.message:'Local publication could not be confirmed');}
    }};
}
