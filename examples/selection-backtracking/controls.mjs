import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {flowChart,FlowChartExecutor} from 'footprintjs';
import {createSelectionReceipt,checkSelection} from 'footprintjs-ml';
import {plain,readObservations,runSelectionProof,validateObservations} from './proof.mjs';
import {investigateSelection} from './investigate.mjs';

/** Intentionally incorrect capture pattern, retained only as a negative control. */
export async function runClosureControl(input){
  const fixture=validateObservations(input);
  let chart=flowChart('Pin declaration for the closure control',s=>{s.manifest=plain(fixture.manifest);},'declare-manifest');
  chart.addFunction('Retain observations for the closure control',s=>{s.candidateResults=plain(fixture.candidateResults);},'retain-candidate-observations');
  chart.addFunction('Unrelated telemetry',s=>{s.unrelatedTelemetry=true;},'unrelated-telemetry');
  chart.addFunction('Intentionally bypass tracked ranking inputs',s=>{
    // These closure reads reproduce the old evidence gap. They are not a
    // supported example pattern: the fixed proof reads the same inputs in scope.
    s.wrongReceipt=plain(createSelectionReceipt({selectionId:'closure-negative-control',createdAt:fixture.replayAt,
      manifest:{...fixture.manifest,policy:{...fixture.manifest.policy,direction:'max'}},results:fixture.candidateResults}));
  },'closure-ranking');
  chart.addFunction('Intentionally bypass tracked guard inputs',s=>{
    const receipt=plain(s.wrongReceipt);
    s.wrongDecision=plain(checkSelection({receipt,manifest:fixture.manifest,results:fixture.candidateResults,
      modelRef:receipt.selectedModelRef,now:fixture.replayAt}));
    s.wrongAttempt={receipt:plain(s.wrongReceipt),decision:plain(s.wrongDecision)};
  },'closure-guard');
  const executor=new FlowChartExecutor(chart.build());executor.setReadTracking('full');executor.setWriteTracking('full');
  await executor.run();
  return {schema:'footprint-ml-selection-backtracking/v1',workflow:{kind:'intentional-closure-control/v1'},snapshot:plain(executor.getSnapshot()),
    evidence:{source:fixture.source,numericalTrainingRepeated:false,numericalEvaluationRepeated:false,liveBackendUsed:false},
    boundaries:['Intentional negative control: business input reads bypass scope. Missing dependencies must stay missing.',
      'This is a new selection-only workflow over saved observations; no original numerical operation is repeated.']};
}

export async function saveControls(outPath){
  const root=resolve(outPath),fixture=await readObservations();
  const closure=await runClosureControl(fixture),missingReads=await runSelectionProof(fixture,{readTracking:'off'});
  const closureReport=await investigateSelection(closure,{variables:['wrongAttempt']});
  const missingReport=await investigateSelection(missingReads);
  const summary={schema:'footprint-ml-selection-negative-controls/v1',nativeQueries:3,
    closure:{guardDenied:closure.snapshot.sharedState.wrongDecision.allowed===false,
      producerMissingFromNativeChain:!/retain-candidate-observations#1/.test(closureReport.transcript[0].result)},
    missingReads:{nativeWarningPreserved:missingReport.transcript.every(row=>/no per-step read tracking/.test(row.result)),
      producerMissingFromNativeChains:missingReport.transcript.every(row=>!/retain-candidate-observations#1/.test(row.result))},
    numericalTrainingRepeated:false,numericalEvaluationRepeated:false};
  for(const [name,value]of Object.entries({'closure-control-recording.json':closure,'closure-control-investigation.json':closureReport,
    'missing-reads-recording.json':missingReads,'missing-reads-investigation.json':missingReport,'controls.json':summary}))
    await writeFile(resolve(root,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  return summary;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [out]=process.argv.slice(2);if(!out)throw new Error('Use controls.mjs EXISTING_NEW_OUTPUT_DIRECTORY.');
  console.log(JSON.stringify(await saveControls(out),null,2));
}
