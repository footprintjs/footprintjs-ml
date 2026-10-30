import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {createPredictionContract,createInferenceReceipt} from '../dist/inference.js';
import {createEvaluationReceipt} from '../dist/receipts.js';
import {checkRelease} from '../dist/guard.js';
import {readMonitoringManifest,createMonitoringReceipt,readMonitoringReceipt,checkMonitoring} from '../dist/monitoring.js';

const NOW=1_800_000_000_000,copy=structuredClone;
const artifact=label=>({kind:'artifact',path:'synthetic/'+label,sha256:createHash('sha256').update(label).digest('hex'),bytes:100,format:'synthetic-monitoring-fixture/v1'});
const model=()=>({kind:'model',sessionId:'approved-session',handle:1,originArtifact:artifact('model'),
  inferenceIdentity:{kind:'inference-identity',schemaVersion:1,profile:'synthetic-linear/v1',sha256:artifact('predictor').sha256}});
const dataset=rows=>({kind:'dataset',sessionId:'backend',handle:4,artifact:artifact('joined-'+rows),rows,shape:[rows,1],role:'monitoring'});
function fixture(){
  const modelRef=model(),contract=createPredictionContract({profile:'numeric/v1',input:{fields:[{name:'x',dtype:'float64'}]},
    output:{fields:[{name:'y',dtype:'float64'}]},preprocessingVersion:'raw/v1'});
  const manifest={kind:'monitoring-manifest',schemaVersion:1,monitorId:'production-mse',deployment:{targetName:'production',revision:'revision-a',modelRef,publicationRef:artifact('publication-a')},
    window:{windowId:'window-1',startAt:NOW-1000,endAt:NOW-500,inputRef:artifact('input-window1'),membershipRef:artifact('members-window1'),expectedRows:4,inferenceId:'predict-window1'},
    contract,labelSource:{name:'actual-outcomes',version:'row-labels/v1'},joinMode:'row-id-window-time/v1',
    evaluation:{preprocessingVersion:'raw/v1',evaluationMethodVersion:'saved-prediction-mse/v1',parameters:{target:'y'}},
    policy:{metric:'mse',operator:'lte',threshold:.1,minSamples:3,minCoverage:.75,maxAgeMs:500}};
  const observation={deployment:{...copy(manifest.deployment),observedAt:NOW-600},window:{windowId:'window-1',startAt:NOW-1000,endAt:NOW-500,
    inputRef:manifest.window.inputRef,membershipRef:manifest.window.membershipRef,rows:4,closedAt:NOW-450},
    prediction:createInferenceReceipt({inferenceId:'predict-window1',createdAt:NOW-400,inputRef:manifest.window.inputRef,outputRef:artifact('predictions-window1'),
      inputRows:4,outputRows:4,modelRef,contract}),
    labels:{batchId:'actual-labels-window1',windowId:'window-1',source:copy(manifest.labelSource),labelRef:artifact('labels-window1'),availableAt:NOW-300},
    join:{windowId:'window-1',joinMode:'row-id-window-time/v1',joinRef:artifact('join-report-window1'),inputRef:manifest.window.inputRef,
      outputRef:artifact('predictions-window1'),labelRef:artifact('labels-window1'),membershipRef:manifest.window.membershipRef,joinedDatasetRef:dataset(4),
      matchedRows:4,missingRows:0,duplicateRows:0,unmatchedRows:0,crossWindowRows:0,createdAt:NOW-200},
    evaluation:createEvaluationReceipt({modelRef,datasetRef:dataset(4),...manifest.evaluation,evaluationId:'actual-evaluation-window1',createdAt:NOW-100,metrics:{mse:.02}})};
  return copy({manifest,observation});
}
const receiptOf=value=>createMonitoringReceipt({monitoringId:'monitor-window1',createdAt:NOW-50,...value});
const requestOf=(value,receipt=receiptOf(value))=>({...value,receipt,now:NOW});
const has=(decision,code)=>decision.reasons.some(reason=>reason.code===code);
function partial(value,rows){value.observation.join.matchedRows=rows;value.observation.join.missingRows=4-rows;
  value.observation.join.joinedDatasetRef=dataset(rows);value.observation.evaluation=createEvaluationReceipt({...value.observation.evaluation,datasetRef:dataset(rows)});return value;}

test('a complete closed window is healthy and reuses the original inference/evaluation facts and declared metric policy',()=>{
  const value=fixture(),before=copy(value),receipt=receiptOf(value),decision=checkMonitoring(requestOf(value,receipt));
  assert.equal(decision.allowed,true);assert.equal(decision.status,'allow');assert.equal(decision.health,'healthy');assert.equal(decision.recommendation,'none');
  assert.deepEqual(decision.coverage,{matchedRows:4,expectedRows:4,ratio:1,minSamples:3,minCoverage:.75});
  const {minSamples,minCoverage,...policy}=value.manifest.policy;
  assert.deepEqual(decision.checks.quality,checkRelease({receipt:value.observation.evaluation,modelRef:value.manifest.deployment.modelRef,
    datasetRef:value.observation.join.joinedDatasetRef,...value.manifest.evaluation,policy,now:NOW}));
  assert.deepEqual(value,before);assert.ok(Object.isFrozen(receipt.observation.join));
  assert.deepEqual(readMonitoringReceipt(JSON.parse(JSON.stringify(receipt))),receipt);
});

test('a measured metric failure recommends review without claiming a deployment or drift effect',()=>{
  const value=fixture();value.observation.evaluation.metrics.mse=9;
  const decision=checkMonitoring(requestOf(value));
  assert.equal(decision.allowed,false);assert.equal(decision.status,'deny');assert.equal(decision.health,'degraded');assert.equal(decision.recommendation,'review');
  assert.ok(has(decision,'monitoring-health-threshold-failed'));assert.ok(decision.checks.quality.reasons.some(reason=>reason.code==='metric-threshold-failed'));
});

test('delayed labels never become a zero-error healthy observation',()=>{
  const value=fixture();delete value.observation.labels;delete value.observation.join;delete value.observation.evaluation;
  const receipt=receiptOf(value),decision=checkMonitoring(requestOf(value,receipt));
  assert.equal(readMonitoringReceipt(receipt).observation.labels,undefined);
  assert.equal(decision.status,'unknown');assert.equal(decision.health,null);assert.equal(decision.recommendation,'wait');assert.equal(decision.checks.quality,null);
  assert.ok(has(decision,'monitoring-labels-unavailable'));
});

test('partial-label coverage must satisfy both row and fraction floors before interpreting metric health',()=>{
  const value=partial(fixture(),2);value.observation.evaluation={...value.observation.evaluation,metrics:{mse:100}};
  const decision=checkMonitoring(requestOf(value));assert.equal(decision.status,'unknown');assert.equal(decision.health,null);assert.equal(decision.checks.quality,null);
  assert.ok(has(decision,'monitoring-insufficient-coverage'));
  assert.equal(checkMonitoring(requestOf(partial(fixture(),3))).status,'allow');
  const strict=fixture();strict.manifest.policy.minSamples=5;assert.equal(checkMonitoring(requestOf(strict)).status,'unknown');
});

test('zero measured labels and a missing joined dataset remain unknown, with no invented empty DatasetRef',()=>{
  const value=fixture();value.observation.join.matchedRows=0;value.observation.join.missingRows=4;
  delete value.observation.join.joinedDatasetRef;delete value.observation.evaluation;
  assert.equal(checkMonitoring(requestOf(value)).status,'unknown');
  const missing=fixture();delete missing.observation.join.joinedDatasetRef;
  assert.ok(has(checkMonitoring(requestOf(missing)),'monitoring-joined-dataset-unavailable'));
});

test('duplicate, unmatched and cross-window join conflicts deny even when labels or metrics are missing',()=>{
  for(const field of ['duplicateRows','unmatchedRows','crossWindowRows']){
    const value=fixture();value.observation.join[field]=1;delete value.observation.labels;delete value.observation.evaluation;
    const decision=checkMonitoring(requestOf(value));assert.equal(decision.status,'deny');assert.equal(decision.health,null);assert.equal(decision.recommendation,'review-evidence');
    assert.ok(has(decision,'monitoring-invalid-label-join'));
  }
});

test('an actual deployment conflict is denied even before delayed labels or the receipt are available',()=>{
  const value=fixture();value.observation.deployment.revision='another-release';delete value.observation.labels;delete value.observation.join;delete value.observation.evaluation;
  const request=requestOf(value);delete request.receipt;
  const decision=checkMonitoring(request);assert.equal(decision.status,'deny');assert.ok(has(decision,'monitoring-deployment-mismatch'));
});

test('a borrowed previous-window receipt cannot monitor another independently declared batch',()=>{
  const first=fixture(),second=copy(first);second.manifest.window.windowId='window-2';second.manifest.window.inputRef=artifact('input-window2');
  second.manifest.window.membershipRef=artifact('members-window2');second.manifest.window.inferenceId='predict-window2';
  const decision=checkMonitoring(requestOf(second,receiptOf(first)));
  assert.equal(decision.status,'deny');assert.equal(decision.health,null);assert.ok(has(decision,'monitoring-manifest-mismatch'));
});

test('offered policy, label source or deployment authority cannot replace the independently retained declaration',()=>{
  const expected=fixture();
  for(const mutate of [value=>value.manifest.policy.threshold=100,value=>value.manifest.policy.minCoverage=0,
    value=>value.manifest.deployment.publicationRef=artifact('other-publication'),value=>value.manifest.labelSource.version='different-source/v2']){
    const offered=copy(expected);mutate(offered);const decision=checkMonitoring(requestOf(expected,receiptOf(offered)));
    assert.equal(decision.status,'deny');assert.ok(has(decision,'monitoring-manifest-mismatch'));
  }
});

test('separately retained metric, join report and prediction outputs cannot be rewritten by an offered receipt',()=>{
  const expected=fixture();
  for(const mutate of [value=>value.observation.evaluation.metrics.mse=9,value=>value.observation.join.joinRef=artifact('other-join-report'),
    value=>value.observation.prediction.outputRef=artifact('other-predictions'),value=>value.observation.labels.batchId='other-batch']){
    const offered=copy(expected);mutate(offered);const decision=checkMonitoring(requestOf(expected,receiptOf(offered)));
    assert.equal(decision.status,'deny');assert.equal(decision.health,null);assert.ok(has(decision,'monitoring-observation-mismatch'));
  }
});

test('missing independently retained or offered facts stay unknown, including a missing required metric',()=>{
  const value=fixture(),request=requestOf(value);delete request.observation;assert.equal(checkMonitoring(request).status,'unknown');
  for(const key of ['prediction','labels','join','evaluation']){
    const missing=copy(value);delete missing.observation[key];
    assert.equal(checkMonitoring(requestOf(value,receiptOf(missing))).status,'unknown');
    assert.equal(checkMonitoring(requestOf(missing,receiptOf(value))).status,'unknown');
  }
  const missingMetric=copy(value);missingMetric.observation.evaluation.metrics={other:1};
  assert.equal(checkMonitoring(requestOf(value,receiptOf(missingMetric))).status,'unknown');
  assert.equal(checkMonitoring(requestOf(missingMetric)).status,'unknown');
});

test('known wrong deployment checkpoints cannot borrow matching inference identities',()=>{
  for(const location of ['deployment','prediction','evaluation']){
    const value=fixture(),ref=location==='deployment'?value.observation.deployment.modelRef:value.observation[location].modelRef;
    ref.originArtifact=artifact('training-only-different-checkpoint');
    if(location==='evaluation')value.observation.evaluation.checkpointForAudit={kind:'checkpoint',artifact:ref.originArtifact};
    const decision=checkMonitoring(requestOf(value));assert.equal(decision.status,'deny');assert.equal(decision.health,null);
  }
});

test('fresh runtime handles and artifact paths may relocate without changing the deployed durable snapshot',()=>{
  const value=fixture(),receipt=copy(receiptOf(value));
  for(const observed of [value.observation,receipt.observation]){
    for(const ref of [observed.deployment.modelRef,observed.prediction.modelRef,observed.evaluation.modelRef]){
      ref.sessionId='restored';ref.handle+=100;ref.originArtifact.path='relocated/model';
    }
    observed.evaluation.checkpointForAudit.artifact.path='relocated/model';
    observed.join.joinedDatasetRef.handle=30;observed.join.joinedDatasetRef.sessionId='restored';
    observed.evaluation.datasetRef.handle=30;observed.evaluation.datasetRef.sessionId='restored';
  }
  assert.equal(checkMonitoring(requestOf(value,receipt)).status,'allow');
});

test('missing actual inference model/contract is unknown and differing expected contract semantics are denied',()=>{
  for(const key of ['modelRef','contract']){
    const value=fixture();delete value.observation.prediction[key];assert.equal(checkMonitoring(requestOf(value)).status,'unknown');
  }
  const value=fixture();value.observation.prediction.contract.input.fields[0].name='different-feature';
  assert.equal(checkMonitoring(requestOf(value)).status,'deny');
});

test('window, invocation, label protocol, input/output and actual joined-dataset bindings are enforced',()=>{
  for(const mutate of [
    o=>o.window.windowId='another-window',o=>o.window.membershipRef=artifact('other-membership'),o=>o.prediction.inferenceId='other-invocation',
    o=>o.prediction.inputRef=artifact('other-input'),o=>o.labels.windowId='previous-window',o=>o.labels.source.version='other-label-protocol',
    o=>o.join.joinMode='row-position/v1',o=>o.join.outputRef=artifact('other-output'),o=>o.join.labelRef=artifact('other-labels'),
    o=>o.evaluation.datasetRef.artifact=artifact('other-joined-data'),o=>o.evaluation.preprocessingVersion='other-scaler',
    o=>o.evaluation.evaluationMethodVersion='other-metric-method',o=>o.evaluation.parameters={target:'other'},
  ]){
    const value=fixture();mutate(value.observation);const decision=checkMonitoring(requestOf(value));
    assert.equal(decision.status,'deny');assert.equal(decision.health,null);
  }
});

test('count contradictions are denied rather than silently converted into unavailable-label coverage',()=>{
  for(const mutate of [o=>o.window.rows=3,o=>o.join.matchedRows=5,o=>o.join.missingRows=1,o=>o.prediction.outputRows=3,
    o=>o.join.joinedDatasetRef=dataset(3),o=>o.evaluation.datasetRef=dataset(3)]){
    const value=fixture();mutate(value.observation);assert.equal(checkMonitoring(requestOf(value)).status,'deny');
  }
});

test('half-open event-time bounds do not require batch prediction to execute before the window closes',()=>{
  const value=fixture();assert.ok(value.observation.prediction.createdAt>value.manifest.window.endAt);
  assert.equal(checkMonitoring(requestOf(value)).status,'allow');
  value.observation.labels.availableAt=NOW-700;
  assert.equal(checkMonitoring(requestOf(value)).status,'allow','Already labeled retrospective batches may still be joined after prediction');
});

test('later deployment snapshots, premature closure and join/evaluation chronology conflicts are refused',()=>{
  for(const mutate of [o=>o.deployment.observedAt=o.prediction.createdAt+1,o=>o.window.closedAt=o.window.endAt-1,
    o=>o.prediction.createdAt=o.window.startAt-1,o=>o.join.createdAt=o.prediction.createdAt-1,
    o=>o.join.createdAt=o.labels.availableAt-1,o=>o.evaluation.createdAt=o.join.createdAt-1]){
    const value=fixture();mutate(value.observation);const decision=checkMonitoring(requestOf(value));assert.equal(decision.status,'deny');assert.equal(decision.health,null);
  }
});

test('future observations and an outer receipt predating actual observations cannot pass',()=>{
  for(const mutate of [o=>o.deployment.observedAt=NOW+1,o=>o.prediction.createdAt=NOW+1,o=>o.labels.availableAt=NOW+1,
    o=>o.join.createdAt=NOW+1,o=>o.evaluation.createdAt=NOW+1]){
    const value=fixture();mutate(value.observation);assert.equal(checkMonitoring(requestOf(value)).status,'deny');
  }
  const value=fixture(),receipt={...copy(receiptOf(value)),createdAt:NOW-150};
  assert.ok(has(checkMonitoring(requestOf(value,receipt)),'monitoring-receipt-before-observation'));
  assert.equal(checkMonitoring(requestOf(value,{...copy(receiptOf(value)),createdAt:NOW+1})).status,'deny');
  assert.equal(checkMonitoring({manifest:value.manifest,now:NOW-501}).status,'unknown');
});

test('evaluation age remains measured age; old evidence is invalid even when labels are missing',()=>{
  const value=fixture();value.manifest.policy.maxAgeMs=50;
  const decision=checkMonitoring(requestOf(value));assert.equal(decision.status,'deny');assert.equal(decision.health,null);
  assert.equal(decision.recommendation,'review-evidence');assert.ok(has(decision,'monitoring-evaluation-expired'));
  delete value.observation.labels;assert.equal(checkMonitoring(requestOf(value)).status,'deny');
  const boundary=fixture();boundary.manifest.policy.maxAgeMs=100;assert.equal(checkMonitoring(requestOf(boundary)).status,'allow');
});

test('both threshold directions and exact equality use existing release metric semantics',()=>{
  for(const [operator,threshold] of [['gte',.02],['lte',.02]]){
    const value=fixture();value.manifest.policy.operator=operator;value.manifest.policy.threshold=threshold;
    assert.equal(checkMonitoring(requestOf(value)).status,'allow');
  }
  const value=fixture();value.manifest.policy.operator='gte';value.manifest.policy.threshold=.021;
  assert.equal(checkMonitoring(requestOf(value)).health,'degraded');
});

test('strict schemas reject ignored fields, malformed windows/policies and invalid JSON without effects',()=>{
  for(const mutate of [m=>m.policy.maxAgeMS=1,m=>m.policy.minCoverage=1.01,m=>m.policy.minSamples=0,m=>m.policy.threshold=Infinity,
    m=>m.window.endAt=m.window.startAt,m=>m.window.expectedRows=Number.MAX_SAFE_INTEGER+1,m=>m.joinMode='row-index/v1',
    m=>m.evaluation.preprocessingVersion='inconsistent-with-contract']){
    const value=fixture();mutate(value.manifest);assert.throws(()=>readMonitoringManifest(value.manifest));
    assert.equal(checkMonitoring({...value,receipt:null,now:NOW}).status,'unknown');
  }
  for(const mutate of [o=>o.join.crossWindowRows=-1,o=>o.join.matchedRows=NaN,o=>o.join.extra=true,o=>o.evaluation.metrics.mse=()=>0]){
    const value=fixture();mutate(value.observation);assert.throws(()=>receiptOf(value));
  }
  const receipt=copy(receiptOf(fixture()));receipt.recommendation='healthy';assert.throws(()=>readMonitoringReceipt(receipt));
  assert.equal(checkMonitoring({...requestOf(fixture()),callback:()=>{throw Error('must not execute');}}).status,'unknown');
});

test('prototype-named metrics remain missing unless they are actual numeric own observations',()=>{
  for(const metric of ['constructor','toString','__proto__']){
    const value=fixture();value.manifest.policy.metric=metric;
    assert.equal(checkMonitoring(requestOf(value)).status,'unknown');
    Object.defineProperty(value.observation.evaluation.metrics,metric,{value:0,enumerable:true});
    assert.equal(checkMonitoring(requestOf(value)).status,'allow');
  }
});
