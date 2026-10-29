import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

// This adapter reopens lookup RESULTS captured from the public live
// controlDepRecorder. It never infers a governing decision from stage order,
// a model label or the chart specification, and supplies no capture attestation.
export function recordedControlBridge(recording,bridge){
  const retained=recording?.supplemental?.nativeControl;
  assert.equal(retained?.schema,'footprint-control-lookup-snapshot/v1','Missing or unsupported retained native control lookup');
  const snapshot=recording.snapshot;
  assert.equal(typeof snapshot?.runId,'string');
  assert.equal(retained.runId,snapshot.runId,'Native control lookup belongs to another run');
  const runId=snapshot.runId,snapshotDigest=fingerprint(snapshot);
  const commits=snapshot.commitLog;
  assert(Array.isArray(commits)&&commits.length<=4096,'Native control lookup requires a bounded commit log');
  const positions=new Map();
  for(const [index,commit] of commits.entries()){
    assert.equal(typeof commit.runtimeStageId,'string');
    assert(!positions.has(commit.runtimeStageId),'Ambiguous committed execution identity');
    positions.set(commit.runtimeStageId,index);
  }
  const decisions=recording.supplemental.nativeDecisions;
  assert(Array.isArray(decisions)&&decisions.length<=4096,'Missing retained native decision observations');
  const deciders=new Set(decisions.map(decision=>{
    const id=decision.deciderRuntimeStageId;
    assert(positions.has(id),'Retained decision has no committed execution');return id;
  }));
  assert.equal(deciders.size,decisions.length,'Duplicate retained decision observations');
  const dependencies=retained.dependencies;
  assert(dependencies&&typeof dependencies==='object'&&!Array.isArray(dependencies),'Invalid retained native control dependencies');
  assert(Object.keys(dependencies).length<=4096,'Too many retained native control dependencies');
  const lookup=new Map();
  for(const [id,value] of Object.entries(dependencies)){
    assert(id.length>0&&id.length<=512&&positions.has(id),'Control-dependent execution was not committed');
    assert(value&&typeof value==='object'&&!Array.isArray(value),'Invalid native control observation');
    assert(Object.keys(value).every(key=>['deciderId','label'].includes(key)),'Unsupported native control observation field');
    const {deciderId,label}=value;
    assert(typeof deciderId==='string'&&deciders.has(deciderId),'Governing decision was not observed by the native recorder');
    assert(positions.get(deciderId)<positions.get(id),'Governing decision must precede its dependent execution');
    assert(label===undefined||(typeof label==='string'&&label.length<=512),'Invalid retained rule label');
    lookup.set(id,Object.freeze({deciderId,...(label===undefined?{}:{label})}));
  }
  assert.equal(typeof bridge?.openRecording,'function');
  return {...bridge,openRecording(input){
    const artifacts=bridge.openRecording(input);
    assert.equal(artifacts.snapshot.runId,runId,'Opening a different run with this retained control lookup');
    assert.equal(fingerprint(artifacts.snapshot),snapshotDigest,'Opening a different captured snapshot with this retained control lookup');
    return {...artifacts,controlDeps:id=>lookup.get(id)};
  }};
}
