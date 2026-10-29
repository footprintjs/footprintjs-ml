import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSelectionReceipt, readSelectionManifest} from 'footprintjs-ml';

const copy=value=>JSON.parse(JSON.stringify(value));
const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
// Explicit projection keeps the measured identities and observed metrics. It
// drops trainer display metadata, callbacks and other machine-local state.
const artifact=a=>({kind:a.kind,path:a.path,sha256:a.sha256,bytes:a.bytes,format:a.format});
const model=m=>({kind:m.kind,sessionId:m.sessionId,handle:m.handle,originArtifact:artifact(m.originArtifact),
  ...(m.inferenceIdentity?{inferenceIdentity:copy(m.inferenceIdentity)}:{})});
const dataset=d=>({kind:d.kind,sessionId:d.sessionId,handle:d.handle,artifact:artifact(d.artifact),
  role:d.role,...(d.rows===undefined?{}:{rows:d.rows}),...(d.shape===undefined?{}:{shape:copy(d.shape)})});
const evaluation=e=>({kind:e.kind,schemaVersion:e.schemaVersion,evaluationId:e.evaluationId,createdAt:e.createdAt,
  modelRef:model(e.modelRef),datasetRef:dataset(e.datasetRef),preprocessingVersion:e.preprocessingVersion,
  evaluationMethodVersion:e.evaluationMethodVersion,parameters:copy(e.parameters),metrics:copy(e.metrics),
  ...(e.schemaVersion===2?{inferenceIdentity:copy(e.inferenceIdentity),
    checkpointForAudit:{kind:'checkpoint',artifact:artifact(e.checkpointForAudit.artifact)}}:
    {checkpoint:{kind:'checkpoint',artifact:artifact(e.checkpoint.artifact)}})});
const selectionSummary=r=>({sha256:digest(r),selectedCandidateId:r.selectedCandidateId,
  direction:r.manifest.policy.direction,ranking:copy(r.ranking)});

export function projectSelectionEvidence(source, sourceBytes){
  if(source.schema!=='footprint-model-selection/v1')throw new Error('Expected the retained three-candidate selection proof.');
  const state=source.footprint.sharedState;
  const manifest=readSelectionManifest({...copy(state.experimentManifest),comparison:{...copy(state.experimentManifest.comparison),
    datasetRef:dataset(state.experimentManifest.comparison.datasetRef)}});
  const candidateResults=state.candidateResults.map(r=>({candidateId:r.candidateId,configuration:copy(r.configuration),
    modelRef:model(r.modelRef),evaluation:evaluation(r.evaluation)}));
  const replayAt=Math.max(...candidateResults.map(r=>r.evaluation.createdAt))+1;
  // The current public reader checks the projected evidence before distribution.
  createSelectionReceipt({selectionId:'projection-validation',createdAt:replayAt,manifest,results:candidateResults});
  for(const r of candidateResults)for(const a of [r.modelRef.originArtifact,r.evaluation.datasetRef.artifact])
    if(a.path.startsWith('/')||/^[A-Za-z]:/.test(a.path))throw new Error('The portable fixture cannot contain absolute artifact paths.');
  return {schema:'footprint-ml-selection-observations/v1',
    source:{label:'footprint-ml-model-selection/run/trace.json',schema:source.schema,
      sha256:digest(sourceBytes),bytes:Buffer.byteLength(sourceBytes),
      manifestSha256:digest(state.experimentManifest),candidateResultsSha256:digest(state.candidateResults),
      pointers:{manifest:'/footprint/sharedState/experimentManifest',candidateResults:'/footprint/sharedState/candidateResults'},
      selections:{wrong:selectionSummary(state.wrongAttempt.selectionReceipt),
        corrected:selectionSummary(state.correctedAttempt.selectionReceipt)}},
    projection:{schemaVersion:1,description:'Core typed references, configurations and evaluation receipts; relative artifact labels are retained. No arrays or executable checkpoint data.',
      sha256:digest({manifest,candidateResults})},replayAt,manifest,candidateResults};
}

export async function extractFixture(sourcePath,outPath){
  const bytes=await readFile(sourcePath,'utf8');
  const fixture=projectSelectionEvidence(JSON.parse(bytes),bytes);
  await writeFile(outPath,JSON.stringify(fixture,null,2)+'\n',{flag:'wx'});
  return fixture;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [sourcePath,outPath]=process.argv.slice(2);
  if(!sourcePath||!outPath)throw new Error('Use extract-fixture.mjs SOURCE_TRACE NEW_FIXTURE.json.');
  await extractFixture(resolve(sourcePath),resolve(outPath));
}
