import {artifactRef,canonicalJson,detached,fail,finiteNumber,jsonObject,nonempty,readDatasetRef,readModelRef,
  sameArtifact,sameDataset,sameModelContent} from './contracts.js';
import type {ArtifactRef,DatasetRef,EvaluationReceipt,JsonObject,JsonValue,ModelRef,ReleaseDecision,ReleasePolicy} from './contracts.js';
import {checkInference,readInferenceReceipt,readPredictionContract} from './inference.js';
import type {InferenceDecision,InferenceReceipt,PredictionContract} from './inference.js';
import {checkRelease} from './guard.js';
import {readEvaluationReceipt} from './receipts.js';

export interface MonitoringDeployment {
  readonly targetName:string;readonly revision:string;readonly modelRef:ModelRef;readonly publicationRef:ArtifactRef;
}
export interface MonitoringWindow {
  readonly windowId:string;readonly startAt:number;readonly endAt:number;readonly inputRef:ArtifactRef;
  readonly membershipRef:ArtifactRef;readonly expectedRows:number;readonly inferenceId:string;
}
export interface MonitoringLabelSource {readonly name:string;readonly version:string}
export interface MonitoringEvaluationContext {
  readonly preprocessingVersion:string;readonly evaluationMethodVersion:string;readonly parameters:JsonObject;
}
export interface MonitoringPolicy extends ReleasePolicy {
  readonly minSamples:number;readonly minCoverage:number;
}
export interface MonitoringManifest {
  readonly kind:'monitoring-manifest';readonly schemaVersion:1;readonly monitorId:string;
  readonly deployment:MonitoringDeployment;readonly window:MonitoringWindow;readonly contract:PredictionContract;
  readonly labelSource:MonitoringLabelSource;readonly joinMode:'row-id-window-time/v1';
  readonly evaluation:MonitoringEvaluationContext;readonly policy:MonitoringPolicy;
}
export interface MonitoringObservedDeployment extends MonitoringDeployment {readonly observedAt:number}
export interface MonitoringObservedWindow {
  readonly windowId:string;readonly startAt:number;readonly endAt:number;readonly inputRef:ArtifactRef;
  readonly membershipRef:ArtifactRef;readonly rows:number;readonly closedAt:number;
}
export interface MonitoringLabelBatch {
  readonly batchId:string;readonly windowId:string;readonly source:MonitoringLabelSource;
  readonly labelRef:ArtifactRef;readonly availableAt:number;
}
/** Reported join facts. The application must actually measure row-ID/window/time joins. */
export interface MonitoringJoin {
  readonly windowId:string;readonly joinMode:string;readonly joinRef:ArtifactRef;
  readonly inputRef:ArtifactRef;readonly outputRef:ArtifactRef;readonly labelRef:ArtifactRef;readonly membershipRef:ArtifactRef;
  readonly joinedDatasetRef?:DatasetRef;readonly matchedRows:number;readonly missingRows:number;
  readonly duplicateRows:number;readonly unmatchedRows:number;readonly crossWindowRows:number;readonly createdAt:number;
}
export interface MonitoringObservation {
  readonly deployment:MonitoringObservedDeployment;readonly window:MonitoringObservedWindow;
  readonly prediction?:InferenceReceipt;readonly labels?:MonitoringLabelBatch;readonly join?:MonitoringJoin;readonly evaluation?:EvaluationReceipt;
}
export interface MonitoringReceiptInput {
  readonly monitoringId:string;readonly createdAt:number;readonly manifest:MonitoringManifest;readonly observation:MonitoringObservation;
}
export interface MonitoringReceipt extends MonitoringReceiptInput {readonly kind:'monitoring-receipt';readonly schemaVersion:1}
export interface MonitoringRequest {
  readonly receipt:unknown;
  /** Independently retained requirements and observations, not copied from offered evidence as authority. */
  readonly manifest:MonitoringManifest;readonly observation:MonitoringObservation;readonly now?:number;
}
export interface MonitoringReason {readonly code:string;readonly message:string}
export interface MonitoringDecision {
  readonly kind:'monitoring-decision';readonly schemaVersion:1;readonly allowed:boolean;readonly status:'allow'|'deny'|'unknown';
  readonly health:null|'healthy'|'degraded';readonly recommendation:'none'|'review'|'review-evidence'|'wait';
  readonly reasons:readonly MonitoringReason[];readonly checkedAt:number|null;readonly monitoringId:string|null;readonly monitorId:string|null;readonly windowId:string|null;
  readonly coverage:{readonly matchedRows:number|null;readonly expectedRows:number|null;readonly ratio:number|null;readonly minSamples:number|null;readonly minCoverage:number|null};
  readonly checks:{readonly inference:InferenceDecision|null;readonly quality:ReleaseDecision|null};
  readonly bindings:{readonly expected:JsonValue;readonly receipt:JsonValue};
}

function fields(value:JsonObject,required:readonly string[],optional:readonly string[],label:string){
  if(required.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>!required.includes(key)&&!optional.includes(key)))
    fail('invalid-monitoring-field',`${label} has missing or unsupported fields`);
}
function count(value:unknown,label:string,minimum=0):number{
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<minimum)fail('invalid-monitoring-count',`${label} must be a safe integer >= ${minimum}`);
  return value;
}
const equal=(a:unknown,b:unknown)=>canonicalJson(jsonObject({value:a}).value)===canonicalJson(jsonObject({value:b}).value);
const akey=(value:ArtifactRef)=>({sha256:value.sha256.toLowerCase(),bytes:value.bytes,format:value.format});
const mkey=(value:ModelRef)=>({artifact:akey(value.originArtifact),identity:value.inferenceIdentity===undefined?null:
  {profile:value.inferenceIdentity.profile,sha256:value.inferenceIdentity.sha256.toLowerCase()}});
const dkey=(value:DatasetRef)=>({artifact:akey(value.artifact),rows:value.rows,shape:value.shape,role:value.role});
function deployment(value:unknown,observed:false):MonitoringDeployment;
function deployment(value:unknown,observed:true):MonitoringObservedDeployment;
function deployment(value:unknown,observed:boolean){
  const copy=jsonObject(value,'deployment');fields(copy,['targetName','revision','modelRef','publicationRef',...(observed?['observedAt']:[])],[],'deployment');
  return {targetName:nonempty(copy.targetName,'targetName'),revision:nonempty(copy.revision,'revision'),modelRef:readModelRef(copy.modelRef),
    publicationRef:artifactRef(copy.publicationRef),...(observed?{observedAt:finiteNumber(copy.observedAt,'observedAt',0)}:{})};
}
function interval(copy:JsonObject){
  const startAt=finiteNumber(copy.startAt,'startAt',0),endAt=finiteNumber(copy.endAt,'endAt',0);
  if(endAt<=startAt)fail('invalid-monitoring-window','Window must be a nonempty half-open interval [startAt,endAt)');
  return {windowId:nonempty(copy.windowId,'windowId'),startAt,endAt,inputRef:artifactRef(copy.inputRef),membershipRef:artifactRef(copy.membershipRef)};
}
function source(value:unknown):MonitoringLabelSource{
  const copy=jsonObject(value,'label source');fields(copy,['name','version'],[],'label source');
  return {name:nonempty(copy.name,'label source.name'),version:nonempty(copy.version,'label source.version')};
}
/** One closed, nonempty batch and its independently declared deployment/label protocol. */
export function readMonitoringManifest(value:unknown):MonitoringManifest{
  const copy=jsonObject(value,'monitoring manifest');
  fields(copy,['kind','schemaVersion','monitorId','deployment','window','contract','labelSource','joinMode','evaluation','policy'],[],'manifest');
  if(copy.kind!=='monitoring-manifest'||copy.schemaVersion!==1)fail('invalid-monitoring-manifest','Unsupported monitoring manifest schema');
  const window=jsonObject(copy.window,'window');fields(window,['windowId','startAt','endAt','inputRef','membershipRef','expectedRows','inferenceId'],[],'window');
  const evaluation=jsonObject(copy.evaluation,'evaluation context');fields(evaluation,['preprocessingVersion','evaluationMethodVersion','parameters'],[],'evaluation context');
  const policy=jsonObject(copy.policy,'monitoring policy');fields(policy,['metric','operator','threshold','minSamples','minCoverage'],['maxAgeMs'],'policy');
  if(policy.operator!=='gte'&&policy.operator!=='lte')fail('invalid-monitoring-policy','Policy operator must be gte or lte');
  const minCoverage=finiteNumber(policy.minCoverage,'minCoverage',0);
  if(minCoverage>1)fail('invalid-monitoring-policy','minCoverage must be between zero and one');
  if(copy.joinMode!=='row-id-window-time/v1')fail('invalid-monitoring-join-mode','Only the explicit row-id-window-time/v1 profile is supported');
  const contract=readPredictionContract(copy.contract);
  if(evaluation.preprocessingVersion!==contract.preprocessingVersion)
    fail('inconsistent-monitoring-preprocessing','The evaluation and prediction contract must name the same preprocessing semantics');
  return detached({kind:'monitoring-manifest',schemaVersion:1,monitorId:nonempty(copy.monitorId,'monitorId'),deployment:deployment(copy.deployment,false),
    window:{...interval(window),expectedRows:count(window.expectedRows,'expectedRows',1),inferenceId:nonempty(window.inferenceId,'inferenceId')},
    contract,labelSource:source(copy.labelSource),joinMode:copy.joinMode,
    evaluation:{preprocessingVersion:nonempty(evaluation.preprocessingVersion,'preprocessingVersion'),
      evaluationMethodVersion:nonempty(evaluation.evaluationMethodVersion,'evaluationMethodVersion'),parameters:jsonObject(evaluation.parameters,'parameters')},
    policy:{metric:nonempty(policy.metric,'metric'),operator:policy.operator,threshold:finiteNumber(policy.threshold,'threshold'),
      minSamples:count(policy.minSamples,'minSamples',1),minCoverage,...(policy.maxAgeMs===undefined?{}:{maxAgeMs:finiteNumber(policy.maxAgeMs,'maxAgeMs',0)})}});
}
function observation(value:unknown):MonitoringObservation{
  const copy=jsonObject(value,'monitoring observation');fields(copy,['deployment','window'],['prediction','labels','join','evaluation'],'observation');
  const window=jsonObject(copy.window,'observed window');fields(window,['windowId','startAt','endAt','inputRef','membershipRef','rows','closedAt'],[],'observed window');
  let labels:MonitoringLabelBatch|undefined,join:MonitoringJoin|undefined;
  if(copy.labels!==undefined){const raw=jsonObject(copy.labels,'label batch');fields(raw,['batchId','windowId','source','labelRef','availableAt'],[],'label batch');
    labels={batchId:nonempty(raw.batchId,'batchId'),windowId:nonempty(raw.windowId,'label windowId'),source:source(raw.source),labelRef:artifactRef(raw.labelRef),availableAt:finiteNumber(raw.availableAt,'availableAt',0)};}
  if(copy.join!==undefined){const raw=jsonObject(copy.join,'join');fields(raw,['windowId','joinMode','joinRef','inputRef','outputRef','labelRef','membershipRef','matchedRows','missingRows','duplicateRows','unmatchedRows','crossWindowRows','createdAt'],['joinedDatasetRef'],'join');
    join={windowId:nonempty(raw.windowId,'join windowId'),joinMode:nonempty(raw.joinMode,'observed joinMode'),joinRef:artifactRef(raw.joinRef),
      inputRef:artifactRef(raw.inputRef),outputRef:artifactRef(raw.outputRef),labelRef:artifactRef(raw.labelRef),membershipRef:artifactRef(raw.membershipRef),
      matchedRows:count(raw.matchedRows,'matchedRows'),missingRows:count(raw.missingRows,'missingRows'),duplicateRows:count(raw.duplicateRows,'duplicateRows'),
      unmatchedRows:count(raw.unmatchedRows,'unmatchedRows'),crossWindowRows:count(raw.crossWindowRows,'crossWindowRows'),createdAt:finiteNumber(raw.createdAt,'join.createdAt',0),
      ...(raw.joinedDatasetRef===undefined?{}:{joinedDatasetRef:readDatasetRef(raw.joinedDatasetRef)})};}
  return detached({deployment:deployment(copy.deployment,true),window:{...interval(window),rows:count(window.rows,'observed rows',1),closedAt:finiteNumber(window.closedAt,'closedAt',0)},
    ...(copy.prediction===undefined?{}:{prediction:readInferenceReceipt(copy.prediction)}),...(labels===undefined?{}:{labels}),...(join===undefined?{}:{join}),
    ...(copy.evaluation===undefined?{}:{evaluation:readEvaluationReceipt(copy.evaluation)})});
}
export function createMonitoringReceipt(input:MonitoringReceiptInput):MonitoringReceipt{
  const copy=jsonObject(input,'monitoring receipt input');fields(copy,['monitoringId','createdAt','manifest','observation'],[],'receipt input');
  return detached({kind:'monitoring-receipt',schemaVersion:1,monitoringId:nonempty(copy.monitoringId,'monitoringId'),createdAt:finiteNumber(copy.createdAt,'createdAt',0),
    manifest:readMonitoringManifest(copy.manifest),observation:observation(copy.observation)});
}
export function readMonitoringReceipt(value:unknown):MonitoringReceipt{
  const copy=jsonObject(value,'monitoring receipt');fields(copy,['kind','schemaVersion','monitoringId','createdAt','manifest','observation'],[],'receipt');
  if(copy.kind!=='monitoring-receipt'||copy.schemaVersion!==1)fail('invalid-monitoring-receipt','Unsupported monitoring receipt schema');
  return createMonitoringReceipt({monitoringId:copy.monitoringId as string,createdAt:copy.createdAt as number,
    manifest:copy.manifest as unknown as MonitoringManifest,observation:copy.observation as unknown as MonitoringObservation});
}
function deploymentKey(value:MonitoringDeployment){return {...value,modelRef:mkey(value.modelRef),publicationRef:akey(value.publicationRef)};}
function windowKey(value:MonitoringWindow|MonitoringObservedWindow){return {...value,inputRef:akey(value.inputRef),membershipRef:akey(value.membershipRef)};}
function manifestKey(value:MonitoringManifest){return {...value,deployment:deploymentKey(value.deployment),window:windowKey(value.window)};}
function predictionKey(value:InferenceReceipt){return {...value,inputRef:akey(value.inputRef),outputRef:akey(value.outputRef),
  ...(value.modelRef===undefined?{}:{modelRef:mkey(value.modelRef)})};}
function labelKey(value:MonitoringLabelBatch){return {...value,labelRef:akey(value.labelRef)};}
function joinKey(value:MonitoringJoin){const {joinedDatasetRef,...base}=value;return {...base,joinRef:akey(value.joinRef),inputRef:akey(value.inputRef),
  outputRef:akey(value.outputRef),labelRef:akey(value.labelRef),membershipRef:akey(value.membershipRef)};}
function evaluationKey(value:EvaluationReceipt){return {schemaVersion:value.schemaVersion,evaluationId:value.evaluationId,createdAt:value.createdAt,modelRef:mkey(value.modelRef),
  datasetRef:dkey(value.datasetRef),preprocessingVersion:value.preprocessingVersion,evaluationMethodVersion:value.evaluationMethodVersion,parameters:value.parameters};}

/** Consistency/coverage/metric policy only. No artifact inspection, label joining, drift diagnosis or operational effect. */
export function checkMonitoring(input:MonitoringRequest):MonitoringDecision{
  let manifest:MonitoringManifest|undefined,receipt:MonitoringReceipt|undefined,actual:MonitoringObservation|undefined,checkedAt:number|null=null;
  let expected:JsonValue=null,recorded:JsonValue=null,inference:InferenceDecision|null=null,quality:ReleaseDecision|null=null;
  let denied=false,unknown=false,evidenceDenied=false,metricFailed=false;
  const reasons:MonitoringReason[]=[];
  const deny=(code:string,message:string)=>{denied=true;evidenceDenied=true;reasons.push({code,message});};
  const missing=(code:string,message:string)=>{unknown=true;reasons.push({code,message});};
  const date=(value:number,label:string)=>{if(value>checkedAt!)deny('monitoring-observation-from-future',`${label} is dated after this check`);
    if(receipt&&value>receipt.createdAt)deny('monitoring-receipt-before-observation',`The monitoring receipt predates ${label}`);};
  const validate=(value:MonitoringObservation,label:string)=>{
    const want=manifest!,dep=value.deployment,win=value.window,pred=value.prediction,labels=value.labels,join=value.join,evaluation=value.evaluation;
    if(dep.targetName!==want.deployment.targetName||dep.revision!==want.deployment.revision||!sameArtifact(dep.publicationRef,want.deployment.publicationRef)||
      !sameModelContent(dep.modelRef,want.deployment.modelRef))deny('monitoring-deployment-mismatch',`${label} deployment differs from the pinned target, revision, publication or exact model`);
    date(dep.observedAt,`${label} deployment observation`);
    if(win.windowId!==want.window.windowId||win.startAt!==want.window.startAt||win.endAt!==want.window.endAt||
      !sameArtifact(win.inputRef,want.window.inputRef)||!sameArtifact(win.membershipRef,want.window.membershipRef)||win.rows!==want.window.expectedRows)
      deny('monitoring-window-mismatch',`${label} window identity, half-open bounds, input, membership or row count differs`);
    if(win.closedAt<win.endAt)deny('monitoring-window-closed-too-early',`${label} reports closure before the window end`);
    date(win.closedAt,`${label} window closure`);
    if(pred){
      const decision=checkInference({receipt:pred,modelRef:want.deployment.modelRef,contract:want.contract,inputRef:want.window.inputRef,
        rows:want.window.expectedRows,inferenceId:want.window.inferenceId,now:checkedAt!});
      if(inference===null)inference=decision;
      if(!decision.allowed){const message=`${label} prediction check refused: ${decision.reasons.map(reason=>reason.code).join(', ')}`;
        if(decision.status==='deny')deny('monitoring-inference-mismatch',message);else missing('monitoring-inference-unavailable',message);}
      if(pred.modelRef&&!sameModelContent(pred.modelRef,want.deployment.modelRef))deny('monitoring-prediction-model-mismatch',`${label} prediction used a different exact checkpoint or measured identity`);
      if(dep.observedAt>pred.createdAt)deny('monitoring-deployment-after-prediction',`${label} deployment snapshot was observed after the prediction it is meant to explain`);
      if(pred.createdAt<win.startAt)deny('monitoring-prediction-before-window',`${label} prediction predates the declared event-time window`);
      date(pred.createdAt,`${label} prediction`);
    }else missing('monitoring-prediction-unavailable',`${label} has no actual prediction receipt`);
    if(labels){
      if(labels.windowId!==want.window.windowId||!equal(labels.source,want.labelSource))deny('monitoring-label-source-mismatch',`${label} labels belong to a different window or source protocol`);
      date(labels.availableAt,`${label} labels availability`);
    }else missing('monitoring-labels-unavailable',`${label} has no actual label batch`);
    if(join){
      if(join.windowId!==want.window.windowId||join.joinMode!==want.joinMode||!sameArtifact(join.inputRef,want.window.inputRef)||!sameArtifact(join.membershipRef,want.window.membershipRef))
        deny('monitoring-join-context-mismatch',`${label} join uses a different window, input, membership or join protocol`);
      if(pred&&!sameArtifact(join.outputRef,pred.outputRef))deny('monitoring-output-mismatch',`${label} join consumed a different prediction output`);
      if(labels&&!sameArtifact(join.labelRef,labels.labelRef))deny('monitoring-label-artifact-mismatch',`${label} join consumed different label bytes`);
      if(join.matchedRows+join.missingRows!==win.rows||join.matchedRows>want.window.expectedRows)
        deny('monitoring-join-count-mismatch',`${label} matched and missing rows do not account for the observed window`);
      if(join.duplicateRows>0||join.unmatchedRows>0||join.crossWindowRows>0)deny('monitoring-invalid-label-join',`${label} reports duplicate, unmatched or cross-window labels`);
      if(join.matchedRows<want.policy.minSamples||join.matchedRows/want.window.expectedRows<want.policy.minCoverage)
        missing('monitoring-insufficient-coverage',`${label} matched labels do not meet the declared row and coverage floors`);
      if(join.joinedDatasetRef){if(join.joinedDatasetRef.rows!==join.matchedRows)deny('monitoring-joined-dataset-count-mismatch',`${label} evaluated table count differs from matched rows`);}
      else if(join.matchedRows>0)missing('monitoring-joined-dataset-unavailable',`${label} has no measured dataset for matched labels`);
      if(join.createdAt<win.closedAt||(pred&&join.createdAt<pred.createdAt)||(labels&&join.createdAt<labels.availableAt))
        deny('monitoring-join-before-inputs',`${label} join predates its window closure, prediction or labels`);
      date(join.createdAt,`${label} join`);
    }else missing('monitoring-join-unavailable',`${label} has no measured label join`);
    if(evaluation){
      if(!sameModelContent(evaluation.modelRef,want.deployment.modelRef))deny('monitoring-evaluation-model-mismatch',`${label} evaluation used a different exact model`);
      if(join?.joinedDatasetRef&&!sameDataset(evaluation.datasetRef,join.joinedDatasetRef))deny('monitoring-evaluation-dataset-mismatch',`${label} metric used a different joined dataset`);
      if(join&&evaluation.datasetRef.rows!==join.matchedRows)deny('monitoring-evaluation-count-mismatch',`${label} metric count differs from matched rows`);
      if(evaluation.preprocessingVersion!==want.evaluation.preprocessingVersion||evaluation.evaluationMethodVersion!==want.evaluation.evaluationMethodVersion||!equal(evaluation.parameters,want.evaluation.parameters))
        deny('monitoring-evaluation-context-mismatch',`${label} metric used a different preprocessing, method or parameters`);
      if(join&&evaluation.createdAt<join.createdAt)deny('monitoring-evaluation-before-join',`${label} evaluation predates the actual join`);
      date(evaluation.createdAt,`${label} evaluation`);
      if(want.policy.maxAgeMs!==undefined&&checkedAt!-evaluation.createdAt>want.policy.maxAgeMs)
        deny('monitoring-evaluation-expired',`${label} evaluation exceeds the declared maximum age`);
    }else missing('monitoring-evaluation-unavailable',`${label} has no actual metric evaluation`);
  };
  try{
    const copy=jsonObject(input,'monitoring request');fields(copy,['manifest'],['receipt','observation','now'],'request');
    manifest=readMonitoringManifest(copy.manifest);checkedAt=finiteNumber(copy.now===undefined?Date.now():copy.now,'now',0);
    if(checkedAt<manifest.window.endAt)missing('monitoring-window-not-ended','The declared event-time window has not ended');
    if(copy.observation===undefined)missing('monitoring-observation-unavailable','Separately retained observations are required');
    else{actual=observation(copy.observation);validate(actual,'Independent');}
    expected=jsonObject({manifest,observation:actual??null});
    if(copy.receipt===undefined||copy.receipt===null)missing('monitoring-receipt-unavailable','A saved monitoring receipt is required');
    else{
      receipt=readMonitoringReceipt(copy.receipt);recorded=jsonObject(receipt);date(receipt.createdAt,'Monitoring receipt');
      if(!equal(manifestKey(receipt.manifest),manifestKey(manifest)))deny('monitoring-manifest-mismatch','The offered receipt changed the independently declared deployment, window or policy');
      validate(receipt.observation,'Offered');
      // Validation above checks observations against the request; recheck the
      // independent chronology now that the outer receipt timestamp is available.
      if(actual){
        const times=[actual.deployment.observedAt,actual.window.closedAt,actual.prediction?.createdAt,actual.labels?.availableAt,actual.join?.createdAt,actual.evaluation?.createdAt];
        for(const value of times)if(value!==undefined)date(value,'Independent observation');
        const offered=receipt.observation;
        if(!equal(deploymentKey(actual.deployment),deploymentKey(offered.deployment))||!equal(windowKey(actual.window),windowKey(offered.window)))
          deny('monitoring-observation-mismatch','Offered deployment/window differs from independently retained facts');
        for(const key of ['prediction','labels','join','evaluation'] as const){
          if(actual[key]===undefined||offered[key]===undefined){missing('monitoring-paired-observation-unavailable',`Both sources must retain actual ${key} evidence`);continue;}
          if(key==='prediction'){
            const left=actual.prediction!,right=offered.prediction!;
            const {modelRef:lm,contract:lc,...lbase}=predictionKey(left),{modelRef:rm,contract:rc,...rbase}=predictionKey(right);
            if(!equal(lbase,rbase)||(lm!==undefined&&rm!==undefined&&!equal(lm,rm))||(lc!==undefined&&rc!==undefined&&!equal(lc,rc)))
              deny('monitoring-observation-mismatch','Offered prediction differs from independently retained inference facts');
          }else if(key==='labels'){
            if(!equal(labelKey(actual.labels!),labelKey(offered.labels!)))deny('monitoring-observation-mismatch','Offered label batch differs from independently retained facts');
          }else if(key==='join'){
            if(!equal(joinKey(actual.join!),joinKey(offered.join!))||(actual.join!.joinedDatasetRef&&offered.join!.joinedDatasetRef&&!sameDataset(actual.join!.joinedDatasetRef!,offered.join!.joinedDatasetRef!)))
              deny('monitoring-observation-mismatch','Offered join differs from independently retained facts');
            if((actual.join!.joinedDatasetRef===undefined)!==(offered.join!.joinedDatasetRef===undefined))missing('monitoring-paired-dataset-unavailable','Both sources must retain the actual joined evaluation dataset');
          }else{
            const left=actual.evaluation!,right=offered.evaluation!;
            if(!equal(evaluationKey(left),evaluationKey(right))||Object.keys(left.metrics).some(metric=>Object.hasOwn(right.metrics,metric)&&left.metrics[metric]!==right.metrics[metric]))
              deny('monitoring-observation-mismatch','Offered evaluation differs from independently retained metric facts');
            if(!Object.hasOwn(left.metrics,manifest.policy.metric)||!Object.hasOwn(right.metrics,manifest.policy.metric))missing('monitoring-metric-unavailable','Both sources must retain the required measured metric');
          }
        }
      }
    }
    if(!denied&&!unknown&&actual?.evaluation&&actual.join?.joinedDatasetRef){
      const {minSamples,minCoverage,...policy}=manifest.policy;
      quality=checkRelease({receipt:actual.evaluation,modelRef:manifest.deployment.modelRef,datasetRef:actual.join.joinedDatasetRef,...manifest.evaluation,policy,now:checkedAt});
      if(!quality.allowed){
        const failures=quality.reasons.filter(reason=>!['inference-identity-matches','checkpoint-differs-inference-matches'].includes(reason.code));
        if(quality.status==='deny'&&failures.length>0&&failures.every(reason=>reason.code==='metric-threshold-failed')){
          denied=true;metricFailed=true;reasons.push({code:'monitoring-health-threshold-failed',message:'The valid measured metric violates the independently declared threshold'});
        }else if(quality.status==='unknown')missing('monitoring-quality-unavailable',`Metric check refused: ${failures.map(reason=>reason.code).join(', ')}`);
        else deny('monitoring-quality-evidence-invalid',`Metric check refused: ${failures.map(reason=>reason.code).join(', ')}`);
      }
    }
  }catch(error){missing('invalid-or-missing-monitoring-evidence',error instanceof Error?error.message:'Invalid monitoring evidence');}
  const allowed=!denied&&!unknown,health=allowed?'healthy':metricFailed&&!evidenceDenied&&!unknown?'degraded':null;
  if(allowed)reasons.push({code:'monitoring-window-healthy',message:'The declared closed window, actual deployment/prediction, label join, coverage and measured metric satisfy policy'});
  return detached({kind:'monitoring-decision',schemaVersion:1,allowed,status:allowed?'allow':denied?'deny':'unknown',health,
    recommendation:allowed?'none':health==='degraded'?'review':denied?'review-evidence':'wait',reasons,checkedAt,monitoringId:receipt?.monitoringId??null,
    monitorId:manifest?.monitorId??null,windowId:manifest?.window.windowId??null,
    coverage:{matchedRows:actual?.join?.matchedRows??null,expectedRows:manifest?.window.expectedRows??null,
      ratio:actual?.join&&manifest?actual.join.matchedRows/manifest.window.expectedRows:null,minSamples:manifest?.policy.minSamples??null,minCoverage:manifest?.policy.minCoverage??null},
    checks:{inference,quality},bindings:{expected,receipt:recorded}});
}
