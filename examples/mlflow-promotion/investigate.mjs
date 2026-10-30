import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {openRecording,traceToolpack,callTraceTool} from 'agentfootprint/observe';
import {normaliseStateKey} from 'foottrace/paths';
import {openWorkflowRecording} from 'footprintjs-ml/lens';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function investigatePromotion(directory){
 const root=resolve(directory),recordPath=resolve(root,'recording.json'),outcomePath=resolve(root,'outcome.json');
 const recordBytes=await readFile(recordPath),outcomeBytes=await readFile(outcomePath);
 const recording=JSON.parse(recordBytes),outcome=JSON.parse(outcomeBytes),snapshot=recording.snapshot,state=snapshot.sharedState;
 assert.equal(recording.schema,'footprint-ml-python-capture/v1');
 assert.deepEqual(outcome,state.outcome);
 const stage=id=>{const matches=snapshot.commitLog.filter(c=>c.stageId===id);assert.equal(matches.length,1,id);return matches[0].runtimeStageId;};
 const session=openWorkflowRecording(recording,{openRecording,traceToolpack,callTraceTool});
 const chains={};
 for(const key of ['staleDecision','wrongPublication','lostReplyPublication','recoveredPublication',
  'uncertainFirstPublication','uncertainRetryPublication','occupiedPublication','approvedMlflowPromotion'])
  chains[key]=(await session.backtrack(key,{maxDepth:24,maxNodes:160})).result;
 const wrongVersion=await session.call('get_value',{runtimeStageId:stage('publish-wrong'),key:normaliseStateKey(['wrongPublisherConfiguration','binding','version'])});
 const mainReceipt=await session.call('get_value',{runtimeStageId:stage('publish-recovered'),key:normaliseStateKey(['recoveredPublication','publisherReceipt','registry','version'])});
 const sourceWriter=await session.call('who_wrote',{key:'wrongPublisherConfiguration',beforeStageId:stage('publish-wrong')});
 const retryNode=await session.call('trace_node',{runtimeStageId:stage('publish-uncertainRetry')});
 const checks={
  capturedOutcomeMatches:true,
  staleDecisionReachesBothCandidateObservations:chains.staleDecision.includes(stage('train-register-candidates')),
  wrongVersionReachesConsumedRegistryBinding:chains.wrongPublication.includes(stage('bind-wrong-publisher'))&&sourceWriter.result.includes(stage('bind-wrong-publisher')),
  wrongVersionReachesIndependentPinnedPlan:chains.wrongPublication.includes(stage('prepare-wrong')),
  wrongVersionReachesCompleteComparison:chains.wrongPublication.includes(stage('pin-selection')),
  wrongVersionDoesNotBorrowLaterFix:!chains.wrongPublication.includes(stage('bind-main-publisher')),
  correctedPromotionReachesItsOwnBinding:chains.approvedMlflowPromotion.includes(stage('bind-main-publisher')),
  correctedPromotionReachesAcknowledgement:chains.approvedMlflowPromotion.includes(stage('publish-recovered')),
  pendingRetryKeepsItsOwnPinnedInputs:chains.uncertainRetryPublication.includes(stage('prepare-uncertain')),
  occupiedAliasReachesItsOwnConfiguration:chains.occupiedPublication.includes(stage('bind-occupied-publisher')),
  actualVersionValuesVisible:wrongVersion.result.includes(outcome.bindings.B.version)&&mainReceipt.result.includes(outcome.bindings.A.version),
  pythonOrderingNotRelabeledNativeRetry:outcome.execution.orchestration==='Python with native foottrace scope capture',
  snapshotOnlyMissingControlPreserved:Object.values(chains).some(text=>text.includes('control edges unavailable')),
  allWorkflowChecksPass:Object.values(outcome.checks).every(Boolean),
  sourceRecordingUnchanged:sha(recordBytes)===sha(await readFile(recordPath)),
  outcomeUnchanged:sha(outcomeBytes)===sha(await readFile(outcomePath)),
 };
 const report={schema:'footprint-ml-mlflow-promotion-investigation/v1',passed:Object.values(checks).every(Boolean),checks,
  source:{recording:{sha256:sha(recordBytes),bytes:recordBytes.length},outcome:{sha256:sha(outcomeBytes),bytes:outcomeBytes.length}},
  nativeQueries:session.transcript.length,transcript:session.transcript,retryNode:retryNode.result,
  execution:{savedJsonOnly:true,trainingStarted:false,mlflowImported:false,registryContacted:false,guardRecomputed:false,publicationPerformed:false},
  boundaries:outcome.boundaries};
 assert(report.passed,Object.entries(checks).filter(([,ok])=>!ok).map(([name])=>name).join(', '));
 await writeFile(resolve(root,'native-investigation.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);assert.equal(args.length,2,'Use --run DIR');assert.equal(args[0],'--run');
 const report=await investigatePromotion(args[1]);console.log(JSON.stringify({passed:report.passed,checks:Object.keys(report.checks).length,nativeQueries:report.nativeQueries}));
}
