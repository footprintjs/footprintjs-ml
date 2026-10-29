import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {openRecording,traceToolpack,callTraceTool} from 'agentfootprint/observe';
import {normaliseStateKey} from 'foottrace/paths';
import {openWorkflowRecording} from 'footprintjs-ml/lens';
import {recordedControlBridge} from './native-control.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const nativeBridge={openRecording,traceToolpack,callTraceTool};
export async function investigateNativeInference(directory,output){
  const root=resolve(directory),recordPath=resolve(root,'recording.json'),outcomePath=resolve(root,'outcome.json');
  const before=await readFile(recordPath),outcomeBytes=await readFile(outcomePath);
  const recording=JSON.parse(before),outcome=JSON.parse(outcomeBytes),snapshot=recording.snapshot,state=snapshot.sharedState;
  assert.equal(recording.schema,'native-inference-recording/v1');
  assert.equal(recording.workflow.orchestration,'footprintjs-flowchart');
  assert.deepEqual(outcome,state.outcome,'Outcome sidecar must equal its captured scope value');
  const stage=id=>{
    const matches=snapshot.commitLog.filter(item=>item.stageId===id);
    assert.equal(matches.length,1,`Expected one committed ${id} execution`);return matches[0].runtimeStageId;
  };
  const run=openWorkflowRecording(recording,recordedControlBridge(recording,nativeBridge));
  const baseline=openWorkflowRecording(recording,nativeBridge);
  const chains={};
  for(const key of ['wrongInferenceDecision','correctedInferenceDecision','reversedInferenceDecision',
    'missingInferenceDecision','releasedPredictionRef','repairChoice']){
    chains[key]=(await run.backtrack(key,{maxDepth:24,maxNodes:160})).result;
  }
  const baselineHandoff=(await baseline.backtrack('releasedPredictionRef',{maxDepth:24,maxNodes:160})).result;
  const baselineRepair=(await baseline.backtrack('repairChoice',{maxDepth:24,maxNodes:160})).result;
  const wrong=stage('guard-stale'),prediction=stage('predict-stale'),repair=stage('repair-cache');
  const corrected=stage('guard-corrected'),retryStage=stage('predict-corrected');
  const receiptWriter=await run.call('who_wrote',{key:'staleReceipt',beforeStageId:wrong});
  const cacheWriter=await run.call('who_wrote',{key:'cacheObservation',beforeStageId:prediction});
  const approvedWriter=await run.call('who_wrote',{key:'approvedModelRef',beforeStageId:wrong});
  const actual=await run.call('get_value',{runtimeStageId:wrong,key:normaliseStateKey(['staleReceipt','modelRef','inferenceIdentity','sha256'])});
  const expected=await run.call('get_value',{runtimeStageId:wrong,key:normaliseStateKey(['approvedModelRef','inferenceIdentity','sha256'])});
  const repairNode=await run.call('trace_node',{runtimeStageId:repair});
  const handoffNode=await run.call('trace_node',{runtimeStageId:stage('permit-output')});
  const retryNode=await run.call('trace_node',{runtimeStageId:retryStage});
  const attention=await run.call('attention_list');
  const attentionResult=JSON.parse(attention.result);
  const events=recording.supplemental.flowEvents,decisions=recording.supplemental.nativeDecisions;
  const retries=events.filter(event=>event.type==='onStageRetry');
  const executions=events.filter(event=>event.type==='onStageExecuted');
  const branchFor=id=>decisions.find(item=>item.deciderRuntimeStageId===stage(id));
  const identity=ref=>ref.inferenceIdentity.sha256;
  const checks={
    capturedOutcomeMatchesSidecar:true,
    nativeExecutorOwnsOrchestration:outcome.execution.orchestration==='footprintjs-flowchart'&&outcome.execution.pythonOrchestration===false,
    allNineteenWorkflowChecksPass:Object.keys(outcome.checks).length===19&&Object.values(outcome.checks).every(Boolean),
    approvedAIsSeparateFromActualB:identity(state.approvedModelRef)!==identity(state.staleReceipt.modelRef)&&identity(state.staleReceipt.modelRef)===identity(state.modelBRef),
    staleOutputDenied:state.wrongInferenceDecision.status==='deny'&&!state.staleOutputExposed,
    correctedOutputAllowed:state.correctedInferenceDecision.status==='allow',
    reversedFieldsDenied:state.reversedInferenceDecision.status==='deny',
    missingActualModelUnknown:state.missingInferenceDecision.status==='unknown'&&!state.missingInferenceDecision.allowed,
    exactCorrectedOutputHandedOff:JSON.stringify(state.releasedPredictionRef)===JSON.stringify(state.correctedReceipt.outputRef),
    actualRepairDecisionRecorded:branchFor('route-stale')?.evidence?.chosen==='repair-cache',
    actualHandoffDecisionRecorded:branchFor('route-corrected')?.evidence?.chosen==='permit-output',
    unselectedBranchesNeverCommitted:!snapshot.commitLog.some(commit=>['unexpected-stale-handoff','refuse-corrected-output'].includes(commit.stageId)),
    oneNativeRetryForCorrectedPrediction:retries.length===1&&retries[0].traversalContext?.runtimeStageId===retryStage&&retries[0].attempt===1&&retries[0].maxAttempts===2&&retries[0].delayMs===0,
    pendingScopeWriteDiscardedBeforeRetry:retries[0]?.retryScratchAfterDiscard===null&&state.retryScratch.status==='success'&&state.retryScratch.initialPendingValueAbsent===true,
    oneSuccessfulRetryCommit:snapshot.commitLog.filter(commit=>commit.stageId==='predict-corrected').length===1&&executions.filter(event=>event.traversalContext?.runtimeStageId===retryStage).length===1,
    failedAttemptPrecedesNumericalEffect:outcome.checks.transientFaultBeforeComputation&&outcome.checks.transientFaultCreatedNoNumericalArtifact,
    sameInvocationUsedForBothAttempts:state.correctedRetryObservation.attempts===2&&state.correctedRetryObservation.inferenceId===state.correctedInferenceId,
    sameWorkerRemainsAcrossRepair:outcome.checks.sameWorkerAcrossRepair&&state.correctedRetryObservation.workerPid===outcome.backend.workerPid,
    staleDecisionReachesActualPrediction:chains.wrongInferenceDecision.includes(prediction)&&receiptWriter.result.includes(prediction),
    staleDecisionReachesActualBCache:chains.wrongInferenceDecision.includes(stage('load-wrong-cache'))&&cacheWriter.result.includes(stage('load-wrong-cache')),
    staleDecisionReachesIndependentAApproval:chains.wrongInferenceDecision.includes(stage('approve-model-A'))&&approvedWriter.result.includes(stage('approve-model-A')),
    approvalReachesFreshEvaluation:chains.wrongInferenceDecision.includes(stage('evaluate-approved-A')),
    laterRepairExcludedFromEarlierFailure:!chains.wrongInferenceDecision.includes(repair)&&!chains.wrongInferenceDecision.includes(corrected),
    correctionReachesRepairedCache:chains.correctedInferenceDecision.includes(repair)&&chains.correctedInferenceDecision.includes(retryStage),
    nativeControlExplainsRepair:chains.repairChoice.includes(stage('route-stale'))&&!baselineRepair.includes(stage('route-stale'))&&repairNode.result.includes(`control: routed here by ${stage('route-stale')}`),
    nativeControlExplainsHandoff:chains.releasedPredictionRef.includes(stage('route-corrected'))&&!baselineHandoff.includes(stage('route-corrected'))&&handoffNode.result.includes(`control: routed here by ${stage('route-corrected')}`),
    snapshotOnlyBaselinePreservesMissingControl:[baselineHandoff,baselineRepair].every(text=>text.includes('control edges unavailable')),
    restoredLookupDoesNotClaimMissingControl:Object.values(chains).every(text=>!text.includes('control edges unavailable')),
    measuredActualAndExpectedIdentitiesVisible:actual.result.includes(identity(state.staleReceipt.modelRef))&&expected.result.includes(identity(state.approvedModelRef)),
    noEngineCaptureAttestationInvented:snapshot.recorders===undefined,
    snapshotCompletenessLimitRemainsVisible:attentionResult.confidence==='incomplete',
    recordingUnchanged:sha(before)===sha(await readFile(recordPath)),
    outcomeUnchanged:sha(outcomeBytes)===sha(await readFile(outcomePath)),
  };
  const report={schema:'footprint-ml-native-inference-investigation/v1',passed:Object.values(checks).every(Boolean),checks,
    sources:{recording:{sha256:sha(before),bytes:before.length},outcome:{sha256:sha(outcomeBytes),bytes:outcomeBytes.length,capturedOutcomeMatches:true}},
    nativeQueries:run.transcript.length+baseline.transcript.length,
    transcript:run.transcript,snapshotOnlyBaseline:baseline.transcript,
    nativeExecutionObservations:{decisions,retries,retryStage:{runtimeStageId:retryStage,nativeNodeResult:retryNode.result},
      sourcePointers:['/supplemental/flowEvents','/supplemental/nativeDecisions','/supplemental/nativeControl']},
    controlLookup:{restored:true,profile:recording.supplemental.nativeControl.schema,
      capturedDependencies:Object.keys(recording.supplemental.nativeControl.dependencies).length,
      source:'Saved outputs of the public controlDepRecorder lookup during this actual run; no edges inferred from chart order.'},
    execution:{savedJsonOnly:true,trainingStarted:false,predictionRepeated:false,numericalEvaluationRepeated:false,guardRecomputed:false,publicationPerformed:false},
    boundaries:outcome.boundaries};
  assert(report.passed,`Saved native investigation failed: ${Object.entries(checks).filter(([,ok])=>!ok).map(([name])=>name).join(', ')}`);
  if(output)await writeFile(resolve(output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);assert.equal(args.length,2,'Use native-investigate.mjs --run DIRECTORY.');assert.equal(args[0],'--run');
  const report=await investigateNativeInference(args[1],resolve(args[1],'native-investigation.json'));
  console.log(JSON.stringify({passed:report.passed,checks:Object.keys(report.checks).length,nativeQueries:report.nativeQueries},null,2));
}
