import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {openRecording,traceToolpack,callTraceTool} from 'agentfootprint/observe';
import {normaliseStateKey} from 'foottrace/paths';
import {openWorkflowRecording} from 'footprintjs-ml/lens';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function investigateRegression(directory){
 const root=resolve(directory),recordPath=resolve(root,'recording.json'),outcomePath=resolve(root,'outcome.json');
 const before=await readFile(recordPath),outcomeBytes=await readFile(outcomePath);
 const recording=JSON.parse(before),outcome=JSON.parse(outcomeBytes),snapshot=recording.snapshot,state=snapshot.sharedState;
 assert.equal(recording.schema,'footprint-ml-python-capture/v1');assert.deepEqual(state.outcome,outcome);
 const stage=id=>{const items=snapshot.commitLog.filter(c=>c.stageId===id);assert.equal(items.length,1,id);return items[0].runtimeStageId;};
 const session=openWorkflowRecording(recording,{openRecording,traceToolpack,callTraceTool});
 const chains={};
 for(const key of ['pooledDecision','unchangedDecision','blockedRelease','retainedRelease','approvedPublication','wrongProtocolDecision','insufficientCoverageDecision'])
  chains[key]=(await session.backtrack(key,{maxDepth:24,maxNodes:180})).result;
 const get=(id,key)=>session.call('get_value',{runtimeStageId:stage(id),key:normaliseStateKey(key)});
 const quality=await get('release-blocked',['blockedRelease','decision','checks','quality','allowed']);
 const selection=await get('release-blocked',['blockedRelease','decision','checks','selection','allowed']);
 const regression=await get('release-blocked',['blockedRelease','decision','checks','regression','status']);
 const comparisons=await get('check-pooled-regression',['pooledDecision','comparisons']);
 const original=await get('release-blocked',['blockedReleaseRef']);
 const definitionWriter=await session.call('who_wrote',{key:'groupDefinitions',beforeStageId:stage('check-pooled-regression')});
 const observationWriter=await session.call('who_wrote',{key:'pooledReceipts',beforeStageId:stage('check-pooled-regression')});
 const releaseNode=await session.call('trace_node',{runtimeStageId:stage('release-retained')});
 const checks={
  capturedOutcomeMatches:true,
  pooledDecisionReachesBaselineEvaluation:chains.pooledDecision.includes(stage('evaluate-baseline')),
  pooledDecisionReachesActualCandidateEvaluation:chains.pooledDecision.includes(stage('evaluate-pooled')),
  pooledDecisionReachesPredeclaredDefinitions:chains.pooledDecision.includes(stage('declare-before-training'))&&definitionWriter.result.includes(stage('declare-before-training')),
  pooledDecisionReachesMeasuredGroupMembership:chains.pooledDecision.includes(stage('generate-declared-data')),
  actualObservationWriterVisible:observationWriter.result.includes(stage('evaluate-pooled')),
  blockedReleaseReachesRequiredRegression:chains.blockedRelease.includes(stage('check-pooled-regression')),
  blockedReleaseDoesNotBorrowLaterControl:!chains.blockedRelease.includes(stage('release-retained')),
  matchedControlReachesItsOwnExecutedEvaluation:chains.retainedRelease.includes(stage('evaluate-unchanged')),
  handoffReachesActualRelease:chains.approvedPublication.includes(stage('release-retained')),
  scopeShowsOverallQualityAndSelectionPass:quality.result.includes('true')&&selection.result.includes('true'),
  scopeShowsRegressionDenial:regression.result.includes('deny'),
  actualGroupDeltaAndCountsVisible:comparisons.result.includes('rare')&&comparisons.result.includes('deterioration')&&comparisons.result.includes('10'),
  fullOriginalResponseReferenceVisible:original.result.includes(state.blockedReleaseRef.sha256),
  nativeMissingControlWarningsPreserved:Object.values(chains).some(text=>text.includes('control edges unavailable')),
  scopeRemainsPythonOwned:outcome.execution.orchestration==='Python with native foottrace capture',
  allWorkflowChecksPass:Object.keys(outcome.checks).length===16&&Object.values(outcome.checks).every(Boolean),
  recordingUnchanged:sha(before)===sha(await readFile(recordPath)),
  outcomeUnchanged:sha(outcomeBytes)===sha(await readFile(outcomePath)),
 };
 assert(Object.values(checks).every(Boolean),Object.entries(checks).filter(([,ok])=>!ok).map(([key])=>key).join(', '));
 const report={schema:'footprint-ml-regression-investigation/v1',passed:true,checks,nativeQueries:session.transcript.length,
  sources:{recording:{sha256:sha(before),bytes:before.length},outcome:{sha256:sha(outcomeBytes),bytes:outcomeBytes.length}},
  transcript:session.transcript,releaseNode:releaseNode.result,
  execution:{savedJsonOnly:true,trainingStarted:false,numpyImported:false,guardRecomputed:false,publicationPerformed:false},
  boundaries:outcome.boundaries};
 await writeFile(resolve(root,'native-investigation.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);assert.equal(args.length,2,'Use --run DIR');assert.equal(args[0],'--run');
 const report=await investigateRegression(args[1]);console.log(JSON.stringify({passed:report.passed,checks:Object.keys(report.checks).length,nativeQueries:report.nativeQueries}));
}
