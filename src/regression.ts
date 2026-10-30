import {artifactRef,canonicalJson,detached,fail,finiteNumber,jsonObject,nonempty,readDatasetRef,
  readModelRef,sameArtifact,sameDataset,sameModelContent} from './contracts.js';
import type {ArtifactRef,DatasetRef,EvaluationReceipt,JsonObject,JsonValue,ModelRef} from './contracts.js';
import {readEvaluationReceipt} from './receipts.js';

/** A predefined subset, not a group discovered by this library from metric values. */
export interface RegressionGroup {
  readonly groupId: string;
  readonly definitionRef: ArtifactRef;
  readonly membershipRef: ArtifactRef;
  readonly datasetRef: DatasetRef;
  readonly expectedRows: number;
}
export interface RegressionPolicy {
  readonly groupId: string;
  readonly metric: string;
  readonly direction: 'max' | 'min';
  /** Absolute metric units; this is not a relative percentage or a statistical test. */
  readonly maxDeterioration: number;
  readonly minSamples: number;
}
export interface RegressionManifest {
  readonly kind: 'regression-manifest';
  readonly schemaVersion: 1;
  readonly comparisonId: string;
  readonly baselineModelRef: ModelRef;
  readonly candidateModelRef: ModelRef;
  readonly comparison: {
    readonly datasetRef: DatasetRef;
    readonly preprocessingVersion: string;
    readonly evaluationMethodVersion: string;
    readonly parameters: JsonObject;
  };
  readonly groups: readonly RegressionGroup[];
  readonly policies: readonly RegressionPolicy[];
  /** Applies to the comparison receipt and every supplied baseline/candidate evaluation. */
  readonly maxAgeMs?: number;
}
export interface RegressionObservation {
  readonly groupId: string;
  readonly definitionRef: ArtifactRef;
  readonly membershipRef: ArtifactRef;
  /** Actual observed row count. Zero/missing evaluations can retain unmeasured coverage. */
  readonly rows: number;
  readonly baseline?: EvaluationReceipt;
  readonly candidate?: EvaluationReceipt;
}
export interface RegressionReceiptInput {
  readonly regressionId: string;
  readonly createdAt: number;
  readonly manifest: RegressionManifest;
  readonly observations: readonly RegressionObservation[];
}
export interface RegressionReceipt extends RegressionReceiptInput {
  readonly kind: 'regression-receipt';
  readonly schemaVersion: 1;
}
export interface RegressionRequest {
  readonly receipt: unknown;
  /** Independently pinned protocol, never copied from the offered receipt as authority. */
  readonly manifest: RegressionManifest;
  /** Independently retained evaluator observations, never reconstructed from a receipt's claims. */
  readonly observations: readonly RegressionObservation[];
  readonly modelRef: ModelRef;
  readonly now?: number;
}
export interface RegressionReason {readonly code: string; readonly message: string}
export interface RegressionComparison {
  readonly groupId: string;
  readonly metric: string;
  readonly direction: 'max' | 'min';
  readonly baselineValue: number | null;
  readonly candidateValue: number | null;
  readonly deterioration: number | null;
  readonly maxDeterioration: number;
  readonly minSamples: number;
  readonly rows: number | null;
  /** Threshold/coverage result; the overall decision also checks bindings and evidence dates. */
  readonly status: 'allow' | 'deny' | 'unknown';
}
export interface RegressionDecision {
  readonly kind: 'regression-decision';
  readonly schemaVersion: 1;
  readonly allowed: boolean;
  readonly status: 'allow' | 'deny' | 'unknown';
  readonly reasons: readonly RegressionReason[];
  readonly checkedAt: number | null;
  readonly regressionId: string | null;
  readonly comparisonId: string | null;
  readonly comparisons: readonly RegressionComparison[];
  readonly bindings: {readonly proposed: JsonValue;readonly receipt: JsonValue;readonly expected: JsonValue};
}

const lexical=(a:string,b:string)=>a<b?-1:a>b?1:0;
const equal=(a:unknown,b:unknown)=>canonicalJson(jsonObject({value:a}).value)===canonicalJson(jsonObject({value:b}).value);
function fields(value:JsonObject,required:readonly string[],optional:readonly string[],label:string){
  if(required.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>!required.includes(key)&&!optional.includes(key)))
    fail('invalid-regression-field',`${label} has missing or unsupported fields`);
}
function count(value:unknown,label:string,minimum=1):number{
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<minimum)
    fail('invalid-regression-count',`${label} must be a safe integer >= ${minimum}`);
  return value;
}
function artifactKey(value:ArtifactRef){return {sha256:value.sha256.toLowerCase(),bytes:value.bytes,format:value.format};}
function modelKey(value:ModelRef){return {artifact:artifactKey(value.originArtifact),inferenceIdentity:value.inferenceIdentity===undefined?null:
  {profile:value.inferenceIdentity.profile,sha256:value.inferenceIdentity.sha256.toLowerCase()}};}
function datasetKey(value:DatasetRef){return {artifact:artifactKey(value.artifact),rows:value.rows,shape:value.shape,role:value.role};}
function manifestKey(value:RegressionManifest){return {comparisonId:value.comparisonId,
  baselineModelRef:modelKey(value.baselineModelRef),candidateModelRef:modelKey(value.candidateModelRef),
  comparison:{...value.comparison,datasetRef:datasetKey(value.comparison.datasetRef)},
  groups:value.groups.map(group=>({...group,definitionRef:artifactKey(group.definitionRef),membershipRef:artifactKey(group.membershipRef),
    datasetRef:datasetKey(group.datasetRef)})),policies:value.policies,maxAgeMs:value.maxAgeMs??null};}
function evaluationKey(value:EvaluationReceipt){return {schemaVersion:value.schemaVersion,evaluationId:value.evaluationId,createdAt:value.createdAt,
  modelRef:modelKey(value.modelRef),datasetRef:datasetKey(value.datasetRef),preprocessingVersion:value.preprocessingVersion,
  evaluationMethodVersion:value.evaluationMethodVersion,parameters:value.parameters,metrics:value.metrics};}
function metricAt(value:EvaluationReceipt|undefined,metric:string):number|null{
  return value!==undefined&&Object.hasOwn(value.metrics,metric)?value.metrics[metric]:null;
}

/** Validate a complete predefined protocol. This does not inspect artifact contents or compute metrics. */
export function readRegressionManifest(value:unknown):RegressionManifest{
  const copy=jsonObject(value,'regression manifest');
  fields(copy,['kind','schemaVersion','comparisonId','baselineModelRef','candidateModelRef','comparison','groups','policies'],['maxAgeMs'],'manifest');
  if(copy.kind!=='regression-manifest'||copy.schemaVersion!==1)fail('invalid-regression-manifest','Unsupported regression manifest schema');
  const raw=jsonObject(copy.comparison,'comparison');
  fields(raw,['datasetRef','preprocessingVersion','evaluationMethodVersion','parameters'],[],'comparison');
  const comparison={datasetRef:readDatasetRef(raw.datasetRef),preprocessingVersion:nonempty(raw.preprocessingVersion,'preprocessingVersion'),
    evaluationMethodVersion:nonempty(raw.evaluationMethodVersion,'evaluationMethodVersion'),parameters:jsonObject(raw.parameters,'parameters')};
  if(!Array.isArray(copy.groups)||copy.groups.length<1||copy.groups.length>128)
    fail('invalid-regression-groups','Declare between 1 and 128 predefined groups');
  const groups=copy.groups.map(value=>{
    const group=jsonObject(value,'group');
    fields(group,['groupId','definitionRef','membershipRef','datasetRef','expectedRows'],[],'group');
    const datasetRef=readDatasetRef(group.datasetRef),expectedRows=count(group.expectedRows,'expectedRows');
    if(expectedRows!==datasetRef.rows||expectedRows>comparison.datasetRef.rows)
      fail('invalid-regression-group-count','Expected group rows must match its dataset and not exceed the parent dataset');
    return {groupId:nonempty(group.groupId,'groupId'),definitionRef:artifactRef(group.definitionRef),
      membershipRef:artifactRef(group.membershipRef),datasetRef,expectedRows};
  }).sort((a,b)=>lexical(a.groupId,b.groupId));
  const groupIds=new Set(groups.map(group=>group.groupId));
  if(groupIds.size!==groups.length)fail('duplicate-regression-group','Group identifiers must be unique');
  if(!Array.isArray(copy.policies)||copy.policies.length<1||copy.policies.length>1024)
    fail('invalid-regression-policies','Declare between 1 and 1024 metric policies');
  const policies=copy.policies.map(value=>{
    const policy=jsonObject(value,'regression policy');
    fields(policy,['groupId','metric','direction','maxDeterioration','minSamples'],[],'policy');
    const groupId=nonempty(policy.groupId,'policy.groupId');
    if(!groupIds.has(groupId))fail('undeclared-regression-group','Every policy must refer to a declared group');
    if(policy.direction!=='min'&&policy.direction!=='max')fail('invalid-regression-policy','Direction must be min or max');
    return {groupId,metric:nonempty(policy.metric,'metric'),direction:policy.direction as 'min'|'max',
      maxDeterioration:finiteNumber(policy.maxDeterioration,'maxDeterioration',0),minSamples:count(policy.minSamples,'minSamples')};
  }).sort((a,b)=>lexical(a.groupId,b.groupId)||lexical(a.metric,b.metric));
  if(new Set(policies.map(policy=>canonicalJson([policy.groupId,policy.metric]))).size!==policies.length)
    fail('duplicate-regression-policy','Each group/metric pair must have exactly one policy');
  if(groups.some(group=>!policies.some(policy=>policy.groupId===group.groupId)))
    fail('uncovered-regression-group','Each declared group must have at least one policy');
  return detached({kind:'regression-manifest',schemaVersion:1,comparisonId:nonempty(copy.comparisonId,'comparisonId'),
    baselineModelRef:readModelRef(copy.baselineModelRef),candidateModelRef:readModelRef(copy.candidateModelRef),comparison,groups,policies,
    ...(copy.maxAgeMs===undefined?{}:{maxAgeMs:finiteNumber(copy.maxAgeMs,'maxAgeMs',0)})});
}
function readObservations(value:unknown):readonly RegressionObservation[]{
  if(!Array.isArray(value)||value.length>128)fail('invalid-regression-observations','Observations must be an array with at most 128 groups');
  const observations=value.map(value=>{
    const copy=jsonObject(value,'regression observation');
    fields(copy,['groupId','definitionRef','membershipRef','rows'],['baseline','candidate'],'observation');
    return {groupId:nonempty(copy.groupId,'observation.groupId'),definitionRef:artifactRef(copy.definitionRef),membershipRef:artifactRef(copy.membershipRef),
      rows:count(copy.rows,'observed rows',0),...(copy.baseline===undefined?{}:{baseline:readEvaluationReceipt(copy.baseline)}),
      ...(copy.candidate===undefined?{}:{candidate:readEvaluationReceipt(copy.candidate)})};
  }).sort((a,b)=>lexical(a.groupId,b.groupId));
  if(new Set(observations.map(value=>value.groupId)).size!==observations.length)
    fail('duplicate-regression-observation','Each group may have at most one observation');
  return detached(observations);
}

/** Preserve actual evaluator observations, including missing coverage; no approval is inferred. */
export function createRegressionReceipt(input:RegressionReceiptInput):RegressionReceipt{
  const copy=jsonObject(input,'regression receipt input');
  fields(copy,['regressionId','createdAt','manifest','observations'],[],'receipt input');
  return detached({kind:'regression-receipt',schemaVersion:1,regressionId:nonempty(copy.regressionId,'regressionId'),
    createdAt:finiteNumber(copy.createdAt,'createdAt',0),manifest:readRegressionManifest(copy.manifest),observations:readObservations(copy.observations)});
}
export function readRegressionReceipt(value:unknown):RegressionReceipt{
  const copy=jsonObject(value,'regression receipt');
  fields(copy,['kind','schemaVersion','regressionId','createdAt','manifest','observations'],[],'receipt');
  if(copy.kind!=='regression-receipt'||copy.schemaVersion!==1)fail('invalid-regression-receipt','Unsupported regression receipt schema');
  return createRegressionReceipt({regressionId:copy.regressionId as string,createdAt:copy.createdAt as number,
    manifest:copy.manifest as unknown as RegressionManifest,observations:copy.observations as unknown as readonly RegressionObservation[]});
}

/** Compare declared policy with independently retained facts. No evaluation, statistics or effects run here. */
export function checkRegression(input:RegressionRequest):RegressionDecision{
  let receipt:RegressionReceipt|undefined,manifest:RegressionManifest|undefined,checkedAt:number|null=null;
  let proposed:JsonValue=null,recorded:JsonValue=null,expected:JsonValue=null;
  const reasons:RegressionReason[]=[],comparisons:RegressionComparison[]=[];
  let denied=false,unknown=false;
  const deny=(code:string,message:string)=>{denied=true;reasons.push({code,message});};
  const missing=(code:string,message:string)=>{unknown=true;reasons.push({code,message});};
  try{
    const copy=jsonObject(input,'regression request');
    fields(copy,['receipt','manifest','modelRef'],['observations','now'],'request');
    checkedAt=finiteNumber(copy.now===undefined?Date.now():copy.now,'now',0);
    manifest=readRegressionManifest(copy.manifest);
    const modelRef=readModelRef(copy.modelRef);proposed=jsonObject({modelRef});
    if(!sameModelContent(modelRef,manifest.candidateModelRef))deny('regression-proposed-model-mismatch','The proposed model differs from the independently declared candidate');
    receipt=readRegressionReceipt(copy.receipt);recorded=jsonObject(receipt);
    if(!equal(manifestKey(receipt.manifest),manifestKey(manifest)))
      deny('regression-manifest-mismatch','The offered receipt changed the independent models, data, groups, protocol or policies');
    const observations=copy.observations===undefined?[]:readObservations(copy.observations);
    if(copy.observations===undefined)missing('regression-observations-unavailable','Independently retained observations are required');
    expected=jsonObject({manifest,observations});
    const offeredByGroup=new Map(receipt.observations.map(observation=>[observation.groupId,observation]));
    for(const observation of observations){
      const offered=offeredByGroup.get(observation.groupId);
      if(!offered){missing('regression-offered-group-unavailable',`The offered receipt has no ${observation.groupId} observation`);continue;}
      if(!sameArtifact(offered.definitionRef,observation.definitionRef)||!sameArtifact(offered.membershipRef,observation.membershipRef)||
        (offered.rows>0&&observation.rows>0&&offered.rows!==observation.rows))
        deny('regression-observations-mismatch',`Group ${observation.groupId} differs from independently retained group observations`);
      for(const side of ['baseline','candidate'] as const){
        const actual=observation[side],claim=offered[side];
        if(!actual||!claim){missing('regression-evaluation-unavailable',`Paired ${observation.groupId} ${side} evidence is unavailable`);continue;}
        const {metrics:actualMetrics,...actualContext}=evaluationKey(actual),{metrics:claimMetrics,...claimContext}=evaluationKey(claim);
        if(!equal(actualContext,claimContext)||Object.keys(actualMetrics).some(metric=>Object.hasOwn(claimMetrics,metric)&&actualMetrics[metric]!==claimMetrics[metric]))
          deny('regression-observations-mismatch',`Group ${observation.groupId} ${side} differs from independently retained evaluation facts`);
      }
    }
    const checkDate=(createdAt:number,label:string)=>{
      if(createdAt>checkedAt!)deny('regression-evidence-from-future',`${label} is dated after this check`);
      if(manifest!.maxAgeMs!==undefined&&checkedAt!-createdAt>manifest!.maxAgeMs)
        deny('regression-evidence-expired',`${label} exceeds the independently declared maximum age`);
    };
    checkDate(receipt.createdAt,'Regression receipt');
    const declared=new Map(manifest.groups.map(group=>[group.groupId,group]));
    const byGroup=new Map(observations.map(observation=>[observation.groupId,observation]));
    for(const observation of [...observations,...receipt.observations]){
      const group=declared.get(observation.groupId);
      if(!group){deny('regression-undeclared-observation',`Observed group ${observation.groupId} was not independently declared`);continue;}
      if(!sameArtifact(observation.definitionRef,group.definitionRef)||!sameArtifact(observation.membershipRef,group.membershipRef))
        deny('regression-group-binding-mismatch',`Group ${group.groupId} uses a different definition or row membership`);
      if(observation.rows>group.expectedRows)deny('regression-row-count-mismatch',`Group ${group.groupId} reports more rows than declared`);
      if(observation.rows<group.expectedRows)missing('regression-incomplete-coverage',`Group ${group.groupId} did not retain all declared rows`);
      for(const side of ['baseline','candidate'] as const){
        const evaluation=observation[side];
        if(!evaluation){missing('regression-evaluation-unavailable',`Group ${group.groupId} has no ${side} evaluation`);continue;}
        const required=side==='baseline'?manifest.baselineModelRef:manifest.candidateModelRef;
        if(!sameModelContent(evaluation.modelRef,required))deny('regression-model-mismatch',`Group ${group.groupId} ${side} evaluation used a different model`);
        if(!sameDataset(evaluation.datasetRef,group.datasetRef))deny('regression-dataset-mismatch',`Group ${group.groupId} ${side} evaluation used a different subset`);
        if(evaluation.datasetRef.rows!==observation.rows)deny('regression-row-count-mismatch',`Group ${group.groupId} ${side} evaluation count differs from the observation`);
        if(evaluation.preprocessingVersion!==manifest.comparison.preprocessingVersion||evaluation.evaluationMethodVersion!==manifest.comparison.evaluationMethodVersion||
          !equal(evaluation.parameters,manifest.comparison.parameters))deny('regression-evaluation-context-mismatch',`Group ${group.groupId} ${side} evaluation used a different preprocessing, method or parameters`);
        checkDate(evaluation.createdAt,`${group.groupId} ${side} evaluation`);
        if(evaluation.createdAt>receipt.createdAt)deny('regression-receipt-before-evaluation',`The regression receipt predates the ${group.groupId} ${side} observation`);
      }
    }
    for(const policy of manifest.policies){
      const group=declared.get(policy.groupId)!,observation=byGroup.get(policy.groupId),offered=offeredByGroup.get(policy.groupId);
      const baselineValue=metricAt(observation?.baseline,policy.metric),candidateValue=metricAt(observation?.candidate,policy.metric);
      let status:'allow'|'deny'|'unknown'='allow',deterioration:number|null=null;
      if(!observation){missing('regression-group-unavailable',`No observation covers declared group ${group.groupId}`);status='unknown';}
      if(!observation||!offered||observation.rows<policy.minSamples||observation.rows<group.expectedRows||
        offered.rows<policy.minSamples||offered.rows<group.expectedRows){
        if(observation&&observation.rows<policy.minSamples)missing('regression-insufficient-samples',`Group ${group.groupId} has fewer than ${policy.minSamples} declared required samples`);
        status='unknown';
      }
      if(baselineValue===null||candidateValue===null||metricAt(offered?.baseline,policy.metric)===null||metricAt(offered?.candidate,policy.metric)===null){
        missing('regression-metric-unavailable',`Group ${group.groupId} lacks paired ${policy.metric} values`);status='unknown';}
      if(baselineValue!==null&&candidateValue!==null){
        const difference=policy.direction==='max'?baselineValue-candidateValue:candidateValue-baselineValue;
        if(!Number.isFinite(difference)){missing('regression-deterioration-unrepresentable',`Group ${group.groupId} ${policy.metric} difference is not a finite representable number`);status='unknown';}
        else{deterioration=difference;if(status!=='unknown'&&difference>policy.maxDeterioration){
          deny('regression-deterioration-exceeded',`Group ${group.groupId} ${policy.metric} deterioration ${difference} exceeds ${policy.maxDeterioration}`);status='deny';}}
      }
      comparisons.push({groupId:group.groupId,metric:policy.metric,direction:policy.direction,baselineValue,candidateValue,deterioration,
        maxDeterioration:policy.maxDeterioration,minSamples:policy.minSamples,rows:observation?.rows??null,status});
    }
  }catch(error){missing('invalid-or-missing-regression-evidence',error instanceof Error?error.message:'Invalid regression evidence');}
  const allowed=!denied&&!unknown;
  if(allowed)reasons.push({code:'regression-policy-satisfied',message:'The declared models, comparable paired evaluations, complete predefined groups and absolute deterioration limits agree'});
  return detached({kind:'regression-decision',schemaVersion:1,allowed,status:allowed?'allow':denied?'deny':'unknown',reasons,checkedAt,
    regressionId:receipt?.regressionId??null,comparisonId:manifest?.comparisonId??null,comparisons,bindings:{proposed,receipt:recorded,expected}});
}
