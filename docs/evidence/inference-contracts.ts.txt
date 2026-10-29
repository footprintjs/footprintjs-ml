import {artifactRef,canonicalJson,detached,fail,finiteNumber,jsonObject,nonempty,readModelRef,
  sameArtifact,sameInference} from './contracts.js';
import type {ArtifactRef,JsonObject,JsonValue,ModelRef} from './contracts.js';

/** Ordered named fields, not a validator for numerical arrays or tensor shapes. */
export interface PredictionField {
  readonly name: string;
  readonly dtype: string;
  readonly unit?: string;
}
export interface PredictionFields {readonly fields: readonly PredictionField[]}
export interface PredictionContractInput {
  readonly profile: string;
  readonly input: PredictionFields;
  readonly output: PredictionFields;
  readonly preprocessingVersion: string;
  readonly classLabels?: readonly (string | number)[];
  readonly parameters?: JsonObject;
}
export interface PredictionContract extends PredictionContractInput {
  readonly kind: 'prediction-contract';
  readonly schemaVersion: 1;
  readonly parameters: JsonObject;
}
export interface InferenceReceiptInput<M extends ModelRef = ModelRef> {
  readonly inferenceId: string;
  readonly createdAt: number;
  readonly inputRef: ArtifactRef;
  readonly outputRef: ArtifactRef;
  readonly inputRows: number;
  readonly outputRows: number;
  /** Omit when the backend did not observe the model actually used. */
  readonly modelRef?: M;
  /** Omit when the backend did not observe the prediction contract actually used. */
  readonly contract?: PredictionContract;
}
export interface InferenceReceipt<M extends ModelRef = ModelRef> extends InferenceReceiptInput<M> {
  readonly kind: 'inference-receipt';
  readonly schemaVersion: 1;
}
export interface InferenceRequest {
  readonly receipt: unknown;
  /** Expected model and context must be supplied independently of the offered receipt. */
  readonly modelRef: ModelRef;
  readonly contract: PredictionContract;
  readonly inputRef: ArtifactRef;
  readonly rows: number;
  readonly inferenceId: string;
  readonly now?: number;
  readonly maxAgeMs?: number;
}
export interface InferenceReason {readonly code: string;readonly message: string}
export interface InferenceDecision {
  readonly kind: 'inference-decision';
  readonly schemaVersion: 1;
  readonly allowed: boolean;
  readonly status: 'allow' | 'deny' | 'unknown';
  readonly reasons: readonly InferenceReason[];
  readonly checkedAt: number | null;
  readonly inferenceId: string | null;
  readonly bindings: {readonly expected: JsonValue;readonly receipt: JsonValue};
}

function exactKeys(value: JsonObject,keys: readonly string[],label: string): void {
  for(const key of Object.keys(value))if(!keys.includes(key))
    fail('invalid-inference-field',`${label}.${key} is not a supported field`);
}
function rows(value: unknown,label: string): number {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)
    fail('invalid-inference-rows',`${label} must be a positive safe integer`);
  return value;
}
function fields(value: unknown,label: string): PredictionFields {
  const copy=jsonObject(value,label);exactKeys(copy,['fields'],label);
  if(!Array.isArray(copy.fields)||copy.fields.length<1||copy.fields.length>256)
    fail('invalid-prediction-fields',`${label}.fields must contain between 1 and 256 ordered fields`);
  const observed=copy.fields.map((value,index)=>{
    const field=jsonObject(value,`${label}.fields[${index}]`);
    exactKeys(field,['name','dtype','unit'],`${label}.fields[${index}]`);
    return {name:nonempty(field.name,`${label}.fields[${index}].name`),
      dtype:nonempty(field.dtype,`${label}.fields[${index}].dtype`),
      ...(field.unit===undefined?{}:{unit:nonempty(field.unit,`${label}.fields[${index}].unit`)})};
  });
  if(new Set(observed.map(field=>field.name)).size!==observed.length)
    fail('duplicate-prediction-field',`${label}.fields must have unique names`);
  return {fields:observed};
}
function prediction(value: unknown,saved: boolean): PredictionContract {
  const copy=jsonObject(value,'prediction contract');
  exactKeys(copy,['profile','input','output','preprocessingVersion','parameters','classLabels',
    ...(saved?['kind','schemaVersion']:[])],'prediction contract');
  if(saved&&(copy.kind!=='prediction-contract'||copy.schemaVersion!==1))
    fail('invalid-prediction-contract','Unsupported or missing prediction contract schema');
  const input=fields(copy.input,'input'),output=fields(copy.output,'output');
  let classLabels: (string|number)[]|undefined;
  if(Object.hasOwn(copy,'classLabels')){
    if(!Array.isArray(copy.classLabels)||copy.classLabels.length<1||copy.classLabels.length>1024||
      copy.classLabels.some(label=>typeof label!=='string'&&typeof label!=='number'))
      fail('invalid-prediction-labels','classLabels must contain between 1 and 1024 ordered string or finite-number labels');
    classLabels=copy.classLabels as (string|number)[];
    if(new Set(classLabels.map(label=>canonicalJson(label))).size!==classLabels.length)
      fail('invalid-prediction-labels','classLabels must be unique, preserving their type and order');
  }
  // Saved v1 evidence must retain its parameters; creation supplies the empty default.
  const parameters=copy.parameters===undefined&&!saved?{}:jsonObject(copy.parameters,'prediction parameters');
  return detached({kind:'prediction-contract' as const,schemaVersion:1 as const,
    profile:nonempty(copy.profile,'prediction profile'),input,output,
    preprocessingVersion:nonempty(copy.preprocessingVersion,'preprocessingVersion'),parameters,
    ...(classLabels===undefined?{}:{classLabels})});
}

/** Define explicit prediction semantics. No data is inspected and no digest is measured. */
export function createPredictionContract(input: PredictionContractInput): PredictionContract {
  return prediction(input,false);
}
/** Read the declared v1 schema without filling missing saved observations from a request. */
export function readPredictionContract(value: unknown): PredictionContract {return prediction(value,true);}

function observedInference<M extends ModelRef>(value: unknown,saved: boolean): InferenceReceipt<M> {
  const copy=jsonObject(value,'inference receipt');
  exactKeys(copy,['inferenceId','createdAt','inputRef','outputRef','inputRows','outputRows','modelRef','contract',
    ...(saved?['kind','schemaVersion']:[])],'inference receipt');
  if(saved&&(copy.kind!=='inference-receipt'||copy.schemaVersion!==1))
    fail('invalid-inference-receipt','Unsupported or missing inference receipt schema');
  return detached({kind:'inference-receipt' as const,schemaVersion:1 as const,
    inferenceId:nonempty(copy.inferenceId,'inferenceId'),createdAt:finiteNumber(copy.createdAt,'createdAt',0),
    inputRef:artifactRef(copy.inputRef),outputRef:artifactRef(copy.outputRef),
    inputRows:rows(copy.inputRows,'inputRows'),outputRows:rows(copy.outputRows,'outputRows'),
    ...(Object.hasOwn(copy,'modelRef')?{modelRef:readModelRef<M>(copy.modelRef)}:{}),
    ...(Object.hasOwn(copy,'contract')?{contract:readPredictionContract(copy.contract)}:{})});
}
/** Retain actual backend observations; missing model/contract evidence stays absent. */
export function createInferenceReceipt<M extends ModelRef = ModelRef>(input: InferenceReceiptInput<M>): InferenceReceipt<M> {
  return observedInference<M>(input,false);
}
/** Validate saved references and observations without performing prediction again. */
export function readInferenceReceipt(value: unknown): InferenceReceipt {return observedInference<ModelRef>(value,true);}

/** Consistency check only: no output arithmetic, artifact bytes, approval or deployment is verified. */
export function checkInference(input: InferenceRequest): InferenceDecision {
  let receipt: InferenceReceipt|undefined,checkedAt:number|null=null;
  let expected:JsonValue=null,recorded:JsonValue=null;
  const reasons:InferenceReason[]=[];let denied=false,unknown=false;
  const deny=(code:string,message:string)=>{denied=true;reasons.push({code,message});};
  const missing=(code:string,message:string)=>{unknown=true;reasons.push({code,message});};
  const compareFields=(wanted:PredictionFields,actual:PredictionFields,side:'input'|'output')=>{
    if(canonicalJson(wanted.fields.map(field=>field.name))!==canonicalJson(actual.fields.map(field=>field.name)))
      deny(`prediction-${side}-fields-mismatch`,`The ordered ${side} field names differ from the independently expected fields.`);
    for(let index=0;index<Math.min(wanted.fields.length,actual.fields.length);index++){
      const want=wanted.fields[index],found=actual.fields[index];
      if(want.dtype!==found.dtype)
        deny(`prediction-${side}-dtype-mismatch`,`${side} field ${index} has dtype ${found.dtype}; expected ${want.dtype}.`);
      if(want.name!==found.name)continue;
      if((want.unit===undefined)!==(found.unit===undefined))
        missing(`prediction-${side}-unit-unavailable`,`${side} field ${want.name} has a unit on only one side; both expected and observed units are required to compare it.`);
      else if(want.unit!==found.unit)
        deny(`prediction-${side}-unit-mismatch`,`${side} field ${want.name} has a different observed unit.`);
    }
  };
  try{
    const copy=jsonObject(input,'inference request');
    exactKeys(copy,['receipt','modelRef','contract','inputRef','rows','inferenceId','now','maxAgeMs'],'inference request');
    const modelRef=readModelRef(copy.modelRef),contract=readPredictionContract(copy.contract),inputRef=artifactRef(copy.inputRef);
    const expectedRows=rows(copy.rows,'rows'),inferenceId=nonempty(copy.inferenceId,'inferenceId');
    checkedAt=finiteNumber(copy.now===undefined?Date.now():copy.now,'now',0);
    const maxAgeMs=copy.maxAgeMs===undefined?undefined:finiteNumber(copy.maxAgeMs,'maxAgeMs',0);
    receipt=readInferenceReceipt(copy.receipt);
    expected=jsonObject({modelRef,contract,inputRef,rows:expectedRows,inferenceId,...(maxAgeMs===undefined?{}:{maxAgeMs})});
    recorded=jsonObject(receipt);
    if(receipt.inferenceId!==inferenceId)
      deny('inference-id-mismatch','The receipt belongs to a different independently expected inference invocation.');
    if(!sameArtifact(inputRef,receipt.inputRef))
      deny('inference-input-mismatch','The consumed input digest, byte count or format differs from the expected input.');
    if(receipt.inputRows!==expectedRows)
      deny('inference-input-rows-mismatch','The consumed input row count differs from the expected batch.');
    if(receipt.outputRows!==expectedRows)
      deny('inference-output-rows-mismatch','The observed output row count differs from the expected batch.');
    if(receipt.createdAt>checkedAt)deny('inference-receipt-from-future','The inference receipt is dated after this check.');
    if(maxAgeMs!==undefined&&checkedAt-receipt.createdAt>maxAgeMs)
      deny('inference-receipt-expired','The inference receipt exceeds the independently specified maximum age.');
    if(receipt.modelRef===undefined)missing('inference-model-unavailable','The backend did not observe the model actually used.');
    if(modelRef.inferenceIdentity===undefined||receipt.modelRef?.inferenceIdentity===undefined){
      missing('inference-identity-unavailable','Expected and observed models both need a measured inference profile and digest; checkpoint-only evidence is insufficient.');
    }else if(!sameInference(modelRef.inferenceIdentity,receipt.modelRef.inferenceIdentity)){
      deny('inference-model-mismatch','The observed model inference profile or digest differs from the independently expected model.');
    }else{
      reasons.push({code:'inference-identity-matches',message:'The observed model inference profile and digest match the expected model.'});
      if(!sameArtifact(modelRef.originArtifact,receipt.modelRef.originArtifact))
        reasons.push({code:'checkpoint-differs-inference-matches',message:'Full checkpoint content differs; inference identity matches. This is inference coverage, not a claim of identical resumable training state.'});
    }
    if(receipt.contract===undefined){
      missing('inference-contract-unavailable','The backend did not observe the prediction contract actually used.');
    }else{
      const actual=receipt.contract;
      if(contract.profile!==actual.profile)deny('prediction-profile-mismatch','The observed prediction contract profile differs.');
      compareFields(contract.input,actual.input,'input');compareFields(contract.output,actual.output,'output');
      if(contract.preprocessingVersion!==actual.preprocessingVersion)
        deny('prediction-preprocessing-mismatch','The observed preprocessing version differs from the independently expected version.');
      if(canonicalJson(contract.parameters)!==canonicalJson(actual.parameters))
        deny('prediction-parameters-mismatch','The observed prediction parameters differ from the independently expected parameters.');
      if((contract.classLabels===undefined)!==(actual.classLabels===undefined))
        missing('prediction-class-labels-unavailable','Class labels occur on only one side; expected and observed label mappings are both required to compare them.');
      else if(contract.classLabels!==undefined&&actual.classLabels!==undefined&&
        canonicalJson(contract.classLabels)!==canonicalJson(actual.classLabels))
        deny('prediction-class-labels-mismatch','The observed class labels, types or order differ from the independently expected mapping.');
    }
  }catch(error){missing('invalid-or-missing-inference-evidence',error instanceof Error?error.message:'Invalid inference evidence');}
  const allowed=!denied&&!unknown;
  if(allowed)reasons.push({code:'inference-matches-expectation',message:'Observed inference identity, contract, input, invocation and row counts match the independently supplied expectation.'});
  return detached({kind:'inference-decision' as const,schemaVersion:1 as const,allowed,
    status:allowed?'allow' as const:denied?'deny' as const:'unknown' as const,reasons,checkedAt,
    inferenceId:receipt?.inferenceId??null,bindings:{expected,receipt:recorded}});
}
