import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {flowChart,FlowChartExecutor} from 'footprintjs';
import {createSelectionReceipt,checkSelection,readSelectionManifest} from 'footprintjs-ml';

export const plain=value=>JSON.parse(JSON.stringify(value));
export const sha256=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export const defaultFixtureUrl=new URL('./observations.json',import.meta.url);

export function validateObservations(input){
  if(input?.schema!=='footprint-ml-selection-observations/v1'||input.projection?.schemaVersion!==1)
    throw new Error('Expected projected saved selection observations.');
  if(sha256({manifest:input.manifest,candidateResults:input.candidateResults})!==input.projection.sha256)
    throw new Error('Projected selection observations changed.');
  const manifest=readSelectionManifest(input.manifest);
  if(manifest.policy.direction!=='min')throw new Error('This proof expects the original lower-error policy.');
  const validated=createSelectionReceipt({selectionId:'ingress-validation',createdAt:input.replayAt,
    manifest,results:input.candidateResults});
  if(validated.results.length!==3)throw new Error('This proof retains three observed JAX candidates.');
  return plain(input);
}
export async function readObservations(path=defaultFixtureUrl){return validateObservations(JSON.parse(await readFile(path,'utf8')));}

function rankFromScope(scope,receiptKey,direction){
  // Business inputs cross the tracked scope boundary here. A closure containing
  // the same results would bypass FootPrint's read history.
  const manifest=plain(scope.manifest),results=plain(scope.candidateResults),createdAt=scope.replayAt;
  const runtimeManifest={...manifest,policy:{...manifest.policy,direction}};
  scope[receiptKey]=plain(createSelectionReceipt({selectionId:`replay-${direction}`,createdAt,
    manifest:runtimeManifest,results}));
}
function checkFromScope(scope,receiptKey,decisionKey,attemptKey){
  const receipt=plain(scope[receiptKey]);
  const decision=checkSelection({receipt,manifest:plain(scope.manifest),results:plain(scope.candidateResults),
    modelRef:receipt.selectedModelRef,now:scope.replayAt});
  scope[decisionKey]=plain(decision);
  scope[attemptKey]={receipt:plain(scope[receiptKey]),decision:plain(scope[decisionKey])};
}

export async function runSelectionProof(input,{readTracking='full'}={}){
  const fixture=validateObservations(input);
  // Only these two ingress stages read external retained observations. Every
  // ranking and guard below consumes the references in tracked workflow scope.
  let chart=flowChart('Pin the original experiment declaration',s=>{
    s.manifest=plain(fixture.manifest);s.replayAt=fixture.replayAt;s.sourceEvidence=plain(fixture.source);
  },'declare-manifest');
  chart.addFunction('Retain the three actual candidate evaluations',s=>{
    s.candidateResults=plain(fixture.candidateResults);
  },'retain-candidate-observations');
  chart.addFunction('Record unrelated display telemetry',s=>{s.unrelatedTelemetry={label:'must not enter the selection slice'};},'unrelated-telemetry');
  chart.addFunction('Recompute the mistaken larger-error ranking',s=>rankFromScope(s,'wrongReceipt','max'),'rank-wrong-direction');
  chart.addFunction('Reject that ranking against the pinned lower-error rule',s=>{
    checkFromScope(s,'wrongReceipt','wrongDecision','wrongAttempt');
    if(s.wrongDecision.allowed)throw new Error('Wrong-direction ranking unexpectedly passed.');
  },'guard-wrong-direction');
  chart.addFunction('Recompute selection with the original lower-error rule',s=>rankFromScope(s,'correctReceipt','min'),'rank-correct-direction');
  chart.addFunction('Accept the matching candidate and selection evidence',s=>{
    checkFromScope(s,'correctReceipt','correctDecision','correctAttempt');
    if(!s.correctDecision.allowed)throw new Error('Correct-direction ranking unexpectedly failed.');
  },'guard-correct-direction');
  const executor=new FlowChartExecutor(chart.build());
  executor.setReadTracking(readTracking);executor.setWriteTracking('full');
  await executor.run();
  const snapshot=plain(executor.getSnapshot());
  return {schema:'footprint-ml-selection-backtracking/v1',workflow:{kind:'selection-evidence-replay/v1'},snapshot,
    evidence:{fixtureSchema:fixture.schema,source:fixture.source,projection:fixture.projection,
      operation:'Recompute selection and guards from retained numerical evaluation observations.',
      numericalTrainingRepeated:false,numericalEvaluationRepeated:false,liveBackendUsed:false,readTracking},
    boundaries:['This is a new metadata workflow, not a corrected version of the original saved recording.',
      'Recorded model/session references are historical labels. No live model handles or checkpoint bytes are opened.',
      'Selection and guard calculations run again. Original numerical training and evaluation do not.',
      'A recorded dependency chain identifies consumed scope inputs; it does not prove numerical or statistical causation.']};
}
