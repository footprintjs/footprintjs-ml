import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {readObservations,runSelectionProof,sha256,plain,validateObservations} from '../examples/selection-backtracking/proof.mjs';
import {investigateSelection} from '../examples/selection-backtracking/investigate.mjs';
import {runClosureControl} from '../examples/selection-backtracking/controls.mjs';

const packageRoot=fileURLToPath(new URL('..',import.meta.url));

test('retained observations are portable, checked and retain original measured metrics',async()=>{
  const fixture=await readObservations();
  assert.equal(fixture.source.sha256,'22b370b278ad8f5c87d1fc056dcbb4056f576e34029799a1d9bb0872037600fb');
  assert.equal(fixture.source.pointers.candidateResults,'/footprint/sharedState/candidateResults');
  assert.deepEqual(fixture.candidateResults.map(r=>[r.candidateId,r.evaluation.metrics.mse]),[
    ['steps-100',0.001700233258309988],['steps-30',0.004259598336456735],['steps-60',0.0023385982112158693]]);
  assert.doesNotMatch(JSON.stringify(fixture),/\/Users\/|file:\/\//);
  const changed=plain(fixture);changed.candidateResults[0].evaluation.metrics.mse=0;
  assert.throws(()=>validateObservations(changed),/observations changed/);
});

test('real guards block the reversed ranking and allow the declared ranking from tracked inputs',async()=>{
  const recording=await runSelectionProof(await readObservations()),s=recording.snapshot.sharedState;
  assert.equal(s.wrongReceipt.selectedCandidateId,'steps-30');assert.equal(s.wrongDecision.allowed,false);
  assert.equal(s.correctReceipt.selectedCandidateId,'steps-100');assert.equal(s.correctDecision.allowed,true);
  assert.ok(s.wrongDecision.reasons.some(reason=>reason.code==='selection-policy-mismatch'));
  assert.equal(recording.evidence.numericalTrainingRepeated,false);
  assert.equal(recording.evidence.numericalEvaluationRepeated,false);
});

test('native backtracking reaches the distinct observation producer and excludes unrelated or later work',async()=>{
  const recording=await runSelectionProof(await readObservations()),original=JSON.stringify(recording);
  const report=await investigateSelection(recording);
  assert.equal(report.transcript.length,2);
  for(const row of report.transcript){
    assert.equal(row.owner,'agentfootprint/observe: existing Lens toolpack');
    assert.match(row.result,/declare-manifest#0/);assert.match(row.result,/retain-candidate-observations#1/);
    assert.match(row.result,/← via candidateResults/);assert.match(row.result,/← via manifest/);
    assert.doesNotMatch(row.result,/unrelated-telemetry/);
    assert.match(row.result,/control edges unavailable/,'Native missing-control warning must remain visible.');
  }
  assert.match(report.transcript[0].result,/rank-wrong-direction#3/);
  assert.doesNotMatch(report.transcript[0].result,/rank-correct-direction|guard-correct-direction/);
  assert.match(report.transcript[1].result,/rank-correct-direction#5/);
  assert.doesNotMatch(report.transcript[1].result,/rank-wrong-direction|guard-wrong-direction/);
  assert.equal(JSON.stringify(recording),original);
});

test('native missing-read response stays incomplete instead of borrowing the known input history',async()=>{
  const recording=await runSelectionProof(await readObservations(),{readTracking:'off'});
  const report=await investigateSelection(recording);
  for(const row of report.transcript){
    assert.match(row.result,/no per-step read tracking/);
    assert.doesNotMatch(row.result,/retain-candidate-observations#1/);
    assert.doesNotMatch(row.result,/declare-manifest#0/);
  }
  // Missing capture changes diagnostic coverage, not the real guard calculation.
  assert.equal(recording.snapshot.sharedState.wrongDecision.allowed,false);
  assert.equal(recording.snapshot.sharedState.correctDecision.allowed,true);
});

test('closure control reproduces the missing producer while tracked scope restores its native chain',async()=>{
  const fixture=await readObservations();
  const control=await runClosureControl(fixture);
  const before=(await investigateSelection(control,{variables:['wrongAttempt']})).transcript[0].result;
  assert.match(before,/closure-ranking/);assert.doesNotMatch(before,/retain-candidate-observations#1/);
  assert.equal(control.snapshot.sharedState.wrongDecision.allowed,false);
  const after=(await investigateSelection(await runSelectionProof(fixture))).transcript[0].result;
  assert.match(after,/retain-candidate-observations#1/);
});

test('fresh process reopens the saved native chains with child processes forbidden and no trainer',async t=>{
  const temporary=await realpath(await mkdtemp(join(tmpdir(),'footprint-selection-backtrack-')));
  t.after(()=>rm(temporary,{recursive:true,force:true}));
  const input=join(temporary,'recording.json'),output=join(temporary,'reopened.json');
  const recording=await runSelectionProof(await readObservations()),encoded=JSON.stringify(recording);
  await writeFile(input,encoded);
  const processResult=spawnSync(process.execPath,['--permission',`--allow-fs-read=${packageRoot}`,`--allow-fs-read=${temporary}`,
    `--allow-fs-write=${temporary}`,resolve(packageRoot,'examples/selection-backtracking/investigate.mjs'),input,output],
    {encoding:'utf8',env:{...process.env,PYTHON:join(temporary,'python-does-not-exist')},maxBuffer:2*1024*1024});
  assert.equal(processResult.status,0,processResult.stderr||processResult.stdout);
  const reopened=JSON.parse(await readFile(output,'utf8'));
  assert.equal(reopened.execution.trainerStarted,false);
  for(const row of reopened.transcript)assert.match(row.result,/retain-candidate-observations#1/);
  assert.equal(sha256(await readFile(input,'utf8')),sha256(encoded));
});
