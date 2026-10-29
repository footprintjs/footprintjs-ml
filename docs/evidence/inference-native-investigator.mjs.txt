import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {openRecording,traceToolpack,callTraceTool} from 'agentfootprint/observe';
import {normaliseStateKey} from 'foottrace/paths';
import {openWorkflowRecording} from 'footprintjs-ml/lens';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function investigateInference(directory,output){
  const root=resolve(directory),recordPath=resolve(root,'recording.json'),outcomePath=resolve(root,'outcome.json');
  const before=await readFile(recordPath),outcomeBytes=await readFile(outcomePath);
  const recording=JSON.parse(before),outcome=JSON.parse(outcomeBytes),state=recording.snapshot.sharedState;
  assert.equal(recording.producer.kind,'python-orchestrator/native-foottrace-writer');
  assert.equal(recording.supplemental.pythonCapture.lifecycle,'closed');
  assert.deepEqual(outcome,state.outcome,'Outcome sidecar must equal its captured scope value');
  const stages=recording.supplemental.pythonCapture.stages;
  const stage=id=>{
    const matches=stages.filter(item=>item.stageId===id);
    assert.equal(matches.length,1,`Expected one ${id} execution`);return matches[0].runtimeStageId;
  };
  const run=openWorkflowRecording(recording,{openRecording,traceToolpack,callTraceTool});
  const chains={};
  for(const key of ['staleDecision','correctedDecision','reversedDecision','missingDecision','releasedPredictionRef']){
    chains[key]=(await run.backtrack(key,{maxDepth:18,maxNodes:100})).result;
  }
  const stale=stage('guard-stale-output'),prediction=stage('predict-from-stale-cache');
  const repair=stage('repair-cache-with-A'),corrected=stage('guard-corrected-output');
  const staleReceiptWriter=await run.call('who_wrote',{key:'staleReceipt',beforeStageId:stale});
  const actualCacheWriter=await run.call('who_wrote',{key:'cacheObservation',beforeStageId:prediction});
  const approvedWriter=await run.call('who_wrote',{key:'approvedModelRef',beforeStageId:stale});
  const actual=await run.call('get_value',{runtimeStageId:stale,key:normaliseStateKey(['staleReceipt','modelRef','inferenceIdentity','sha256'])});
  const expected=await run.call('get_value',{runtimeStageId:stale,key:normaliseStateKey(['approvedModelRef','inferenceIdentity','sha256'])});
  const ordered=await run.call('get_value',{runtimeStageId:stage('guard-reversed-fields'),key:normaliseStateKey(['reversedReceipt','contract','input','fields','0','name'])});
  const loaded=await run.call('trace_node',{runtimeStageId:stage('load-wrong-cache')});
  const attention=await run.call('attention_list');
  const attentionResult=JSON.parse(attention.result);
  const identity=ref=>ref.inferenceIdentity.sha256;
  const staleDigest=identity(state.staleReceipt.modelRef),expectedDigest=identity(state.approvedModelRef);
  const checks={
    capturedOutcomeMatchesSidecar:true,
    approvedAIsSeparateFromActualB:expectedDigest!==staleDigest&&staleDigest===identity(state.modelBRef),
    staleOutputDenied:state.staleDecision.status==='deny'&&!state.staleOutputExposed,
    correctedOutputAllowed:state.correctedDecision.status==='allow',
    reversedOrderDenied:state.reversedDecision.status==='deny'&&state.reversedDecision.reasons.some(r=>r.code==='prediction-input-fields-mismatch'),
    sameAUnderWrongFieldOrder:identity(state.reversedReceipt.modelRef)===expectedDigest,
    missingActualModelUnknown:state.missingDecision.status==='unknown'&&!state.missingDecision.allowed,
    permittedHandoffIsOnlyCorrectedOutput:JSON.stringify(state.releasedPredictionRef)===JSON.stringify(state.correctedReceipt.outputRef),
    staleDecisionReachesActualPrediction:chains.staleDecision.includes(prediction)&&staleReceiptWriter.result.includes(prediction),
    staleDecisionReachesCacheLoad:chains.staleDecision.includes(stage('load-wrong-cache'))&&actualCacheWriter.result.includes(stage('load-wrong-cache')),
    staleDecisionReachesIndependentApproval:chains.staleDecision.includes(stage('approve-A'))&&approvedWriter.result.includes(stage('approve-A')),
    approvalReachesFreshEvaluation:chains.staleDecision.includes(stage('evaluate-A')),
    laterRepairExcludedFromStaleSlice:!chains.staleDecision.includes(repair)&&!chains.staleDecision.includes(corrected),
    correctedDecisionReachesRepair:chains.correctedDecision.includes(repair)&&chains.correctedDecision.includes(stage('predict-after-repair')),
    reversedDecisionReachesObservedInput:chains.reversedDecision.includes(stage('predict-with-reversed-fields'))&&ordered.result.includes('pixel_63'),
    missingControlReachesOriginalObservation:chains.missingDecision.includes(stage('check-missing-observation'))&&chains.missingDecision.includes(stage('predict-after-repair')),
    handoffReachesCorrectedDecision:chains.releasedPredictionRef.includes(corrected),
    measuredIdentitiesVisible:actual.result.includes(staleDigest)&&expected.result.includes(expectedDigest),
    nativeWriterAndCacheEvidenceVisible:loaded.result.includes('cacheObservation'),
    sameWorkerAcrossRepair:outcome.checks.sameWorkerAcrossRepair&&outcome.checks.stateMeasuredBeforeAndAfter,
    nativeMissingControlWarningPreserved:Object.values(chains).every(chain=>chain.includes('control edges unavailable')),
    captureLimitRemainsVisible:attentionResult.confidence==='incomplete',
    recordingUnchanged:sha(before)===sha(await readFile(recordPath)),
    outcomeUnchanged:sha(outcomeBytes)===sha(await readFile(outcomePath)),
  };
  const report={schema:'footprint-ml-inference-investigation/v1',passed:Object.values(checks).every(Boolean),checks,
    sources:{recording:{sha256:sha(before),bytes:before.length},outcome:{sha256:sha(outcomeBytes),bytes:outcomeBytes.length,capturedOutcomeMatches:true}},
    nativeQueries:run.transcript.length,transcript:run.transcript,
    execution:{savedJsonOnly:true,trainingStarted:false,predictionRepeated:false,numericalEvaluationRepeated:false,guardRecomputed:false,publicationPerformed:false},
    boundaries:recording.boundaries};
  assert(report.passed,`Saved investigation failed: ${Object.entries(checks).filter(([,ok])=>!ok).map(([name])=>name).join(', ')}`);
  if(output)await writeFile(resolve(output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);assert.equal(args.length,2,'Use investigate.mjs --run DIRECTORY.');assert.equal(args[0],'--run');
  const report=await investigateInference(args[1],resolve(args[1],'investigation.json'));
  console.log(JSON.stringify({passed:report.passed,checks:Object.keys(report.checks).length,nativeQueries:report.nativeQueries},null,2));
}
