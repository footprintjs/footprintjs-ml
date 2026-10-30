import {lstat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {canonicalJson,detached,fail,jsonObject,nonempty} from '../contracts.js';
import type {JsonValue} from '../contracts.js';
import {prepareModelRelease,publishModelRelease,releaseModel} from '../release.js';
import type {ModelPublisher,PrepareModelReleaseRequest,PublishModelReleaseRequest,ReleaseModelRequest} from '../release.js';
import {createFileArtifactStore,readPlainFile} from '../release/files.js';

export type PythonReleaseCallback=(method:'verify_model'|'publisher.lookup'|'publisher.publish',input:unknown)=>Promise<unknown>;
function path(value:unknown,label:string){
  const result=nonempty(value,label);
  if(result.length>4096||result.includes('\0'))fail('invalid-release-field',`${label} must be a local path of at most 4096 characters`);
  return resolve(result);
}
/** File bytes stay in the optional Node host; callbacks receive managed references. */
export async function putPythonReleaseArtifact(request:Record<string,unknown>){
  const file=path(request.filePath,'filePath'),info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink())fail('unsafe-artifact-path','Release input must be a regular local file');
  const bytes=await readPlainFile(file,{expectedBytes:info.size});
  return createFileArtifactStore({root:path(request.storeRoot,'storeRoot')}).put(bytes,{format:nonempty(request.format,'format')});
}
export async function executePythonRelease(request:Record<string,unknown>,callback:PythonReleaseCallback){
  const operation=request.op,input=jsonObject(request.input,'checked release input');
  const allowed=operation==='prepare_model_release'?['planRef','modelRef','now']:
    operation==='publish_model_release'?['planRef','preparedRef','modelRef','now']:['planRef','preparedRef','modelRef','now'];
  if(Object.keys(input).some(key=>!allowed.includes(key)))fail('invalid-release-field','Checked release input has unsupported fields');
  if(typeof request.verifyModel!=='boolean'||typeof request.publisherLookup!=='boolean')
    fail('invalid-release-field','Release callback capabilities must be explicit booleans');
  const store=createFileArtifactStore({root:path(request.storeRoot,'storeRoot')});
  const verifyModel=request.verifyModel?async(value:Parameters<PrepareModelReleaseRequest['verifyModel']>[0])=>
    await callback('verify_model',value) as Awaited<ReturnType<PrepareModelReleaseRequest['verifyModel']>>:undefined;
  if(operation==='prepare_model_release'){
    if(!verifyModel)fail('release-live-verification-required','Preparation requires an explicit Python model verifier');
    return prepareModelRelease({...input,store,verifyModel} as unknown as PrepareModelReleaseRequest);
  }
  const publisher:ModelPublisher={
    publish:async(value)=>{
      // Core already snapshots and approves these exact bytes. Store that same
      // snapshot, never reopen a mutable trainer path in the Python receiver.
      const modelArtifact=await store.put(value.modelBytes,{format:value.payload.artifact.format});
      return await callback('publisher.publish',detached({payload:value.payload,payloadCanonicalJson:canonicalJson(value.payload as unknown as JsonValue),
        payloadSha256:value.payloadSha256,preparedRef:value.preparedRef,modelArtifact})) as Awaited<ReturnType<ModelPublisher['publish']>>;
    },
    ...(request.publisherLookup?{lookup:async(value:Parameters<NonNullable<ModelPublisher['lookup']>>[0])=>
      await callback('publisher.lookup',detached({...value,payloadCanonicalJson:canonicalJson(value.payload as unknown as JsonValue)})) as
        Awaited<ReturnType<NonNullable<ModelPublisher['lookup']>>>}:{}),
  };
  const native={...input,store,publisher,...(verifyModel?{verifyModel}:{})};
  return operation==='publish_model_release'?publishModelRelease(native as unknown as PublishModelReleaseRequest):
    releaseModel(native as unknown as ReleaseModelRequest);
}
