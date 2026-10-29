import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openRecording,traceToolpack,callTraceTool} from 'agentfootprint/observe';
import {normaliseStateKey} from 'foottrace/paths';
import {openWorkflowRecording} from 'footprintjs-ml/lens';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function investigateMlflowRun(rootPath,outPath){
  const root=resolve(rootPath),path=resolve(root,'recording.json');
  const before=await readFile(path),recording=JSON.parse(before);
  const outcomeBytes=await readFile(resolve(root,'outcome.json'));
  const outcome=JSON.parse(outcomeBytes);
  assert.equal(recording.producer?.kind,'python-orchestrator/native-foottrace-writer');
  assert.equal(recording.supplemental?.pythonCapture?.lifecycle,'closed');
  assert.deepEqual(outcome,recording.snapshot.sharedState.outcome,
    'The outcome sidecar must match the outcome captured in this recording');
  const stages=recording.supplemental.pythonCapture.stages;
  const execution=(id,test=()=>true)=>{
    const found=stages.filter(stage=>stage.stageId===id&&test(stage));
    assert.equal(found.length,1,`Expected one recorded ${id} execution`);return found[0];
  };
  const retry=execution('select-preprocessor',s=>s.attempt===2);
  const failed=execution('select-preprocessor',s=>s.attempt===1);
  const faulty=execution('evaluate-faulty');
  const corrected=execution('evaluate-corrected');
  const restore=execution('restore-preprocessor');
  const train=execution('train-classifier');
  const baseline=execution('evaluate-baseline');
  const run=openWorkflowRecording(recording,{openRecording,traceToolpack,callTraceTool});
  const chains={};
  for(const variable of ['faultyReceipt','staleDecision','correctedReceipt','approvedModel'])
    chains[variable]=(await run.backtrack(variable,{maxDepth:12,maxNodes:80})).result;
  const faultyWriter=await run.call('who_wrote',{key:'activePreprocessorBinding',beforeStageId:faulty.runtimeStageId});
  const correctedWriter=await run.call('who_wrote',{key:'activePreprocessorBinding',beforeStageId:corrected.runtimeStageId});
  const weightsWriter=await run.call('who_wrote',{key:'modelWeightsBinding'});
  const dataWriter=await run.call('who_wrote',{key:'validationBinding'});
  const faultyScore=await run.call('get_value',{runtimeStageId:faulty.runtimeStageId,
    key:normaliseStateKey(['faultyReceipt','metrics','accuracy'])});
  const failedStage=await run.call('trace_node',{runtimeStageId:failed.runtimeStageId});
  const attention=await run.call('attention_list');
  const attentionResult=JSON.parse(attention.result);
  const checks={
    pythonOwnsOrchestration:outcome.execution.pythonOrchestration===true,
    oneFitThreeEvaluations:outcome.execution.modelTrainingCalls===1&&outcome.execution.evaluationCalls===3,
    retryIsRecorded:failed.status==='discarded'&&retry.status==='committed'&&retry.retryOf===failed.runtimeStageId,
    failedWritesAbsent:!recording.snapshot.commitLog.some(commit=>commit.trace.some(row=>row.path==='uncommittedAttemptMarker')),
    faultyMetricReachesRetry:chains.faultyReceipt.includes(retry.runtimeStageId)&&chains.faultyReceipt.includes(faulty.runtimeStageId),
    faultyMetricReachesModelProducer:chains.faultyReceipt.includes(train.runtimeStageId),
    laterCorrectionExcluded:![restore.runtimeStageId,corrected.runtimeStageId].some(id=>chains.faultyReceipt.includes(id)),
    staleDecisionReachesBothHistories:chains.staleDecision.includes(baseline.runtimeStageId)&&chains.staleDecision.includes(retry.runtimeStageId),
    correctedMetricReachesRestoration:chains.correctedReceipt.includes(restore.runtimeStageId),
    approvedModelReachesCorrectedEvidence:chains.approvedModel.includes(corrected.runtimeStageId),
    exactScalersWriters:faultyWriter.result.includes(retry.runtimeStageId)&&correctedWriter.result.includes(restore.runtimeStageId),
    fixedWeightsAndDataProducers:weightsWriter.result.includes(train.runtimeStageId)&&dataWriter.result.includes(execution('load-digits').runtimeStageId),
    actualMetricReadable:faultyScore.result.includes(String(outcome.faulty.receipt.metrics.accuracy)),
    failedStageRemainsInspectable:failedStage.result.includes(failed.runtimeStageId)&&failedStage.result.includes('Injected temporary'),
    modelWeightsUnchanged:outcome.checks.weightsUnchanged===true,
    validationUnchanged:outcome.checks.rawValidationUnchanged===true,
    preprocessingChangedAndRestored:outcome.checks.scalerChangedOnRetry&&outcome.checks.scalerRestored,
    observedRegression:outcome.faulty.receipt.metrics.accuracy<outcome.baseline.receipt.metrics.accuracy,
    controlledRecovery:outcome.corrected.receipt.metrics.accuracy===outcome.baseline.receipt.metrics.accuracy,
    nativeGuards:outcome.baseline.decision.allowed&&!outcome.staleDecision.allowed&&!outcome.faulty.decision.allowed&&outcome.corrected.decision.allowed,
    mlflowBindingConsistent:outcome.mlflowModelVersion.runId===outcome.mlflowRun.runId&&['baseline','faulty','corrected'].every(
      kind=>Object.values(outcome[kind].consumption).filter(value=>value?.kind==='mlflow-artifact')
        .every(ref=>ref.runId===outcome.mlflowRun.runId&&ref.experimentId===outcome.mlflowRun.experimentId)),
    missingControlDisclosed:Object.values(chains).every(text=>text.includes('control edges unavailable')),
    noCertifiedRootFromUnattestedRecord:attentionResult.confidence==='incomplete',
    originalRecordingUnchanged:sha(before)===sha(await readFile(path)),
  };
  const report={schema:'footprint-ml-mlflow-investigation/v1',passed:Object.values(checks).every(Boolean),checks,
    source:{file:'recording.json',sha256:sha(before),bytes:before.length},
    outcomeSource:{file:'outcome.json',sha256:sha(outcomeBytes),bytes:outcomeBytes.length,capturedOutcomeMatches:true},
    nativeQueries:run.transcript.length,
    transcript:run.transcript,
    retryEvidence:{pointer:`/supplemental/pythonCapture/stages/${stages.indexOf(retry)}`,observation:retry,
      interpretation:'The Python caller supplied these attempt labels; this is not a native FootPrint retry-policy attestation.'},
    mlflow:{runId:outcome.mlflowRun.runId,experimentId:outcome.mlflowRun.experimentId,modelVersion:outcome.mlflowModelVersion},
    execution:{savedJsonOnly:true,pythonStarted:false,mlflowClientStarted:false,trainingRepeated:false,evaluationRepeated:false},
    boundaries:recording.boundaries};
  if(outPath)await writeFile(resolve(outPath),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  assert(report.passed,`MLflow investigation checks failed: ${Object.entries(checks).filter(([,ok])=>!ok).map(([name])=>name).join(', ')}`);
  return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=='--run')throw new Error('Use investigate.mjs --run DIRECTORY.');
  const report=await investigateMlflowRun(args[1],resolve(args[1],'investigation.json'));
  console.log(JSON.stringify({passed:report.passed,checks:Object.keys(report.checks).length,nativeQueries:report.nativeQueries}));
}
