import test from 'node:test';
import assert from 'node:assert/strict';
import { openAdapterWorkflowRun } from '../lens/session.mjs';

// A deliberately synthetic public bridge. Its strings are test evidence only,
// never passed off as native Lens findings in the example or saved reports.
function fixture(rename = {}) {
  const bindings = { model:'activePredictor',receipt:'approval',decision:'policyDecision',allowed:'publishAllowed',releasedModel:'releasedPredictor' };
  const dataLineage = { receipt:'dataLineage',decision:'lineageDecision',preprocessing:'preprocessingFit',manifest:'splitManifest',...rename };
  const artifact = digit => ({ kind:'artifact',path:`synthetic-${digit}`,bytes:5,format:'synthetic-only',sha256:digit.repeat(64) });
  const model = { kind:'model',sessionId:'synthetic',handle:1,originArtifact:artifact('1'),
    inferenceIdentity:{kind:'inference-identity',schemaVersion:1,profile:'synthetic/v1',sha256:'2'.repeat(64)} };
  const dataset = (role,rows,digit) => ({ kind:'dataset',sessionId:'synthetic',handle:Number(digit),role,rows,shape:[rows,2],artifact:artifact(digit) });
  const training=dataset('training',40,'3'),validation=dataset('validation',20,'4');
  const fit = dirty => ({ artifact:artifact(dirty?'6':'5'),fitDatasetRefs:dirty?[training,validation]:[training],observation:{fitRows:dirty?60:40} });
  const receipt = dirty => ({ kind:'data-lineage-receipt',schemaVersion:1,lineageId:dirty?'bad':'good',modelRef:model,datasetRef:validation,
    trainingDatasetRef:training,splitManifest:artifact('7'),preprocessing:fit(dirty),
    overlap:{evidenceArtifact:artifact('8'),trainEvaluationRows:0,preprocessingEvaluationRows:dirty?20:0} });
  const lineageDecision = allowed => ({kind:'data-lineage-decision',schemaVersion:1,allowed,status:allowed?'allow':'deny',reasons:[]});
  const releaseDecision = allowed => ({kind:'release-decision',schemaVersion:1,allowed,status:allowed?'allow':'deny',reasons:[]});
  const overwrites=[
    {[bindings.releasedModel]:null,[dataLineage.preprocessing]:null},
    {[dataLineage.manifest]:artifact('7')},
    {[dataLineage.preprocessing]:fit(false)},
    {[bindings.model]:model,[bindings.receipt]:{kind:'evaluation-receipt',schemaVersion:2,modelRef:model,inferenceIdentity:model.inferenceIdentity,checkpointForAudit:{kind:'checkpoint',artifact:model.originArtifact}}},
    {[dataLineage.receipt]:receipt(false),[dataLineage.decision]:lineageDecision(true)},
    {[bindings.decision]:releaseDecision(true),[bindings.allowed]:true},
    {[dataLineage.preprocessing]:fit(true)},
    {[dataLineage.receipt]:receipt(true),[dataLineage.decision]:lineageDecision(false)},
    {[bindings.decision]:releaseDecision(false),[bindings.allowed]:false},
  ];
  const names=['initialise','make-manifest','first-fit','load-model','clean-lineage','clean-policy','second-fit','dirty-lineage','dirty-policy'];
  const commitLog=overwrites.map((overwrite,idx)=>({idx,stage:`Synthetic ${names[idx]}`,stageId:names[idx],runtimeStageId:`${names[idx]}#${idx}`,overwrite}));
  return {mlInvestigation:{schemaVersion:1,bindings,dataLineage},footprint:{commitLog,executionTree:{id:'synthetic-only'}},rows:[]};
}
function bridge() {
  const calls=[];
  const stateAt=(snapshot,through)=>({basis:'synthetic-only',state:snapshot.commitLog.slice(0,through+1).reduce((s,c)=>Object.assign(s,structuredClone(c.overwrite)),{})});
  return {calls,stateAt,
    openRecording(recording){return {recording};},
    traceToolpack(artifacts){return {artifacts};},
    async callTraceTool(_tools,tool,args){calls.push({tool,args:structuredClone(args)});return `SYNTHETIC ${tool}: missing-controlDeps-warning remains verbatim`;},
    findLastWriter(log,key,before=log.length){for(let i=Math.min(before,log.length)-1;i>=0;i--)if(Object.hasOwn(log[i].overwrite,key))return log[i];},
    timeTravel(snapshot){let index=0;const stops=snapshot.commitLog.map((c,i)=>({step:i,commitIdx:i,runtimeStageId:c.runtimeStageId}));return {stops,at:()=>stops[index],stateAt:()=>stateAt(snapshot,index),changedSince:()=>[],jumpTo(target){const next=typeof target==='number'?target:stops.findIndex(s=>s.runtimeStageId===target);if(next<0||next>=stops.length)return{moved:false,reason:'missing'};const moved=next!==index;index=next;return{moved,reason:'same'};}};},
  };
}

test('lineage bindings are optional and the existing five-binding API remains unchanged',async()=>{
  const input=fixture();delete input.mlInvestigation.dataLineage;
  const s=openAdapterWorkflowRun(input,bridge());
  assert.equal(Object.hasOwn(s.recording.mlInvestigation,'dataLineage'),false);
  assert.equal(Object.hasOwn(s.summary,'dataLineage'),false);
  assert.equal(Object.hasOwn(s.projectState(s.selected.state),'dataLineage'),false);
  await assert.rejects(s.investigate('lineage'),/requires explicit/);
  await s.investigate('gate');assert.ok(s.transcript.length>0);
});

test('lineage binding validation rejects missing, duplicate and cross-binding keys',()=>{
  for(const bad of [null,[],{receipt:'x'},{receipt:'x',decision:'x',preprocessing:'z',manifest:'w'},
    {receipt:'approval',decision:'d',preprocessing:'p',manifest:'m'}]){
    const input=fixture();input.mlInvestigation.dataLineage=bad;
    assert.throws(()=>openAdapterWorkflowRun(input,bridge()),/dataLineage|distinct/);
  }
});

test('selected lineage is captured at the selected release decision, never borrowed from later commits',()=>{
  const input=fixture(),s=openAdapterWorkflowRun(input,bridge(),{decisionStageId:'clean-policy#5'});
  assert.equal(s.summary.dataLineage.receipt.lineageId,'good');
  assert.equal(s.summary.dataLineage.decision.allowed,true);
  assert.equal(s.summary.dataLineage.preprocessing.fitDatasetRefs.length,1);
  assert.equal(s.summary.dataLineage.preprocessingWriterStageId,'first-fit#2');
  assert.equal(s.summary.dataLineage.firstCapturedPreprocessingFitWriterStageId,'first-fit#2');
  assert.equal(s.summary.dataLineage.manifestWriterStageId,'make-manifest#1');
  assert.equal(s.summary.releaseDecision.kind,'release-decision');
  assert.equal(s.summary.checkpointMatches,true);
  assert.equal(s.summary.inferenceMatches,true);
});

test('the first captured fit stays distinct from the latest fit and initial null is ignored',()=>{
  const s=openAdapterWorkflowRun(fixture(),bridge());
  assert.equal(s.summary.dataLineage.receipt.lineageId,'bad');
  assert.equal(s.summary.dataLineage.decision.allowed,false);
  assert.equal(s.summary.dataLineage.preprocessingWriterStageId,'second-fit#6');
  assert.equal(s.summary.dataLineage.firstCapturedPreprocessingFitWriterStageId,'first-fit#2');
  assert.equal(s.anchors.firstPreprocessingFit,'first-fit#2');
  assert.equal(s.projectState(s.selected.state).dataLineage.preprocessing.observation.fitRows,60);
});

test('lineage investigation uses native tool entry points and preserves their result strings',async()=>{
  const input=fixture(),native=bridge(),before=JSON.stringify(input),s=openAdapterWorkflowRun(input,native,{decisionStageId:'clean-policy#5'});
  await s.investigate('lineage');
  assert.ok(native.calls.some(c=>c.tool==='who_wrote'&&c.args.key==='dataLineage'&&c.args.beforeStageId==='second-fit#6'));
  assert.ok(native.calls.some(c=>c.tool==='who_wrote'&&c.args.key==='preprocessingFit'&&c.args.beforeStageId==='load-model#3'));
  assert.ok(native.calls.some(c=>c.tool==='get_value'&&c.args.key==='preprocessingFit'&&c.args.runtimeStageId==='first-fit#2'));
  assert.ok(native.calls.some(c=>c.tool==='backtrack'&&c.args.variable==='dataLineage'&&c.args.before===6));
  assert.ok(native.calls.some(c=>c.tool==='backtrack'&&c.args.variable==='preprocessingFit'&&c.args.before===6));
  assert.ok(s.transcript.every(c=>c.result===`SYNTHETIC ${c.tool}: missing-controlDeps-warning remains verbatim`));
  assert.equal(JSON.stringify(input),before);
});

test('renamed lineage keys drive both state projection and native queries',async()=>{
  const rename={receipt:'originTicket',decision:'originPolicy',preprocessing:'fitEvidence',manifest:'partitionArtifact'};
  const input=fixture(rename),native=bridge(),s=openAdapterWorkflowRun(input,native);
  assert.equal(s.summary.dataLineage.receipt.lineageId,'bad');
  await s.investigate('lineage');
  for(const key of Object.values(rename))assert.ok(native.calls.some(c=>c.tool==='get_value'&&c.args.key===key));
  assert.ok(native.calls.some(c=>c.tool==='backtrack'&&c.args.variable==='originTicket'));
});

test('missing lineage values remain unavailable rather than becoming a fabricated pass or failure',async()=>{
  const input=fixture(),keys=new Set(Object.values(input.mlInvestigation.dataLineage));
  for(const commit of input.footprint.commitLog)for(const key of keys)delete commit.overwrite[key];
  const s=openAdapterWorkflowRun(input,bridge());
  assert.equal(s.summary.dataLineage.receipt,undefined);
  assert.equal(s.summary.dataLineage.decision,undefined);
  assert.equal(s.summary.dataLineage.firstCapturedPreprocessingFitWriterStageId,undefined);
  await s.investigate('lineage');
  assert.ok(s.transcript.some(c=>c.tool==='get_value'&&c.args.key==='dataLineage'));
});
