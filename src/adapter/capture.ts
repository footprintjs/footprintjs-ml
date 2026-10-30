import {randomUUID} from 'node:crypto';
import {mkdir,rename,unlink,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import type {Readable,Writable} from 'node:stream';
import {StringDecoder} from 'node:string_decoder';
import {cloneJson,isRecord,jsonObject} from '../contracts.js';
import {checkRelease} from '../guard.js';
import {createDataLineageReceipt,readDataLineageReceipt,checkDataLineage} from '../lineage.js';
import {createEvaluationReceipt,readEvaluationReceipt} from '../receipts.js';
import {readSelectionManifest,createSelectionReceipt,readSelectionReceipt,checkSelection} from '../selection.js';
import {createPredictionContract,readPredictionContract,createInferenceReceipt,readInferenceReceipt,checkInference} from '../inference.js';
import {readModelReleasePlan} from '../release.js';
import {executePythonRelease,putPythonReleaseArtifact} from './python-release.js';
import type {PythonReleaseCallback} from './python-release.js';

export interface PythonCaptureServeOptions {
  readonly input?: Readable;
  readonly output?: Writable;
  readonly maxPacketBytes?: number;
  readonly maxValueBytes?: number;
  readonly maxRecordingBytes?: number;
  readonly maxStages?: number;
  readonly maxStageOperations?: number;
}
class CaptureError extends Error {
  constructor(readonly code: string,message: string){super(message);}
}
function positive(value: unknown): value is number {return typeof value==='number'&&Number.isSafeInteger(value)&&value>0;}
function text(value: unknown,label: string): string {
  if(typeof value!=='string'||!value.trim()||value.length>512||/[\u0000-\u001f]/.test(value))throw new CaptureError('protocol',`${label} must be a nonempty string of at most 512 characters.`);
  return value;
}
function rootKey(value: unknown): string {
  const key=text(value,'key');
  if(['__proto__','prototype','constructor'].includes(key))throw new CaptureError('unsafe-key','Unsafe root scope key.');
  return key;
}
const bytes=(value: unknown)=>Buffer.byteLength(JSON.stringify(value));
function boundedJson(value: unknown,maximum: number,label: string){
  const copy=cloneJson(value,label);
  if(bytes(copy)>maximum)throw new CaptureError('limit',`${label} exceeds its JSON byte limit.`);
  return copy;
}
type StageNode={id:string;name:string;runtimeStageId:string;stageReads:Record<string,unknown>;next?:StageNode;errors?:Record<string,unknown>};
type StageObservation={runtimeStageId:string;stageId:string;name:string;status:'running'|'committed'|'discarded';attempt?:number;retryOf?:string;error?:unknown;commitIdx?:number};

/** Explicit, optional JSON-lines capture host. Importing this module starts nothing and loads no foottrace. */
export async function servePythonCapture(options: PythonCaptureServeOptions={}): Promise<void> {
  const limits={maxPacketBytes:options.maxPacketBytes??1_048_576,maxValueBytes:options.maxValueBytes??65_536,
    maxRecordingBytes:options.maxRecordingBytes??8_388_608,maxStages:options.maxStages??2048,maxStageOperations:options.maxStageOperations??1024};
  for(const [name,value] of Object.entries(limits))if(!positive(value))throw new TypeError(`${name} must be a positive safe integer`);
  // Only an explicitly started capture host requires the caller's installed peer.
  const {SharedMemory,EventLog,RecordFrame,memorySink}=await import('foottrace/write');
  const {buildRuntimeStageId,isExecutionKey,parseRuntimeStageId}=await import('foottrace');
  const input=options.input??process.stdin,output=options.output??process.stdout;
  let session: {path:string;runId:string;state:InstanceType<typeof SharedMemory>;log:InstanceType<typeof EventLog>;
    first?:StageNode;last?:StageNode;stages:StageObservation[];missingReads:{runtimeStageId:string;key:string}[];
    lifecycle:'open'|'closed'|'interrupted'}|undefined;
  let active:{frame:InstanceType<typeof RecordFrame>;node:StageNode;observation:StageObservation;operations:number}|undefined;
  let executionIndex=0,lastId=0,ended=false,persistenceFailed=false;
  let callbackId=0,transportEnded=false,protocolFailed=false;
  let pendingCallback:{id:number;callId:number;accept:(value:unknown)=>void;reject:(error:Error)=>void}|undefined;
  const callback=(id:number,method:Parameters<PythonReleaseCallback>[0],value:unknown):Promise<unknown>=>{
    if(transportEnded||protocolFailed||pendingCallback)throw new CaptureError('protocol','A release callback cannot start in this transport state.');
    const callId=++callbackId,packet=boundedJson({type:'callback',id,callId,method,input:value},limits.maxPacketBytes-1,'release callback');
    return new Promise((accept,reject)=>{
      pendingCallback={id,callId,accept,reject};
      void respond(packet).catch(error=>{pendingCallback=undefined;reject(error);});
    });
  };
  const opened=()=>{if(!session)throw new CaptureError('state','Open a capture first.');return session;};
  const current=()=>{opened();if(!active)throw new CaptureError('state','Begin a stage first.');return active;};
  const scopeOperation=()=>{const a=current();if(a.operations>=limits.maxStageOperations)throw new CaptureError('limit','Stage exceeds maxStageOperations.');a.operations++;return a;};
  const recording=()=>{
    const s=opened();
    return {schema:'footprint-ml-python-capture/v1',producer:{kind:'python-orchestrator/native-foottrace-writer',schemaVersion:1},
      snapshot:{runId:s.runId,logAddress:s.log.address,initialState:s.log.getInitialState(),commitLog:s.log.list(),
        sharedState:cloneJson(s.state.getState()),executionTree:s.first??{},commitValues:'full',writeProvenance:'reads-prefix'},
      supplemental:{pythonCapture:{lifecycle:s.lifecycle,stages:s.stages,missingReads:s.missingReads}},
      boundaries:['Python owns stage order, retries and numerical operations. The optional host records live scope requests with the native foottrace writer.',
        'Stage reads describe actual capture.get requests, not arbitrary Python variable or backend tensor reads. No FootPrint executor capture attestation is claimed.',
        'Discarded stages have no committed writes. Attempt and retry labels are supplied by the Python caller; no native retry policy is inferred.',
        'The file is replaced after commits, discards and close. This is not a write-ahead log or a promise of crash durability.',
        'No control-dependency lookup is supplied. Numerical correctness and unobserved backend dependencies remain outside this record.']};
  };
  const save=async(first=false)=>{
    try{
      const s=opened(),value=recording();
      const encoded=JSON.stringify(value,null,2)+'\n';
      if(Buffer.byteLength(encoded)>limits.maxRecordingBytes)throw new CaptureError('limit','Recording exceeds maxRecordingBytes. Prior saved evidence is preserved; stop this capture.');
      if(first){await mkdir(dirname(s.path),{recursive:true});await writeFile(s.path,encoded,{flag:'wx'});return;}
      const temporary=`${s.path}.${randomUUID()}.tmp`;
      try{await writeFile(temporary,encoded,{flag:'wx'});await rename(temporary,s.path);}
      finally{await unlink(temporary).catch(()=>{});}
    }catch(error){if(!first)persistenceFailed=true;throw error;}
  };
  const discard=async(error?:unknown)=>{
    const a=current();
    const observed=error===undefined?undefined:boundedJson(error,4096,'stage error');
    a.frame.discard();a.observation.status='discarded';
    if(observed!==undefined){a.observation.error=observed;a.node.errors={python:observed};}
    active=undefined;await save();return {discarded:true,runtimeStageId:a.node.runtimeStageId};
  };
  const execute=async(request:Record<string,unknown>):Promise<unknown>=>{
    if(persistenceFailed&&request.op!=='snapshot')throw new CaptureError('storage','Capture persistence failed; no further operations are accepted. Prior saved evidence is preserved.');
    const fields:Record<string,readonly string[]>={open:['path','runId','initialState'],begin:['stageId','name','attempt','retryOf'],
      get:['key'],set:['key','value'],commit:[],discard:['error'],snapshot:[],close:[],check_release:['input'],create_evaluation_receipt:['input'],
      read_evaluation_receipt:['input'],create_data_lineage_receipt:['input'],read_data_lineage_receipt:['input'],check_data_lineage:['input'],
      read_selection_manifest:['input'],create_selection_receipt:['input'],read_selection_receipt:['input'],check_selection:['input'],
      create_prediction_contract:['input'],read_prediction_contract:['input'],create_inference_receipt:['input'],read_inference_receipt:['input'],check_inference:['input'],
      read_model_release_plan:['input'],put_release_artifact:['filePath','storeRoot','format'],
      prepare_model_release:['input','storeRoot','verifyModel','publisherLookup'],publish_model_release:['input','storeRoot','verifyModel','publisherLookup'],
      release_model:['input','storeRoot','verifyModel','publisherLookup']};
    const allowed=Object.hasOwn(fields,String(request.op))?fields[String(request.op)]:undefined;
    if(!allowed)throw new CaptureError('protocol','Unknown capture operation.');
    if(Object.keys(request).some(key=>key!=='id'&&key!=='op'&&!allowed.includes(key)))throw new CaptureError('protocol','Capture request has an unsupported field.');
    switch(request.op){
      case 'open':{
        if(session)throw new CaptureError('state','A capture may be opened only once.');
        const path=resolve(text(request.path,'path')),runId=request.runId===undefined?randomUUID():text(request.runId,'runId');
        const base=jsonObject(boundedJson(request.initialState??{},limits.maxValueBytes,'initialState'));
        Object.keys(base).forEach(rootKey);
        const state=new SharedMemory(undefined,base);
        const log=new EventLog(state.getState(),{sink:memorySink(),address:{logRunId:runId,drillPath:[]}});
        session={path,runId,state,log,stages:[],missingReads:[],lifecycle:'open'};
        try{await save(true);}catch(error){session=undefined;throw error;}
        return {path,runId};
      }
      case 'begin':{
        const s=opened();if(active)throw new CaptureError('state','Only one root stage may be active.');
        if(s.stages.length>=limits.maxStages)throw new CaptureError('limit','Capture exceeds maxStages.');
        const stageId=text(request.stageId,'stageId'),name=request.name===undefined?stageId:text(request.name,'name');
        if(request.attempt!==undefined&&!positive(request.attempt))throw new CaptureError('protocol','attempt must be a positive safe integer.');
        const retryOf=request.retryOf===undefined?undefined:text(request.retryOf,'retryOf');
        if(retryOf!==undefined&&!s.stages.some(stage=>stage.runtimeStageId===retryOf&&stage.status==='discarded'))
          throw new CaptureError('protocol','retryOf must name a previously discarded execution in this capture.');
        const runtimeStageId=buildRuntimeStageId(stageId,executionIndex),parsed=parseRuntimeStageId(runtimeStageId);
        if(isExecutionKey(stageId)||parsed.subflowPath!==undefined||parsed.stageId!==stageId||parsed.executionIndex!==executionIndex||
          buildRuntimeStageId(parsed.stageId,parsed.executionIndex,parsed.subflowPath)!==runtimeStageId)
          throw new CaptureError('protocol','stageId must be a root stage identifier, not a runtime or subflow address.');
        executionIndex++;
        const node:StageNode={id:stageId,name,runtimeStageId,stageReads:Object.create(null)};
        const observation:StageObservation={runtimeStageId,stageId,name,status:'running',
          ...(request.attempt===undefined?{}:{attempt:request.attempt as number}),...(retryOf===undefined?{}:{retryOf})};
        if(s.last)s.last.next=node;else s.first=node;s.last=node;s.stages.push(observation);
        const frame=new RecordFrame(s.state,s.log,[]);
        frame.useEncoding({commitValues:'full',writeProvenance:'reads-prefix'});
        active={frame,node,observation,operations:0};return {runtimeStageId,stageId};
      }
      case 'get':{
        const a=scopeOperation(),key=rootKey(request.key),value=a.frame.read([],key);
        a.frame.noteRead([],key);a.node.stageReads[key]=value===undefined?'missing':'summary';
        if(value===undefined){opened().missingReads.push({runtimeStageId:a.node.runtimeStageId,key});return {present:false};}
        return {present:true,value:boundedJson(value,limits.maxValueBytes,'scope value')};
      }
      case 'set':{
        const a=scopeOperation(),key=rootKey(request.key),value=boundedJson(request.value,limits.maxValueBytes,'scope value');
        a.frame.write(a.frame.at([],key),value,'set');return {staged:true};
      }
      case 'commit':{
        const a=current(),s=opened();
        a.frame.commit(()=>({stage:a.node.name,stageId:a.node.id,runtimeStageId:a.node.runtimeStageId}));
        a.frame.release();a.observation.status='committed';a.observation.commitIdx=s.log.length-1;
        active=undefined;await save();return {runtimeStageId:a.node.runtimeStageId,commitIdx:s.log.length-1};
      }
      case 'discard':return discard(request.error);
      case 'snapshot':return recording();
      case 'check_release':
        opened();return checkRelease(jsonObject(boundedJson(request.input,limits.maxPacketBytes,'release input')) as unknown as Parameters<typeof checkRelease>[0]);
      case 'create_evaluation_receipt':
        opened();return createEvaluationReceipt(jsonObject(boundedJson(request.input,limits.maxPacketBytes,'evaluation input')) as unknown as Parameters<typeof createEvaluationReceipt>[0]);
      case 'read_evaluation_receipt':
        opened();return readEvaluationReceipt(boundedJson(request.input,limits.maxPacketBytes,'evaluation receipt'));
      case 'create_data_lineage_receipt':
        opened();return createDataLineageReceipt(boundedJson(request.input,limits.maxPacketBytes,'data lineage input') as unknown as Parameters<typeof createDataLineageReceipt>[0]);
      case 'read_data_lineage_receipt':
        opened();return readDataLineageReceipt(boundedJson(request.input,limits.maxPacketBytes,'data lineage receipt'));
      case 'check_data_lineage':
        opened();return checkDataLineage(boundedJson(request.input,limits.maxPacketBytes,'data lineage request') as unknown as Parameters<typeof checkDataLineage>[0]);
      case 'read_selection_manifest':
        opened();return readSelectionManifest(boundedJson(request.input,limits.maxPacketBytes,'selection manifest'));
      case 'create_selection_receipt':
        opened();return createSelectionReceipt(boundedJson(request.input,limits.maxPacketBytes,'selection input') as unknown as Parameters<typeof createSelectionReceipt>[0]);
      case 'read_selection_receipt':
        opened();return readSelectionReceipt(boundedJson(request.input,limits.maxPacketBytes,'selection receipt'));
      case 'check_selection':
        opened();return checkSelection(boundedJson(request.input,limits.maxPacketBytes,'selection request') as unknown as Parameters<typeof checkSelection>[0]);
      case 'create_prediction_contract':
        opened();return createPredictionContract(boundedJson(request.input,limits.maxPacketBytes,'prediction contract input') as unknown as Parameters<typeof createPredictionContract>[0]);
      case 'read_prediction_contract':
        opened();return readPredictionContract(boundedJson(request.input,limits.maxPacketBytes,'prediction contract'));
      case 'create_inference_receipt':
        opened();return createInferenceReceipt(boundedJson(request.input,limits.maxPacketBytes,'inference input') as unknown as Parameters<typeof createInferenceReceipt>[0]);
      case 'read_inference_receipt':
        opened();return readInferenceReceipt(boundedJson(request.input,limits.maxPacketBytes,'inference receipt'));
      case 'check_inference':
        opened();return checkInference(boundedJson(request.input,limits.maxPacketBytes,'inference request') as unknown as Parameters<typeof checkInference>[0]);
      case 'read_model_release_plan':
        opened();return readModelReleasePlan(boundedJson(request.input,limits.maxPacketBytes,'release plan'));
      case 'put_release_artifact':
        opened();return putPythonReleaseArtifact(request);
      case 'prepare_model_release':case 'publish_model_release':case 'release_model':
        opened();return executePythonRelease(request,(method,value)=>callback(request.id as number,method,value));
      case 'close':{
        const s=opened();if(active)throw new CaptureError('state','Commit or discard the active stage before close.');
        s.log.close('ok');s.lifecycle='closed';await save();ended=true;
        return {path:s.path,runId:s.runId,commits:s.log.length,closed:true};
      }
      default:throw new CaptureError('protocol','Unknown capture operation.');
    }
  };
  const respond=async(value:unknown)=>{
    let encoded=JSON.stringify(value)+'\n';
    if(Buffer.byteLength(encoded)>limits.maxPacketBytes){
      const id=isRecord(value)?value.id:null;
      encoded=JSON.stringify({id,ok:false,error:{code:'limit',message:'Response exceeds maxPacketBytes; read the saved recording file instead.'}})+'\n';
    }
    await new Promise<void>((accept,reject)=>output.write(encoded,error=>error?reject(error):accept()));
  };
  const failure=(id:number|null,error:unknown)=>{
    const code=error instanceof CaptureError?error.code:isRecord(error)&&typeof error.code==='string'?error.code:'capture';
    const message=error instanceof Error?error.message:'Capture request failed.';
    return {id,ok:false,error:{code,message}};
  };
  let work=Promise.resolve();
  const enqueue=(operation:()=>Promise<void>)=>{work=work.then(operation);void work.catch(()=>{});};
  const abortCallback=(error:Error)=>{const pending=pendingCallback;pendingCallback=undefined;pending?.reject(error);};
  const line=async(value:string,oversized=false)=>{
    let id:number|null=null,callbackPacket=false;
    try{
      if(oversized)throw new CaptureError('limit','Request exceeds maxPacketBytes.');
      let parsed:unknown;try{parsed=JSON.parse(value);}catch{throw new CaptureError('protocol','Request is not JSON.');}
      const request=jsonObject(parsed,'capture request');
      callbackPacket=request.op==='callback_result';
      if(!positive(request.id))throw new CaptureError('protocol','Request id must be a positive safe integer.');
      id=request.id;
      if(request.op==='callback_result'){
        const pending=pendingCallback;
        if(!pending||request.id!==pending.id||request.callId!==pending.callId||typeof request.ok!=='boolean'||
          Object.keys(request).some(key=>!['id','op','callId','ok',request.ok?'result':'error'].includes(key))||
          !Object.hasOwn(request,request.ok?'result':'error'))
          throw new CaptureError('protocol','Callback result did not match the active parent request and callId.');
        if(!request.ok){const error=jsonObject(request.error,'callback error');
          if(Object.keys(error).some(key=>!['code','message'].includes(key))||typeof error.code!=='string'||!error.code||error.code.length>128||
            typeof error.message!=='string'||error.message.length>4096)throw new CaptureError('protocol','Callback error details are invalid.');
          pendingCallback=undefined;pending.reject(new CaptureError(error.code,error.message));
        }else{pendingCallback=undefined;pending.accept(request.result);}
        return;
      }
      if(protocolFailed)throw new CaptureError('protocol','Capture transport failed.');
      if(pendingCallback)throw new CaptureError('protocol','Nested capture requests are not permitted during a release callback.');
      if(id<=lastId)throw new CaptureError('protocol','Request ids must increase.');lastId=id;
      if(typeof request.op!=='string')throw new CaptureError('protocol','Request op must be a string.');
      const requestId=id;
      enqueue(async()=>{
        try{if(ended||protocolFailed)throw new CaptureError('state','Capture is closed or its transport failed.');
          const result=await execute(request);await respond({id:requestId,ok:true,result});if(ended)input.destroy();
        }catch(error){await respond(failure(requestId,error));}
      });
    }catch(error){
      if(pendingCallback||callbackPacket){
        protocolFailed=true;abortCallback(new CaptureError('protocol','Invalid release callback transport.'));input.destroy();
      }
      enqueue(async()=>{await respond(failure(id,error));});
    }
  };
  const decoder=new StringDecoder('utf8');let buffered='',oversized=false;
  try{
    for await(const chunk of input){
      buffered+=typeof chunk==='string'?chunk:decoder.write(chunk);
      let boundary:number;
      while((boundary=buffered.indexOf('\n'))>=0){
        const packet=buffered.slice(0,boundary);buffered=buffered.slice(boundary+1);
        await line(packet,oversized||Buffer.byteLength(packet)>limits.maxPacketBytes);oversized=false;
      }
      if(Buffer.byteLength(buffered)>limits.maxPacketBytes){buffered='';oversized=true;}
    }
    buffered+=decoder.end();if(buffered.trim()||oversized)await line(buffered,oversized);
  }catch(error){if(!ended&&!protocolFailed)throw error;
  }finally{
    transportEnded=true;abortCallback(new CaptureError('protocol','Capture input ended before a release callback completed.'));
    await work;
    if(session&&!ended){
      if(active){active.frame.discard();active.observation.status='discarded';active.observation.error={type:'CaptureTransportEnded',message:'Capture input ended before stage commit.'};
        active.node.errors={python:active.observation.error};active=undefined;}
      session.lifecycle='interrupted';session.log.close('failed');if(!persistenceFailed)await save();
    }
  }
}
