import test from 'node:test';
import assert from 'node:assert/strict';
import {openAdapterWorkflowRun} from '../lens/session.mjs';

// Synthetic bridge tests exercise binding and time boundaries, not Lens findings.
function fixture(rename={}) {
  const bindings={model:'model',receipt:'evaluation',decision:'releaseDecision',allowed:'allowed',releasedModel:'released'};
  const selection={manifest:'experiment',results:'candidates',receipt:'choiceReceipt',decision:'choiceGuard',candidate:'chosenId',...rename};
  const changes=[
    {experiment:{experimentId:'test',policy:{direction:'min'}},released:null},
    {candidates:[{candidateId:'a',mse:0.1},{candidateId:'b',mse:0.01}]},
    {chosenId:'a',choiceReceipt:{selectedCandidateId:'a'},choiceGuard:{allowed:false},model:{label:'a'},evaluation:{evaluationId:'a-eval'}},
    {releaseDecision:{kind:'release-decision',allowed:false,status:'deny'},allowed:false},
    {chosenId:'b',choiceReceipt:{selectedCandidateId:'b'},choiceGuard:{allowed:true},model:{label:'b'},evaluation:{evaluationId:'b-eval'}},
    {releaseDecision:{kind:'release-decision',allowed:true,status:'allow'},allowed:true},
    {released:{label:'b'}},
  ].map(change=>Object.fromEntries(Object.entries(change).map(([key,value])=>{
    const name=Object.entries({manifest:'experiment',results:'candidates',receipt:'choiceReceipt',decision:'choiceGuard',candidate:'chosenId'}).find(([,old])=>old===key)?.[0];
    return [name?selection[name]:key,value];
  })));
  return {mlInvestigation:{schemaVersion:1,bindings,selection},footprint:{executionTree:{id:'synthetic'},
    commitLog:changes.map((overwrite,idx)=>({idx,stage:`Stage ${idx}`,runtimeStageId:`step-${idx}#${idx}`,overwrite}))}};
}
function bridge() {
  const calls=[];
  const stateAt=(snapshot,index)=>({state:snapshot.commitLog.slice(0,index+1).reduce((s,c)=>Object.assign(s,structuredClone(c.overwrite)),{}),basis:'synthetic'});
  return {calls,stateAt,openRecording:r=>r,traceToolpack:r=>r,
    callTraceTool:async(_tools,name,args)=>{calls.push({name,args});return `SYNTHETIC ${name} - native warning retained verbatim`;},
    findLastWriter(log,key,before=log.length){for(let i=Math.min(before,log.length)-1;i>=0;i--)if(Object.hasOwn(log[i].overwrite,key))return log[i];},
    timeTravel(snapshot){let index=0;const stops=snapshot.commitLog.map((c,i)=>({step:i,commitIdx:i,runtimeStageId:c.runtimeStageId}));return{
      stops,at:()=>stops[index],stateAt:()=>stateAt(snapshot,index),changedSince:()=>[],jumpTo(target){const next=typeof target==='number'?target:stops.findIndex(s=>s.runtimeStageId===target);if(next<0||next>=stops.length)return{moved:false};const moved=next!==index;index=next;return{moved};}};}};
}

test('selection projection and queries stay bounded to the selected earlier denial',async()=>{
  const input=fixture(),before=JSON.stringify(input),native=bridge();
  const session=openAdapterWorkflowRun(input,native,{decisionStageId:'step-3#3'});
  assert.equal(session.summary.selection.candidate,'a');
  assert.equal(session.summary.selection.decision.allowed,false);
  assert.equal(session.summary.selection.receipt.selectedCandidateId,'a');
  assert.deepEqual(session.summary.releasedModel,{label:'b'});
  assert.equal(session.summary.selection.writerStageIds.candidate,'step-2#2');
  assert.equal(session.anchors.selectionManifest,'step-0#0');
  assert.equal(session.anchors.selectionDecision,'step-2#2');
  await session.investigate('selection');
  assert.ok(native.calls.some(c=>c.name==='who_wrote'&&c.args.key==='chosenId'&&c.args.beforeStageId==='step-4#4'));
  assert.ok(native.calls.some(c=>c.name==='get_value'&&c.args.key==='choiceGuard'&&c.args.runtimeStageId==='step-3#3'));
  assert.ok(native.calls.some(c=>c.name==='backtrack'&&c.args.variable==='chosenId'&&c.args.before===4));
  assert.ok(session.transcript.every(c=>c.result===`SYNTHETIC ${c.tool} - native warning retained verbatim`));
  assert.equal(JSON.stringify(input),before);
});

test('renamed selection bindings drive the latest projection and all queries',async()=>{
  const input=fixture({manifest:'plan',results:'observations',receipt:'selectionProof',decision:'selectionCheck',candidate:'proposal'});
  const native=bridge(),session=openAdapterWorkflowRun(input,native);
  assert.equal(session.summary.selection.candidate,'b');
  assert.equal(session.summary.selection.decision.allowed,true);
  assert.equal(session.summary.selection.writerStageIds.receipt,'step-4#4');
  await session.investigate('selection');
  for(const key of Object.values(input.mlInvestigation.selection))assert.ok(native.calls.some(c=>c.name==='get_value'&&c.args.key===key));
  assert.deepEqual(session.recording.mlInvestigation.selection,input.mlInvestigation.selection);
});

test('selection is optional, and missing captured values stay unavailable',async()=>{
  const input=fixture();delete input.mlInvestigation.selection;
  const legacy=openAdapterWorkflowRun(input,bridge());assert.equal(Object.hasOwn(legacy.summary,'selection'),false);
  await assert.rejects(legacy.investigate('selection'),/requires explicit/);
  const absent=fixture();for(const c of absent.footprint.commitLog)for(const key of Object.values(absent.mlInvestigation.selection))delete c.overwrite[key];
  const session=openAdapterWorkflowRun(absent,bridge());assert.equal(session.summary.selection.receipt,undefined);
  assert.equal(session.summary.selection.writerStageIds.receipt,undefined);
  await session.investigate('selection');assert.ok(session.transcript.some(c=>c.tool==='get_value'&&c.args.key==='choiceReceipt'));
});

test('selection keys reject malformed, duplicate and cross-domain collisions',()=>{
  for(const bad of [null,[],{manifest:'x'},{manifest:'x',results:'x',receipt:'r',decision:'d',candidate:'c'},
    {manifest:'model',results:'rs',receipt:'r',decision:'d',candidate:'c'}]){
    const input=fixture();input.mlInvestigation.selection=bad;assert.throws(()=>openAdapterWorkflowRun(input,bridge()),/selection|distinct/);
  }
  const input=fixture();input.mlInvestigation.dataLineage={receipt:'lineage',decision:'lineageCheck',preprocessing:'fit',manifest:'experiment'};
  assert.throws(()=>openAdapterWorkflowRun(input,bridge()),/distinct/);
});
