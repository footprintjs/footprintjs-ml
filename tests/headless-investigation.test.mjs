import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import * as moduleApi from 'node:module';
import {flowChart,FlowChartExecutor} from 'footprintjs';
import {openRecording,traceToolpack,callTraceTool} from 'agentfootprint/observe';
import {normaliseStateKey} from 'foottrace/paths';
import {openWorkflowRecording} from '../lens/session.mjs';

const bridge={openRecording,traceToolpack,callTraceTool};
const plain=value=>JSON.parse(JSON.stringify(value));
const cli=resolve('examples/quickstart/cli.mjs');
const descriptor={schemaVersion:1,bindings:{model:'modelRef',receipt:'evaluationReceipt',decision:'releaseDecision',allowed:'releaseAllowed',releasedModel:'approvedModel'}};

// A native FootPrint recording fixture, not a numerical trainer. It tests the
// evidence boundary with actual commits, read tracking and existing Lens tools.
async function recordedWorkflow({release=true,repeatedDenial=false}={}){
 const evaluate=scope=>{scope.evaluationReceipt={kind:'evaluation-receipt',modelRef:plain(scope.modelRef),
  datasetRef:plain(scope.datasetRef),metrics:{accuracy:0.91}};};
 const guard=scope=>{
  const allowed=scope.modelRef.checkpoint===scope.evaluationReceipt.modelRef.checkpoint;
  scope.guardAttempt=scope.guardAttempt+1;
  scope.releaseDecision={kind:'release-decision',schemaVersion:1,allowed,status:allowed?'allow':'deny',reasons:allowed?[]:['model-mismatch'],attempt:scope.guardAttempt};
  scope.releaseAllowed=allowed;
 };
 const chart=flowChart('Record validation data',scope=>{
  scope.datasetRef={id:'validation-v1'};scope.approvedModel=null;scope.guardAttempt=0;
 },'data')
 .addFunction('Train checkpoint A',scope=>{scope.modelRef={checkpoint:'A'};},'train-a')
 .addFunction('Validate A',evaluate,'validate-a');
 if(release){
  chart.addFunction('Continue to B',scope=>{scope.modelRef={checkpoint:'B',parent:scope.modelRef.checkpoint};},'continue-b')
   .addFunction('Reject stale evaluation',guard,'guard-stale');
  if(repeatedDenial)chart.addFunction('Retry the same denied handoff',guard,'guard-retry');
  chart.addFunction('Validate B',evaluate,'validate-b')
   .addFunction('Allow fresh evaluation',guard,'guard-fresh')
   .addFunction('Record approved model',scope=>{scope.approvedModel=plain(scope.modelRef);},'publish');
 }
 const executor=new FlowChartExecutor(chart.build());
 executor.setReadTracking('full');executor.setWriteTracking('full');
 await executor.run();
 return {snapshot:plain(executor.getSnapshot()),...(release?{mlInvestigation:descriptor}:{})};
}

test('headless entry opens a healthy evaluation without release bindings and preserves native output',async()=>{
 const input=await recordedWorkflow({release:false}), original=JSON.stringify(input);
 const session=openWorkflowRecording(input,bridge);
 const entry=await session.backtrack('evaluationReceipt');
 assert.equal(entry.result,await callTraceTool(session.tools,'backtrack',{variable:'evaluationReceipt'}));
 assert.match(entry.result,/validate-a#2/);assert.match(entry.result,/train-a#1/);assert.match(entry.result,/data#0/);
 assert.match(entry.result,/control edges unavailable/);
 assert.equal(session.transcript.length,1);assert.equal(entry.owner,'agentfootprint/observe: existing Lens toolpack');
 assert.equal(JSON.stringify(input),original);assert.strictEqual(session.snapshot,input.snapshot);
 for(const wrapper of [input.snapshot,{footprint:input.snapshot},{snapshot:input.snapshot,events:[],structure:{id:'fixture'}}]){
  assert.match((await openWorkflowRecording(wrapper,bridge).backtrack('evaluationReceipt')).result,/validate-a#2/);
 }
});

test('an exclusive before bound explains stale state without borrowing later evaluation or decisions',async()=>{
 const input=await recordedWorkflow(), session=openWorkflowRecording(input,bridge);
 const index=input.snapshot.commitLog.findIndex(commit=>commit.stageId==='guard-stale');
 const entry=await session.backtrack('releaseDecision',{before:index+1});
 assert.match(entry.result,/guard-stale#4/);assert.match(entry.result,/continue-b#3/);assert.match(entry.result,/validate-a#2/);
 assert.doesNotMatch(entry.result,/validate-b#5|guard-fresh#6|publish#7/);
 const current=await session.backtrack('releaseDecision');
 assert.match(current.result,/guard-fresh#6/);assert.match(current.result,/validate-b#5/);
 assert.deepEqual(session.transcript.map(row=>row.ordinal),[1,2]);
 assert.deepEqual(entry.args,{variable:'releaseDecision',before:index+1});
});

test('missing read capture, truncation and native argument corrections remain visible',async()=>{
 const input=await recordedWorkflow(), missing=plain(input);
 const strip=value=>{if(value&&typeof value==='object'){delete value.stageReads;for(const child of Object.values(value))strip(child);}};
 strip(missing.snapshot.executionTree);
 const withoutReads=await openWorkflowRecording(missing,bridge).backtrack('releaseDecision');
 assert.match(withoutReads.result,/no per-step read tracking/);
 assert.doesNotMatch(withoutReads.result,/validate-b#5/);
 const session=openWorkflowRecording(input,bridge);
 const truncated=await session.backtrack('releaseDecision',{maxDepth:1,maxNodes:2});
 assert.match(truncated.result,/truncated/);
 const bad=await session.call('backtrack',{variable:'releaseDecision',maxDepth:'invalid'});
 assert.equal(bad.result,await callTraceTool(session.tools,'backtrack',{variable:'releaseDecision',maxDepth:'invalid'}));
 assert.match(bad.result,/invalid|integer|validation/i);
 const extra=await session.call('backtrack',{variable:'releaseDecision',invented:true});
 assert.equal(extra.result,await callTraceTool(session.tools,'backtrack',{variable:'releaseDecision',invented:true}));
});

test('explicit native path addresses can read descendants of whole-object writes',async()=>{
 const input=await recordedWorkflow({release:false}), session=openWorkflowRecording(input,bridge);
 const entry=await session.call('get_value',{runtimeStageId:'validate-a#2',key:normaliseStateKey(['evaluationReceipt','metrics','accuracy'])});
 assert.match(entry.result,/0\.91/);assert.doesNotMatch(entry.result,/no tracked write/);
});

test('saved snapshot and minimal bridge failures are clear',()=>{
 assert.throws(()=>openWorkflowRecording({},bridge),/saved FootPrint snapshot/);
 assert.throws(()=>openWorkflowRecording({commitLog:[],executionTree:{}},{}),/missing openRecording/);
});

async function withRun(input,fn){
 const root=await mkdtemp(resolve(tmpdir(),'footprint-ml-headless-'));
 try{await writeFile(resolve(root,'recording.json'),JSON.stringify(input));return await fn(root);}
 finally{await rm(root,{recursive:true,force:true});}
}
const invoke=(root,...args)=>spawnSync(process.execPath,[cli,'investigate','--run',root,...args],{encoding:'utf8'});

test('CLI investigates a no-release saved run from a JSON path',async()=>{
 await withRun(await recordedWorkflow({release:false}),async root=>{
  const result=invoke(resolve(root,'recording.json'),'--variable','evaluationReceipt','--before','3');
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/train-a#1/);
  const report=JSON.parse(await readFile(resolve(root,'investigation-variable.json'),'utf8'));
  assert.equal(report.schema,'footprint-ml-variable-investigation/v1');assert.equal(report.before,3);
  assert.match(report.transcript[0].result,/validate-a#2/);
  assert.deepEqual(report.execution,{savedJsonOnly:true,trainerStarted:false,trainingRepeated:false});
 });
});

test('CLI retains stale/fresh reports, rejects ambiguous status and honors an explicit decision stage',async()=>{
 await withRun(await recordedWorkflow(),async root=>{
  for(const [decision,file,stage] of [['stale','investigation.json','guard-stale#4'],['fresh','investigation-fresh.json','guard-fresh#6']]){
   const result=invoke(root,'--decision',decision);assert.equal(result.status,0,result.stderr);
   const report=JSON.parse(await readFile(resolve(root,file),'utf8'));
   assert.equal(report.summary.selectedDecisionStageId,stage);
  }
 });
 await withRun(await recordedWorkflow({repeatedDenial:true}),async root=>{
  const ambiguous=invoke(root,'--decision','stale');assert.equal(ambiguous.status,1);
  assert.match(ambiguous.stderr,/Multiple stale decisions.*--stage.*guard-stale#4.*guard-retry#5/);
  const explicit=invoke(root,'--stage','guard-stale#4');assert.equal(explicit.status,0,explicit.stderr);
  const report=JSON.parse(await readFile(resolve(root,'investigation-stage.json'),'utf8'));
  assert.equal(report.stage,'guard-stale#4');assert.equal(report.summary.selectedDecisionStageId,'guard-stale#4');
  assert.equal(report.summary.evaluationReceipt.modelRef.checkpoint,'A');
  const slice=report.transcript.find(entry=>entry.tool==='backtrack').result;
  assert.match(slice,/validate-a#2/);assert.doesNotMatch(slice,/validate-b#6|guard-fresh#7/);
  const invalid=invoke(root,'--stage','train-a#1');assert.equal(invalid.status,1);assert.match(invalid.stderr,/not a recorded release decision/);
 });
});

test('CLI rejects malformed bounds and conflicting arguments before reading or loading optional tools',()=>{
 for(const args of [['--before','2'],['--variable','x','--before','-1'],['--variable','x','--before','1.5'],['--variable','x','--stage','guard#1']]){
  const result=invoke('/does-not-exist',...args);assert.equal(result.status,1);assert.doesNotMatch(result.stderr,/ENOENT|ERR_MODULE_NOT_FOUND/);
 }
});

test('optional lens entry imports no engine, trainer, UI or toolpack dependency',t=>{
 if(typeof moduleApi.registerHooks!=='function'){t.skip('Module graph observation requires registerHooks.');return;}
 const script=`import {registerHooks} from 'node:module';
 const hook=registerHooks({resolve(specifier,context,next){if(['agentfootprint','foottrace','footprintjs','react','react-dom','@xyflow/react','node:child_process','footprintjs-ml/adapter','footprintjs-ml/release','footprintjs-ml/conformance'].some(name=>specifier===name||specifier.startsWith(name+'/')))throw new Error('Unexpected optional dependency '+specifier);return next(specifier,context);}});
 const api=await import('footprintjs-ml/lens');
 if(typeof api.openWorkflowRecording!=='function')throw new Error('Missing headless entry');
 hook.deregister();`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});
