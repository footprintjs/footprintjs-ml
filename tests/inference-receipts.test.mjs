import assert from 'node:assert/strict';
import test from 'node:test';
import {createPredictionContract,readPredictionContract,createInferenceReceipt,readInferenceReceipt,checkInference} from '../dist/index.js';

const NOW=1_800_000_000_000;
const clone=value=>structuredClone(value);
const artifact=digit=>({kind:'artifact',path:`fixture/${digit}.json`,sha256:digit.repeat(64),bytes:128,format:'prediction-fixture/json-v1'});
const model=(digit='a')=>({kind:'model',sessionId:'worker-1',handle:1,originArtifact:artifact(digit),
  inferenceIdentity:{kind:'inference-identity',schemaVersion:1,profile:'measured-complete-predictor/v1',sha256:digit.repeat(64)}});
const specification=()=>({profile:'named-tabular-classification/v1',input:{fields:[
  {name:'height',dtype:'float64',unit:'cm'},{name:'width',dtype:'float64',unit:'cm'}]},
  output:{fields:[{name:'label',dtype:'int64'}]},preprocessingVersion:'fitted-scaler/sha256-v1',
  classLabels:[0,1],parameters:{method:'argmax',options:{missing:'reject'}}});
const contract=()=>createPredictionContract(specification());
const observation=()=>({inferenceId:'invocation-1',createdAt:NOW,inputRef:artifact('1'),outputRef:artifact('2'),inputRows:3,outputRows:3,
  modelRef:model(),contract:contract()});
const request=receipt=>({receipt:receipt??createInferenceReceipt(observation()),modelRef:model(),contract:contract(),
  inputRef:artifact('1'),rows:3,inferenceId:'invocation-1',now:NOW+100,maxAgeMs:1000});
const reason=(value,code)=>value.reasons.some(item=>item.code===code);
function status(decision,wanted,code){
  assert.equal(decision.status,wanted);assert.equal(decision.allowed,wanted==='allow');
  if(code)assert.ok(reason(decision,code),`Missing ${code}: ${JSON.stringify(decision.reasons)}`);
}
function changedContract(mutate){const raw=specification();mutate(raw);return createPredictionContract(raw);}

test('prediction contracts and inference receipts survive JSON persistence with explicit ordered semantics',()=>{
  const raw=specification();delete raw.parameters;
  const definition=createPredictionContract(raw);assert.deepEqual(definition.parameters,{});
  assert.deepEqual(readPredictionContract(JSON.parse(JSON.stringify(definition))),definition);
  const receipt=createInferenceReceipt(observation());
  assert.deepEqual(readInferenceReceipt(JSON.parse(JSON.stringify(receipt))),receipt);
  const decision=checkInference(request(receipt));status(decision,'allow','inference-matches-expectation');
  assert.equal(decision.inferenceId,'invocation-1');assert.equal(decision.checkedAt,NOW+100);
  assert.deepEqual(decision.bindings.receipt.outputRef,artifact('2'));
  assert.deepEqual(decision.bindings.expected.contract.input.fields.map(field=>field.name),['height','width']);
});

test('actual model B cannot borrow expected model A identity, while corrected actual A is allowed',()=>{
  const actual=observation();actual.modelRef=model('b');
  status(checkInference(request(createInferenceReceipt(actual))),'deny','inference-model-mismatch');
  status(checkInference(request(createInferenceReceipt(observation()))),'allow');
  const profile=observation();profile.modelRef.inferenceIdentity.profile='another-predictor-profile/v1';
  status(checkInference(request(createInferenceReceipt(profile))),'deny','inference-model-mismatch');
});

test('equal-dimensional batches cannot excuse reordered, renamed or omitted named input/output fields',()=>{
  for(const [side,mutate] of [
    ['input',raw=>raw.input.fields.reverse()],
    ['input',raw=>{raw.input.fields[0].name='length';}],
    ['input',raw=>raw.input.fields.pop()],
    ['output',raw=>{raw.output.fields[0].name='probability';}],
    ['output',raw=>raw.output.fields.push({name:'extra',dtype:'int64'})],
  ]){
    const receipt=createInferenceReceipt({...observation(),contract:changedContract(mutate)});
    status(checkInference(request(receipt)),'deny',`prediction-${side}-fields-mismatch`);
  }
});

test('dtype, units, preprocessing, profile, prediction parameters and ordered label mappings are independent checks',()=>{
  for(const [code,mutate] of [
    ['prediction-input-dtype-mismatch',raw=>{raw.input.fields[0].dtype='float32';}],
    ['prediction-output-dtype-mismatch',raw=>{raw.output.fields[0].dtype='string';}],
    ['prediction-input-unit-mismatch',raw=>{raw.input.fields[0].unit='m';}],
    ['prediction-preprocessing-mismatch',raw=>{raw.preprocessingVersion='other-fitted-scaler/v1';}],
    ['prediction-profile-mismatch',raw=>{raw.profile='another-contract/v1';}],
    ['prediction-parameters-mismatch',raw=>{raw.parameters.method='threshold';}],
    ['prediction-class-labels-mismatch',raw=>raw.classLabels.reverse()],
    ['prediction-class-labels-mismatch',raw=>{raw.classLabels=['0','1'];}],
  ]){
    const receipt=createInferenceReceipt({...observation(),contract:changedContract(mutate)});
    status(checkInference(request(receipt)),'deny',code);
  }
  const observed=observation();observed.contract=changedContract(raw=>{raw.output.fields[0].unit='category-id';});
  const expected=request(createInferenceReceipt(observed));
  expected.contract=changedContract(raw=>{raw.output.fields[0].unit='probability';});
  status(checkInference(expected),'deny','prediction-output-unit-mismatch');
});

test('missing observed model, contract or either measured identity stays unknown without checkpoint fallback',()=>{
  for(const [code,mutate] of [
    ['inference-model-unavailable',raw=>{delete raw.modelRef;}],
    ['inference-contract-unavailable',raw=>{delete raw.contract;}],
    ['inference-identity-unavailable',raw=>{delete raw.modelRef.inferenceIdentity;}],
  ]){
    const raw=observation();mutate(raw);const receipt=createInferenceReceipt(raw);
    status(checkInference(request(receipt)),'unknown',code);
    if(!Object.hasOwn(raw,'modelRef'))assert.equal(Object.hasOwn(receipt,'modelRef'),false);
    if(!Object.hasOwn(raw,'contract'))assert.equal(Object.hasOwn(receipt,'contract'),false);
  }
  const missingExpected=request();delete missingExpected.modelRef.inferenceIdentity;
  status(checkInference(missingExpected),'unknown','inference-identity-unavailable');
  const missingBoth=observation();delete missingBoth.modelRef.inferenceIdentity;
  const both=request(createInferenceReceipt(missingBoth));delete both.modelRef.inferenceIdentity;
  status(checkInference(both),'unknown','inference-identity-unavailable');
});

test('a missing unit or label observation differs from an explicit conflicting observation',()=>{
  for(const [side,code] of [['input','prediction-input-unit-unavailable'],['output','prediction-output-unit-unavailable']]){
    const withUnit=specification();withUnit[side].fields[0].unit='declared-unit';
    const withoutUnit=clone(withUnit);delete withoutUnit[side].fields[0].unit;
    for(const [expected,actual] of [[withUnit,withoutUnit],[withoutUnit,withUnit]]){
      const check=request(createInferenceReceipt({...observation(),contract:createPredictionContract(actual)}));
      check.contract=createPredictionContract(expected);status(checkInference(check),'unknown',code);
    }
  }
  const withoutLabels=specification();delete withoutLabels.classLabels;
  for(const [expected,actual] of [[specification(),withoutLabels],[withoutLabels,specification()]]){
    const check=request(createInferenceReceipt({...observation(),contract:createPredictionContract(actual)}));
    check.contract=createPredictionContract(expected);status(checkInference(check),'unknown','prediction-class-labels-unavailable');
  }
  const noSemantics=withoutLabels;delete noSemantics.input.fields[0].unit;delete noSemantics.input.fields[1].unit;
  const neither=request(createInferenceReceipt({...observation(),contract:createPredictionContract(noSemantics)}));
  neither.contract=createPredictionContract(noSemantics);status(checkInference(neither),'allow');
});

test('known mismatches deny even when other optional actual observations are missing',()=>{
  const actual=observation();actual.modelRef=model('b');delete actual.contract;
  const decision=checkInference(request(createInferenceReceipt(actual)));
  status(decision,'deny','inference-model-mismatch');assert.ok(reason(decision,'inference-contract-unavailable'));
  const unknown=observation();delete unknown.modelRef;unknown.inputRows=2;
  status(checkInference(request(createInferenceReceipt(unknown))),'deny','inference-input-rows-mismatch');
});

test('invocation, consumed input content and actual batch row counts cannot borrow another inference receipt',()=>{
  for(const [code,mutate] of [
    ['inference-id-mismatch',raw=>{raw.inferenceId='previous-invocation';}],
    ['inference-input-mismatch',raw=>{raw.inputRef.sha256='3'.repeat(64);}],
    ['inference-input-mismatch',raw=>{raw.inputRef.bytes++;}],
    ['inference-input-mismatch',raw=>{raw.inputRef.format='other-input-format/v1';}],
    ['inference-input-rows-mismatch',raw=>{raw.inputRows=2;}],
    ['inference-output-rows-mismatch',raw=>{raw.outputRows=2;}],
  ]){
    const raw=observation();mutate(raw);status(checkInference(request(createInferenceReceipt(raw))),'deny',code);
  }
});

test('future and expired receipts are denied, with an inclusive age boundary and an explicit caller clock',()=>{
  const receipt=createInferenceReceipt(observation()),future=request(receipt);future.now=NOW-1;
  status(checkInference(future),'deny','inference-receipt-from-future');
  const old=request(receipt);old.now=NOW+1001;
  status(checkInference(old),'deny','inference-receipt-expired');
  const edge=request(receipt);edge.now=NOW+1000;status(checkInference(edge),'allow');
  const noAge=request(receipt);delete noAge.maxAgeMs;noAge.now=NOW+1001;status(checkInference(noAge),'allow');
  for(const field of ['now','maxAgeMs'])for(const value of [-1,NaN,Infinity,'100']){
    const invalid=request(receipt);invalid[field]=value;status(checkInference(invalid),'unknown','invalid-or-missing-inference-evidence');
  }
});

test('durable model identity accepts new runtime handles and relocated paths with separate checkpoint audit meaning',()=>{
  const expected=request();expected.modelRef.sessionId='new-worker';expected.modelRef.handle=99;
  expected.modelRef.originArtifact.path='relocated/checkpoint.json';expected.modelRef.inferenceIdentity.sha256=expected.modelRef.inferenceIdentity.sha256.toUpperCase();
  expected.inputRef.path='relocated/batch.json';status(checkInference(expected),'allow');
  const trainingOnly=request();trainingOnly.modelRef.originArtifact=artifact('c');
  const decision=checkInference(trainingOnly);status(decision,'allow','checkpoint-differs-inference-matches');
  assert.notDeepEqual(decision.bindings.expected.modelRef.originArtifact,decision.bindings.receipt.modelRef.originArtifact);
});

test('constructors reject malformed or unbounded schemas and readers do not repair incomplete saved evidence',()=>{
  for(const mutate of [
    raw=>{raw.input.fields=[];},raw=>{raw.output.fields=[];},raw=>raw.input.fields.push(clone(raw.input.fields[0])),
    raw=>{raw.input.fields[0].name=' ';},raw=>{raw.output.fields[0].dtype='';},raw=>{raw.input.fields[0].unit=' ';},
    raw=>{raw.input.fields=Array.from({length:257},(_,i)=>({name:`field${i}`,dtype:'float64'}));},
    raw=>{raw.classLabels=[];},raw=>{raw.classLabels=[1,1];},raw=>{raw.classLabels=[true];},
    raw=>{raw.classLabels=[NaN];},raw=>{raw.classLabels=Array.from({length:1025},(_,i)=>i);},
    raw=>{raw.input.extra='unknown';},raw=>{raw.parameters={bad:()=>1};},raw=>{raw.extra='unknown';},
  ]){const raw=specification();mutate(raw);assert.throws(()=>createPredictionContract(raw));}
  const missingParameters=clone(contract());delete missingParameters.parameters;
  assert.throws(()=>readPredictionContract(missingParameters));
  for(const mutate of [raw=>{raw.schemaVersion=2;},raw=>{raw.kind='other';},raw=>{delete raw.schemaVersion;}]){
    const raw=clone(contract());mutate(raw);assert.throws(()=>readPredictionContract(raw));
  }
  const valid=specification();valid.classLabels=[0,'0'];assert.deepEqual(createPredictionContract(valid).classLabels,[0,'0']);
  valid.input.fields=Array.from({length:256},(_,i)=>({name:`field${i}`,dtype:'float64'}));
  valid.classLabels=Array.from({length:1024},(_,i)=>i);assert.equal(createPredictionContract(valid).input.fields.length,256);
});

test('malformed actual artifact, rows, optional values and persisted receipt schemas fail closed',()=>{
  for(const mutate of [
    raw=>{raw.outputRef.sha256='not-a-digest';},raw=>{delete raw.outputRef;},raw=>{raw.inputRows=0;},
    raw=>{raw.outputRows=-1;},raw=>{raw.inputRows=1.5;},raw=>{raw.outputRows=Number.MAX_SAFE_INTEGER+1;},
    raw=>{raw.createdAt=-1;},raw=>{raw.modelRef=null;},raw=>{raw.contract=null;},raw=>{raw.inferenceId='';},
  ]){
    const raw=observation();mutate(raw);assert.throws(()=>createInferenceReceipt(raw));
    const saved={...raw,kind:'inference-receipt',schemaVersion:1};
    assert.throws(()=>readInferenceReceipt(saved));status(checkInference(request(saved)),'unknown','invalid-or-missing-inference-evidence');
  }
  for(const mutate of [raw=>{raw.schemaVersion=99;},raw=>{raw.kind='evaluation-receipt';},raw=>{delete raw.schemaVersion;}]){
    const saved=clone(createInferenceReceipt(observation()));mutate(saved);
    assert.throws(()=>readInferenceReceipt(saved));status(checkInference(request(saved)),'unknown');
  }
  for(const value of [null,{},[]])status(checkInference(value),'unknown');
  const noExpected=request();delete noExpected.contract;status(checkInference(noExpected),'unknown');
  const invalidRows=request();invalidRows.rows=0;status(checkInference(invalidRows),'unknown');
});

test('input snapshots, nested parameters, receipts and decision bindings are detached and deeply frozen',()=>{
  const raw=specification(),definition=createPredictionContract(raw),before=JSON.stringify(definition);
  raw.input.fields[0].unit='m';raw.classLabels.reverse();raw.parameters.options.missing='ignore';
  assert.equal(JSON.stringify(definition),before);assert.ok(Object.isFrozen(definition.input.fields[0]));
  assert.ok(Object.isFrozen(definition.parameters.options));
  const observed=observation(),receipt=createInferenceReceipt(observed),receiptBefore=JSON.stringify(receipt);
  observed.modelRef.inferenceIdentity.sha256='b'.repeat(64);observed.inputRef.bytes++;
  assert.equal(JSON.stringify(receipt),receiptBefore);assert.ok(Object.isFrozen(receipt.outputRef));
  const saved=clone(receipt),read=readInferenceReceipt(saved);saved.contract.input.fields[0].name='changed';
  assert.equal(JSON.stringify(read),receiptBefore);
  const wanted=request(receipt),decision=checkInference(wanted),decisionBefore=JSON.stringify(decision);
  wanted.modelRef.originArtifact.bytes++;wanted.inputRef.sha256='3'.repeat(64);
  assert.equal(JSON.stringify(decision),decisionBefore);assert.ok(Object.isFrozen(decision.bindings.expected.contract.input.fields));
});

test('parameter object key order is immaterial while output evidence remains a producer observation',()=>{
  const actual=observation();actual.contract=changedContract(raw=>{raw.parameters={options:{missing:'reject'},method:'argmax'};});
  // No expected output hash or numerical verifier is supplied by this v1 request.
  actual.outputRef=artifact('f');
  const decision=checkInference(request(createInferenceReceipt(actual)));status(decision,'allow');
  assert.deepEqual(decision.bindings.receipt.outputRef,artifact('f'));
  assert.equal(Object.hasOwn(decision,'qualityDecision'),false);
});
