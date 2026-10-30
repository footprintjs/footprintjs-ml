import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {openRecording,traceToolpack,callTraceTool} from 'agentfootprint/observe';
import {normaliseStateKey} from 'foottrace/paths';
import {openWorkflowRecording} from 'footprintjs-ml/lens';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function investigateMonitoring(directory){
 const root=resolve(directory),recordPath=resolve(root,'recording.json'),outcomePath=resolve(root,'outcome.json');
 const before=await readFile(recordPath),outcomeBytes=await readFile(outcomePath);
 const recording=JSON.parse(before),outcome=JSON.parse(outcomeBytes),snapshot=recording.snapshot,state=snapshot.sharedState;
 assert.equal(recording.schema,'footprint-ml-python-capture/v1');assert.deepEqual(state.outcome,outcome);
 const stage=id=>{const hits=snapshot.commitLog.filter(row=>row.stageId===id);assert.equal(hits.length,1,id);return hits[0].runtimeStageId;};
 const session=openWorkflowRecording(recording,{openRecording,traceToolpack,callTraceTool});
 const chains={};
 for(const key of ['degradedDecision','healthyDecision','missingLabelsDecision','insufficientLabelsDecision','reorderedLabelsDecision',
  'duplicateLabelsDecision','crossWindowLabelsDecision','borrowedReportDecision','loadedArtifactObservation'])
  chains[key]=(await session.backtrack(key,{maxDepth:24,maxNodes:180})).result;
 const get=(id,key)=>session.call('get_value',{runtimeStageId:stage(id),key:normaliseStateKey(key)});
 const metric=await get('monitor-degraded',['degradedObservation','evaluation','metrics','mse']);
 const coverage=await get('monitor-insufficientLabels',['insufficientLabelsDecision','coverage']);
 const review=await get('monitor-degraded',['degradedDecision','recommendation']);
 const duplicate=await get('monitor-duplicateLabels',['duplicateLabelsObservation','join','duplicateRows']);
 const cross=await get('monitor-crossWindowLabels',['crossWindowLabelsObservation','join','crossWindowRows']);
 const borrowed=await get('monitor-borrowedReport',['healthyReceipt','manifest','window','windowId']);
 const expected=await get('monitor-borrowedReport',['W2Manifest','window','windowId']);
 const labelsWriter=await session.call('who_wrote',{key:'labelBatchRefs',beforeStageId:stage('monitor-degraded')});
 const predictionWriter=await session.call('who_wrote',{key:'W2PredictionRef',beforeStageId:stage('monitor-degraded')});
 const node=await session.call('trace_node',{runtimeStageId:stage('monitor-degraded')});
 const checks={
  capturedOutcomeMatches:true,
  poorWindowReachesExecutedPrediction:chains.degradedDecision.includes(stage('predict-W2'))&&predictionWriter.result.includes(stage('predict-W2')),
  poorWindowReachesActualLabelArrival:chains.degradedDecision.includes(stage('receive-label-batches'))&&labelsWriter.result.includes(stage('receive-label-batches')),
  poorWindowReachesPredeclaredPolicy:chains.degradedDecision.includes(stage('declare-before-training')),
  monitoringReachesActualPublishedModelLoad:chains.degradedDecision.includes(stage('read-target-and-load-published-bytes')),
  expectedModelRequirementReachesCheckedPublication:chains.degradedDecision.includes(stage('publish-exact-approved-model')),
  externalTargetReadHasNoInventedProducerEdge:!chains.loadedArtifactObservation.includes(stage('publish-exact-approved-model')),
  unavailableLabelsDoNotBorrowLaterArrival:!chains.missingLabelsDecision.includes(stage('receive-label-batches')),
  incompleteLabelsPreserveUnknown:state.insufficientLabelsDecision.status==='unknown'&&state.insufficientLabelsDecision.health===null,
  healthWaitsForMeasuredLabels:state.missingLabelsDecision.health===null&&state.degradedDecision.health==='degraded',
  actualThresholdViolationVisible:metric.result.includes('9'),
  reviewRecommendationVisible:review.result.includes('review'),
  actualPartialCoverageVisible:coverage.result.includes('3')&&coverage.result.includes('12'),
  keyedReorderingIsAccepted:state.reorderedLabelsDecision.allowed&&state.reorderedLabelsDecision.health==='healthy',
  actualDuplicateAndForeignBoundsVisible:duplicate.result.includes('1')&&cross.result.includes('12'),
  borrowedReceiptTracesEarlierWindow:chains.borrowedReportDecision.includes(stage('monitor-healthy'))&&borrowed.result.includes('W1')&&expected.result.includes('W2'),
  snapshotMissingControlWarningsPreserved:Object.values(chains).some(text=>text.includes('control edges unavailable')),
  noServingPauseWasInvented:outcome.execution.servingPausePerformed===false&&outcome.execution.hostedServing===false,
  allWorkflowControlsPass:Object.keys(outcome.checks).length===14&&Object.values(outcome.checks).every(Boolean),
  recordingUnchanged:sha(before)===sha(await readFile(recordPath)),
  outcomeUnchanged:sha(outcomeBytes)===sha(await readFile(outcomePath)),
 };
 assert(Object.values(checks).every(Boolean),Object.entries(checks).filter(([,ok])=>!ok).map(([name])=>name).join(', '));
 const report={schema:'footprint-ml-monitoring-investigation/v1',passed:true,checks,nativeQueries:session.transcript.length,
  sources:{recording:{sha256:sha(before),bytes:before.length},outcome:{sha256:sha(outcomeBytes),bytes:outcomeBytes.length}},
  transcript:session.transcript,monitoringNode:node.result,
  externalReadBoundary:{automaticallyLinkedToPublisherStage:false,
   explanation:'The receiver read returned an actual target receipt and checked bytes. Native scope backtracking does not infer the external file producer; the independently consumed expected publication and the saved artifact audit supply separate evidence.'},
  execution:{savedJsonOnly:true,numpyImported:false,trainingStarted:false,predictionRepeated:false,labelJoinRepeated:false,guardRecomputed:false,publicationPerformed:false,servingPaused:false},
  boundaries:outcome.boundaries};
 await writeFile(resolve(root,'native-investigation.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);assert.equal(args.length,2,'Use --run DIR');assert.equal(args[0],'--run');
 const report=await investigateMonitoring(args[1]);console.log(JSON.stringify({passed:report.passed,checks:Object.keys(report.checks).length,nativeQueries:report.nativeQueries}));
}
