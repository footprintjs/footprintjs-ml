import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {openRecording,traceToolpack,callTraceTool} from 'agentfootprint/observe';
import {normaliseStateKey} from 'foottrace/paths';
import {openWorkflowRecording} from 'footprintjs-ml/lens';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function investigatePythonGuards(directory,output){
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
  const keys=['wrongSelectionDecision','reversedSelectionDecision','selectionDecision','cleanLineageDecision',
    'faultyLineageDecision','missingLineageDecision','missingOverlapLineageDecision'];
  const chains={};
  for(const key of keys)chains[key]=(await run.backtrack(key,{maxDepth:18,maxNodes:100})).result;
  const wrong=stage('check-wrong-selection'),winner=stage('check-correct-selection');
  const candidateProducer=stage('retain-candidate-observations'),plans=stage('declare-guard-plans');
  const faulty=stage('check-faulty-lineage'),faultyAudit=stage('audit-faulty-memberships');
  const clean=stage('check-clean-lineage'),cleanAudit=stage('audit-clean-memberships');
  const candidates=await run.call('who_wrote',{key:'candidateResults',beforeStageId:wrong});
  const manifest=await run.call('who_wrote',{key:'selectionManifest',beforeStageId:wrong});
  const auditWriter=await run.call('who_wrote',{key:'faultyMembershipAudit',beforeStageId:faulty});
  const faultyRows=await run.call('get_value',{runtimeStageId:faulty,key:normaliseStateKey(['faultyMembershipAudit','preprocessingEvaluationRows'])});
  const cleanRows=await run.call('get_value',{runtimeStageId:clean,key:normaliseStateKey(['cleanMembershipAudit','preprocessingEvaluationRows'])});
  const chosen=await run.call('get_value',{runtimeStageId:winner,key:normaliseStateKey(['correctSelectionReceipt','selectedCandidateId'])});
  const quality=await run.call('get_value',{runtimeStageId:wrong,key:normaliseStateKey(['wrongQualityDecision','allowed'])});
  await run.call('trace_node',{runtimeStageId:faultyAudit});
  const attention=await run.call('attention_list');
  const attentionResult=JSON.parse(attention.result);
  const checks={
    capturedOutcomeMatchesSidecar:true,
    wrongQualityPasses:state.wrongQualityDecision.allowed===true&&quality.result.includes('true'),
    wrongCandidateDenied:state.wrongSelectionDecision.allowed===false,
    reversedPolicyDenied:state.reversedSelectionDecision.allowed===false,
    correctWinnerAllowed:state.selectionDecision.allowed===true&&chosen.result.includes('steps-100'),
    wrongDecisionReachesProposal:chains.wrongSelectionDecision.includes(stage('offer-wrong-selection')),
    wrongDecisionReachesObservations:chains.wrongSelectionDecision.includes(candidateProducer),
    wrongDecisionReachesIndependentPlan:chains.wrongSelectionDecision.includes(plans),
    laterCorrectionExcluded:!chains.wrongSelectionDecision.includes(winner)&&!chains.wrongSelectionDecision.includes(stage('offer-correct-selection')),
    unrelatedNoteExcluded:!Object.values(chains).some(chain=>chain.includes(stage('unrelated-note'))),
    correctDecisionReachesItsProposal:chains.selectionDecision.includes(stage('offer-correct-selection')),
    candidateAndPlanWritersFound:candidates.result.includes(candidateProducer)&&manifest.result.includes(plans),
    cleanQualityAndLineagePass:state.cleanMetricDecision.allowed===true&&state.cleanLineageDecision.allowed===true,
    faultyQualityPassesButLineageDenies:state.faultyMetricDecision.allowed===true&&state.faultyLineageDecision.allowed===false,
    faultyDecisionReachesActualMembershipAudit:chains.faultyLineageDecision.includes(faultyAudit)&&auditWriter.result.includes(faultyAudit),
    faultyDecisionReachesRetainedObservation:chains.faultyLineageDecision.includes(stage('retain-faulty-lineage')),
    cleanDecisionReachesActualMembershipAudit:chains.cleanLineageDecision.includes(cleanAudit),
    measuredOverlapVisible:faultyRows.result.includes('288')&&cleanRows.result.includes('0'),
    missingReceiptRemainsUnknown:state.missingLineageDecision.status==='unknown'&&!state.missingLineageDecision.allowed,
    missingOverlapRemainsUnknown:state.missingOverlapLineageDecision.status==='unknown'&&!state.missingOverlapLineageDecision.allowed,
    separateModelsNotCrossValidated:!chains.wrongSelectionDecision.includes(faultyAudit)&&!chains.faultyLineageDecision.includes(candidateProducer),
    nativeMissingControlWarningPreserved:Object.values(chains).every(chain=>chain.includes('control edges unavailable')),
    captureLimitRemainsVisible:attentionResult.confidence==='incomplete',
    recordingUnchanged:sha(before)===sha(await readFile(recordPath)),
    outcomeUnchanged:sha(outcomeBytes)===sha(await readFile(outcomePath)),
  };
  const report={schema:'footprint-ml-python-guards-investigation/v1',passed:Object.values(checks).every(Boolean),checks,
    sources:{recording:{sha256:sha(before),bytes:before.length},outcome:{sha256:sha(outcomeBytes),bytes:outcomeBytes.length,capturedOutcomeMatches:true}},
    nativeQueries:run.transcript.length,transcript:run.transcript,
    execution:{savedJsonOnly:true,trainingStarted:false,numericalEvaluationRepeated:false,guardRecomputed:false,publicationPerformed:false},
    boundaries:recording.boundaries};
  assert(report.passed,`Saved investigation failed: ${Object.entries(checks).filter(([,ok])=>!ok).map(([name])=>name).join(', ')}`);
  if(output)await writeFile(resolve(output),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);assert.equal(args.length,2,'Use investigate.mjs --run DIRECTORY.');assert.equal(args[0],'--run');
  const report=await investigatePythonGuards(args[1],resolve(args[1],'investigation.json'));
  console.log(JSON.stringify({passed:report.passed,checks:Object.keys(report.checks).length,nativeQueries:report.nativeQueries},null,2));
}
