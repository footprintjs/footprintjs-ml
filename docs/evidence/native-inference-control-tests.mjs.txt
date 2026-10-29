import test from 'node:test';
import assert from 'node:assert/strict';
import {flowChart,FlowChartExecutor,decide} from 'footprintjs';
import {controlDepRecorder} from 'footprintjs/trace';
import {openRecording,traceToolpack,callTraceTool} from 'agentfootprint/observe';
import {openWorkflowRecording} from '../lens/session.mjs';
import {recordedControlBridge} from '../examples/inference/native-control.mjs';

const plain=value=>JSON.parse(JSON.stringify(value));
const bridge={openRecording,traceToolpack,callTraceTool};
async function capturedChoice(){
  let chart=flowChart('Independent permission',s=>{s.allowed=false;},'permission');
  const route=chart.addDeciderFunction('Choose a real branch',s=>decide(s,
    [{when:{allowed:{eq:true}},then:'unexpected'}],'blocked'),'route');
  route.addFunctionBranch('unexpected','Never execute this branch',()=>{throw new Error('Unexpected branch');});
  // This write has no DATA read of permission. Only the genuinely observed
  // control dependency can explain why it ran.
  route.addFunctionBranch('blocked','Withhold the output',s=>{s.handoff='withheld';});
  chart=route.end();
  const executor=new FlowChartExecutor(chart.build()),control=controlDepRecorder();
  executor.setReadTracking('full');executor.setWriteTracking('full');executor.attachFlowRecorder(control);
  await executor.run();
  const snapshot=plain(executor.getSnapshot()),dependencies={};
  for(const commit of snapshot.commitLog){const parent=control.lookup(commit.runtimeStageId);if(parent)dependencies[commit.runtimeStageId]=plain(parent);}
  return {snapshot,supplemental:{nativeControl:{schema:'footprint-control-lookup-snapshot/v1',runId:snapshot.runId,dependencies},nativeDecisions:plain(control.getDecisions())}};
}

test('saved public-recorder observations restore control-aware native backtracking without inferring edges',async()=>{
  const recording=await capturedChoice(),before=JSON.stringify(recording);
  const normal=await openWorkflowRecording(recording,bridge).backtrack('handoff');
  assert.match(normal.result,/control edges unavailable/);assert.doesNotMatch(normal.result,/permission#0/);
  const opened=openWorkflowRecording(recording,recordedControlBridge(recording,bridge));
  const restored=await opened.backtrack('handoff');
  assert.match(restored.result,/blocked#2/);assert.match(restored.result,/route#1/);assert.match(restored.result,/permission#0/);
  assert.doesNotMatch(restored.result,/control edges unavailable/);
  assert.equal(restored.result,await callTraceTool(opened.tools,'backtrack',{variable:'handoff'}));
  assert.equal(JSON.stringify(recording),before);
});

test('retained native control cannot name another run, unknown executions, future decisions or unsupported fields',async()=>{
  const valid=await capturedChoice();
  const controls=[
    r=>{r.supplemental.nativeControl.runId='another-run';},
    r=>{r.supplemental.nativeControl.schema='guessed-control';},
    r=>{r.supplemental.nativeControl.dependencies['absent#999']={deciderId:'route#1'};},
    r=>{r.supplemental.nativeControl.dependencies['blocked#2']={deciderId:'permission#0'};},
    r=>{r.supplemental.nativeControl.dependencies['permission#0']={deciderId:'route#1'};},
    r=>{r.supplemental.nativeControl.dependencies['blocked#2'].inferred=true;},
    r=>{r.supplemental.nativeDecisions.push(r.supplemental.nativeDecisions[0]);},
    r=>{r.snapshot.commitLog.push(r.snapshot.commitLog[0]);},
  ];
  for(const mutate of controls){const changed=plain(valid);mutate(changed);assert.throws(()=>recordedControlBridge(changed,bridge));}
  const custom=recordedControlBridge(valid,bridge),other=plain(valid);other.snapshot.runId='another-run';
  assert.throws(()=>custom.openRecording(other),/different run/);
  const sameRunDifferentSnapshot=plain(valid);sameRunDifferentSnapshot.snapshot.sharedState.handoff='changed';
  assert.throws(()=>custom.openRecording(sameRunDifferentSnapshot),/different captured snapshot/);
});
