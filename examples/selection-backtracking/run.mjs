import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readObservations,runSelectionProof,sha256} from './proof.mjs';
import {investigateSelection} from './investigate.mjs';

export async function runProof(outPath){
  const root=resolve(outPath);await mkdir(root,{recursive:false});
  const recording=await runSelectionProof(await readObservations());
  const report=await investigateSelection(recording);
  const wrongReceipt=recording.snapshot.sharedState.wrongReceipt,correctedReceipt=recording.snapshot.sharedState.correctReceipt;
  const summary={schema:'footprint-ml-selection-backtracking-outcome/v1',
    wrong:{candidateId:wrongReceipt.selectedCandidateId,allowed:recording.snapshot.sharedState.wrongDecision.allowed,
      receiptSha256:sha256(wrongReceipt)},
    corrected:{candidateId:correctedReceipt.selectedCandidateId,allowed:recording.snapshot.sharedState.correctDecision.allowed,
      receiptSha256:sha256(correctedReceipt)},
    candidates:recording.snapshot.sharedState.candidateResults.map(r=>({candidateId:r.candidateId,mse:r.evaluation.metrics.mse})),
    commits:recording.snapshot.commitLog.length,nativeQueries:report.transcript.length,
    nativeEvidenceChecks:report.transcript.map(row=>({variable:row.args.variable,
      candidateProducerReached:/retain-candidate-observations#1/.test(row.result),
      candidateReadEdgePresent:/← via candidateResults/.test(row.result),
      manifestReadEdgePresent:/← via manifest/.test(row.result),
      unrelatedStageExcluded:!/unrelated-telemetry/.test(row.result)})),
    evidence:recording.evidence,boundaries:recording.boundaries};
  for(const [name,value]of Object.entries({'recording.json':recording,'investigation.json':report,'outcome.json':summary,
    'wrong-selection-receipt.json':wrongReceipt,'corrected-selection-receipt.json':correctedReceipt}))
    await writeFile(resolve(root,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(summary,null,2));return summary;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=='--out')throw new Error('Use run.mjs --out NEW_DIRECTORY.');
  await runProof(args[1]);
}
