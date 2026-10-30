import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {createEvaluationReceipt} from '../dist/receipts.js';
import {readRegressionManifest,createRegressionReceipt,readRegressionReceipt,checkRegression} from '../dist/regression.js';

const NOW=1_800_000_000_000,copy=structuredClone;
const artifact=label=>({kind:'artifact',path:'synthetic/'+label,
  sha256:createHash('sha256').update(label).digest('hex'),bytes:100,format:'synthetic-contract-fixture/v1'});
const model=label=>({kind:'model',sessionId:'synthetic',handle:label==='baseline'?1:2,originArtifact:artifact(label),
  inferenceIdentity:{kind:'inference-identity',schemaVersion:1,profile:'synthetic-complete-predictor/v1',sha256:artifact('identity-'+label).sha256}});
const dataset=(label,rows)=>({kind:'dataset',sessionId:'synthetic',handle:rows,rows,shape:[rows,1],role:'validation',artifact:artifact(label)});
function fixture(){
  const baselineModelRef=model('baseline'),candidateModelRef=model('candidate');
  const manifest={kind:'regression-manifest',schemaVersion:1,comparisonId:'predeclared-population',baselineModelRef,candidateModelRef,
    comparison:{datasetRef:dataset('all',100),preprocessingVersion:'train-only-scaler/v1',evaluationMethodVersion:'paired-metrics/v1',parameters:{target:'original-units'}},
    groups:[{groupId:'overall',definitionRef:artifact('all-definition'),membershipRef:artifact('all-membership'),datasetRef:dataset('all',100),expectedRows:100},
      {groupId:'rare',definitionRef:artifact('rare-definition'),membershipRef:artifact('rare-membership'),datasetRef:dataset('rare',10),expectedRows:10}],
    policies:[{groupId:'overall',metric:'mse',direction:'min',maxDeterioration:.1,minSamples:5},
      {groupId:'rare',metric:'mse',direction:'min',maxDeterioration:.1,minSamples:5},
      {groupId:'rare',metric:'utility',direction:'max',maxDeterioration:.05,minSamples:5}],maxAgeMs:100};
  const observations=manifest.groups.map(group=>({groupId:group.groupId,definitionRef:group.definitionRef,membershipRef:group.membershipRef,rows:group.expectedRows,
    baseline:createEvaluationReceipt({...manifest.comparison,datasetRef:group.datasetRef,modelRef:baselineModelRef,
      evaluationId:group.groupId+'-baseline',createdAt:NOW,metrics:{mse:2.25,utility:.9}}),
    candidate:createEvaluationReceipt({...manifest.comparison,datasetRef:group.datasetRef,modelRef:candidateModelRef,
      evaluationId:group.groupId+'-candidate',createdAt:NOW,metrics:{mse:group.groupId==='rare'?7.29:.81,utility:group.groupId==='rare'?.8:.95}})}));
  return {manifest,observations:copy(observations)};
}
function healthy(){
  const value=fixture();
  value.observations.find(group=>group.groupId==='rare').candidate= copy(createEvaluationReceipt({
    ...value.manifest.comparison,datasetRef:value.manifest.groups.find(group=>group.groupId==='rare').datasetRef,
    modelRef:value.manifest.candidateModelRef,evaluationId:'rare-candidate',createdAt:NOW,metrics:{mse:2.3,utility:.92}}));
  return value;
}
const receiptOf=value=>createRegressionReceipt({regressionId:'regression-1',createdAt:NOW+10,...value});
const requestOf=(value,receipt=receiptOf(value))=>({...value,receipt,modelRef:value.manifest.candidateModelRef,now:NOW+20});
const has=(decision,code)=>decision.reasons.some(reason=>reason.code===code);

test('a better overall metric cannot hide a predefined group regression in either metric direction',()=>{
  const value=fixture(),decision=checkRegression(requestOf(value));
  assert.equal(decision.status,'deny');
  const overall=decision.comparisons.find(item=>item.groupId==='overall');
  assert.equal(overall.status,'allow');assert.equal(overall.baselineValue,2.25);assert.equal(overall.candidateValue,.81);
  assert.equal(decision.comparisons.filter(item=>item.status==='deny').length,2);
  assert.ok(has(decision,'regression-deterioration-exceeded'));
});

test('matching paired metrics allow, retain immutable JSON, and survive save/read without recomputing evaluations',()=>{
  const value=healthy(),before=copy(value),receipt=receiptOf(value),decision=checkRegression(requestOf(value,receipt));
  assert.equal(decision.status,'allow');assert.equal(decision.allowed,true);
  assert.ok(Object.isFrozen(receipt.observations[0].candidate.metrics));
  assert.deepEqual(readRegressionReceipt(JSON.parse(JSON.stringify(receipt))),receipt);
  assert.deepEqual(value,before);
  value.manifest.policies[0].maxDeterioration=500;
  assert.notEqual(receipt.manifest.policies[0].maxDeterioration,500);
});

test('absolute boundary equality allows with min and max directions, including improved negative-valued metrics',()=>{
  const value=healthy();
  for(const observation of value.observations){
    observation.baseline={...copy(observation.baseline),metrics:{mse:-4,utility:-8}};
    observation.candidate={...copy(observation.candidate),metrics:{mse:-3,utility:-10}};
  }
  value.manifest.policies.forEach(policy=>policy.maxDeterioration=policy.direction==='min'?1:2);
  assert.equal(checkRegression(requestOf(value)).status,'allow');
  value.observations[1].candidate.metrics.mse=-2.999;
  assert.equal(checkRegression(requestOf(value)).status,'deny');
});

test('a self-consistent offered policy or group definition cannot replace independent protocol authority',()=>{
  const expected=healthy();
  for(const mutate of [
    changed=>changed.manifest.policies[0].maxDeterioration=100,
    changed=>changed.manifest.groups[0].definitionRef=artifact('changed-definition'),
    changed=>changed.manifest.groups[0].membershipRef=artifact('changed-membership'),
    changed=>changed.manifest.comparison.parameters.target='rewritten',
    changed=>changed.manifest.comparison.datasetRef=dataset('another-parent',100),
    changed=>changed.manifest.comparisonId='different-protocol',
  ]){
    const changed=copy(expected);mutate(changed);
    const decision=checkRegression(requestOf(expected,receiptOf(changed)));
    assert.equal(decision.status,'deny');assert.ok(has(decision,'regression-manifest-mismatch'));
  }
});

test('an offered score cannot be rewritten even when its own receipt is internally valid',()=>{
  const expected=fixture(),changed=copy(expected);
  changed.observations[1].candidate.metrics.mse=0;
  const decision=checkRegression(requestOf(expected,receiptOf(changed)));
  assert.equal(decision.status,'deny');assert.ok(has(decision,'regression-observations-mismatch'));
});

test('a different proposed model or measured checkpoint/inference identity is denied, regardless of runtime handle equality',()=>{
  const value=healthy();
  for(const mutate of [ref=>ref.originArtifact=artifact('wrong-checkpoint'),ref=>ref.inferenceIdentity.sha256=artifact('wrong-inference').sha256,
    ref=>delete ref.inferenceIdentity]){
    const modelRef=copy(value.manifest.candidateModelRef);mutate(modelRef);
    assert.equal(checkRegression({...requestOf(value),modelRef}).status,'deny');
  }
  const wrong=copy(value);wrong.observations[1].candidate=createEvaluationReceipt({...wrong.observations[1].candidate,modelRef:wrong.manifest.baselineModelRef});
  assert.ok(has(checkRegression(requestOf(wrong)),'regression-model-mismatch'));
});

test('durable content binding allows relocated handles and paths but not training-only checkpoint replacement',()=>{
  const value=healthy(),receipt=copy(receiptOf(value)),modelRef=copy(value.manifest.candidateModelRef);
  modelRef.handle=900;modelRef.sessionId='restored';modelRef.originArtifact.path='relocated/model';
  receipt.manifest.candidateModelRef=copy(modelRef);
  for(const observation of receipt.observations){
    for(const side of ['baseline','candidate']){
      observation[side].modelRef.sessionId='restored';observation[side].modelRef.handle+=100;
      observation[side].datasetRef.sessionId='restored';observation[side].datasetRef.handle+=100;
    }
  }
  assert.equal(checkRegression({...requestOf(value,receipt),modelRef}).status,'allow');
  modelRef.originArtifact=artifact('training-only-changed-checkpoint');
  assert.equal(checkRegression({...requestOf(value,receipt),modelRef}).status,'deny');
});

test('v1 checkpoint-only evaluations remain supported with exact checkpoint content',()=>{
  const value=healthy();delete value.manifest.baselineModelRef.inferenceIdentity;delete value.manifest.candidateModelRef.inferenceIdentity;
  value.observations=value.observations.map(observation=>({...observation,...Object.fromEntries(['baseline','candidate'].map(side=>
    [side,createEvaluationReceipt({...observation[side],modelRef:value.manifest[side==='baseline'?'baselineModelRef':'candidateModelRef']})]))}));
  assert.equal(value.observations[0].baseline.schemaVersion,1);assert.equal(checkRegression(requestOf(value)).status,'allow');
});

test('missing independent observations, missing offered/independent groups and missing paired evaluations stay unknown',()=>{
  const value=healthy(),request=requestOf(value);
  delete request.observations;assert.equal(checkRegression(request).status,'unknown');
  for(const side of ['offered','independent']){
    const changed=copy(value);changed.observations.pop();
    const decision=side==='offered'?checkRegression(requestOf(value,receiptOf(changed))):checkRegression(requestOf(changed,receiptOf(value)));
    assert.equal(decision.status,'unknown');
  }
  const changed=copy(value);delete changed.observations[1].candidate;
  assert.equal(checkRegression(requestOf(changed)).status,'unknown');
  assert.equal(checkRegression(requestOf(value,receiptOf(changed))).status,'unknown');
});

test('a missing required metric is unknown in either observation source and is not replaced with zero',()=>{
  for(const target of ['offered','independent','both']){
    const value=healthy(),changed=copy(value);delete changed.observations[1].candidate.metrics.mse;
    const decision=target==='offered'?checkRegression(requestOf(value,receiptOf(changed))):target==='independent'?
      checkRegression(requestOf(changed,receiptOf(value))):checkRegression(requestOf(changed));
    assert.equal(decision.status,'unknown');assert.ok(has(decision,'regression-metric-unavailable'));
  }
});

test('minimum sample policy gates regression assessment without pretending to compute significance',()=>{
  const value=fixture();value.manifest.policies.filter(policy=>policy.groupId==='rare').forEach(policy=>policy.minSamples=11);
  const decision=checkRegression(requestOf(value));
  assert.equal(decision.status,'unknown');assert.ok(has(decision,'regression-insufficient-samples'));
  assert.ok(!has(decision,'regression-deterioration-exceeded'));
});

test('unmeasured zero-row groups are unknown while contradictory evaluated counts are denied',()=>{
  const value=healthy();value.observations[1]={...value.observations[1],rows:0};delete value.observations[1].baseline;delete value.observations[1].candidate;
  assert.equal(checkRegression(requestOf(value)).status,'unknown');
  const contradictory=healthy();contradictory.observations[1].rows=1;
  const decision=checkRegression(requestOf(contradictory));assert.equal(decision.status,'deny');assert.ok(has(decision,'regression-row-count-mismatch'));
});

test('wrong observed membership, definition, subset bytes, preprocessing, method or parameters are denied',()=>{
  for(const mutate of [
    group=>group.membershipRef=artifact('wrong-membership'),group=>group.definitionRef=artifact('wrong-definition'),
    group=>group.candidate.datasetRef.artifact=artifact('wrong-subset'),group=>group.candidate.preprocessingVersion='another-scaler',
    group=>group.candidate.evaluationMethodVersion='another-method',group=>group.candidate.parameters={target:'other'},
  ]){
    const value=healthy();mutate(value.observations[1]);assert.equal(checkRegression(requestOf(value)).status,'deny');
  }
});

test('every evaluation and the outer receipt must be fresh, nonfuture and observed before the receipt',()=>{
  const value=healthy();
  for(const side of ['baseline','candidate']){
    const old=copy(value);old.observations[1][side].createdAt=NOW-101;
    assert.ok(has(checkRegression(requestOf(old)),'regression-evidence-expired'));
    const future=copy(value);future.observations[1][side].createdAt=NOW+21;
    assert.ok(has(checkRegression(requestOf(future)),'regression-evidence-from-future'));
    const after=copy(value);after.observations[1][side].createdAt=NOW+11;
    assert.ok(has(checkRegression(requestOf(after)),'regression-receipt-before-evaluation'));
  }
  assert.ok(has(checkRegression({...requestOf(value),now:NOW+111}),'regression-evidence-expired'));
  const futureReceipt={...copy(receiptOf(value)),createdAt:NOW+21};
  assert.ok(has(checkRegression(requestOf(value,futureReceipt)),'regression-evidence-from-future'));
  assert.equal(checkRegression({...requestOf(value),now:NOW+100}).status,'allow');
});

test('known context mismatch is still denied when another metric is missing',()=>{
  const value=healthy();delete value.observations[1].candidate.metrics.mse;value.observations[1].candidate.preprocessingVersion='wrong';
  const decision=checkRegression(requestOf(value));assert.equal(decision.status,'deny');
  assert.ok(has(decision,'regression-evaluation-context-mismatch'));assert.ok(has(decision,'regression-metric-unavailable'));
});

test('group/policy/observation ordering is normalized, but an undeclared group is denied',()=>{
  const value=healthy(),receipt=receiptOf(value);value.manifest.groups.reverse();value.manifest.policies.reverse();value.observations.reverse();
  assert.equal(checkRegression(requestOf(value,receipt)).status,'allow');
  const unexpected=copy(value.observations[0]);unexpected.groupId='not-declared';value.observations.push(unexpected);
  assert.ok(has(checkRegression(requestOf(value)),'regression-undeclared-observation'));
});

test('strict schemas reject duplicate groups/policies/observations, ignored fields and invalid counts',()=>{
  for(const mutate of [
    value=>value.groups.push(copy(value.groups[0])),value=>value.policies.push(copy(value.policies[0])),
    value=>value.policies[0].maxAgeMS=100,value=>value.maxAgeMS=100,value=>value.comparison.extra=true,
    value=>value.policies[0].direction='higher-is-better',value=>value.policies[0].maxDeterioration=-1,
    value=>value.policies[0].minSamples=0,value=>value.groups[0].expectedRows=0,value=>value.groups[0].expectedRows=99,
    value=>value.groups[0].expectedRows=Number.MAX_SAFE_INTEGER+1,value=>value.policies[0].groupId='undeclared',
    value=>value.groups.push({...copy(value.groups[0]),groupId:'uncovered'}),
  ]){const value=fixture().manifest;mutate(value);assert.throws(()=>readRegressionManifest(value));}
  const value=healthy();value.observations.push(copy(value.observations[0]));assert.throws(()=>receiptOf(value));
  const receipt=copy(receiptOf(healthy()));receipt.status='allow';assert.throws(()=>readRegressionReceipt(receipt));
  assert.equal(checkRegression({...requestOf(healthy()),maxAgeMS:100}).status,'unknown');
});

test('nonfinite/executable JSON cannot become a passing comparison and finite overflow stays unknown',()=>{
  for(const invalid of [NaN,Infinity,()=>1]){
    const value=healthy();value.observations[0].candidate.metrics.mse=invalid;assert.throws(()=>receiptOf(value));
    assert.equal(checkRegression({...requestOf(healthy()),observations:value.observations}).status,'unknown');
  }
  const value=healthy();
  value.observations[0].baseline.metrics.mse=-Number.MAX_VALUE;value.observations[0].candidate.metrics.mse=Number.MAX_VALUE;
  const decision=checkRegression(requestOf(value));assert.equal(decision.status,'unknown');assert.ok(has(decision,'regression-deterioration-unrepresentable'));
});

test('empty observations remain a readable unknown receipt rather than an invented pass',()=>{
  const value=healthy();value.observations=[];
  const receipt=receiptOf(value);assert.equal(readRegressionReceipt(receipt).observations.length,0);
  assert.equal(checkRegression(requestOf(value)).status,'unknown');
});

test('metric names never read inherited object properties and an actual own zero remains measurable',()=>{
  for(const metric of ['constructor','toString','__proto__']){
    const value=healthy();value.manifest.policies=[{groupId:'overall',metric,direction:'min',maxDeterioration:0,minSamples:5},
      {groupId:'rare',metric:'mse',direction:'min',maxDeterioration:.1,minSamples:5}];
    const decision=checkRegression(requestOf(value));
    assert.equal(decision.status,'unknown');assert.ok(has(decision,'regression-metric-unavailable'));
    for(const side of ['baseline','candidate'])Object.defineProperty(value.observations[0][side].metrics,metric,{value:0,enumerable:true});
    assert.equal(checkRegression(requestOf(value)).status,'allow');
  }
});
