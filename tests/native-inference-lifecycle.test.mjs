import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';

test('native inference imports create no worker and an absent output is refused before execution',async()=>{
  const original=childProcess.spawn,attempts=[];
  childProcess.spawn=(...args)=>{attempts.push(args);throw new Error('Unexpected worker startup');};
  syncBuiltinESMExports();
  try{
    const {runNativeProof}=await import('../examples/inference/native-run.mjs');
    assert.equal(typeof runNativeProof,'function');
    await assert.rejects(runNativeProof(),/--out/);
    assert.equal(attempts.length,0);
  }finally{childProcess.spawn=original;syncBuiltinESMExports();}
});

test('native executor startup failure retains failure evidence without a success recording or numerical outputs',async()=>{
  const {runNativeProof}=await import('../examples/inference/native-run.mjs');
  const temp=await mkdtemp(join(tmpdir(),'footprint-native-startup-')),out=join(temp,'failed-run');
  try{
    await assert.rejects(runNativeProof({out,python:join(temp,'absent-python')}),/ENOENT/);
    const files=await readdir(out);
    assert(files.includes('failed-recording.json'));
    assert(!files.includes('recording.json'));assert(!files.includes('outcome.json'));assert(!files.includes('backend'));
    const failed=JSON.parse(await readFile(join(out,'failed-recording.json'),'utf8'));
    assert.equal(failed.schema,'native-inference-failed-recording/v1');
    // The executor may retain an error bundle for the failed stage. That is
    // distinct from a successful numerical initialization or model reference.
    assert.equal(failed.snapshot.sharedState.backend,undefined);
    assert.equal(failed.snapshot.sharedState.modelARef,undefined);
    assert(failed.supplemental.flowEvents.some(event=>event.type==='onRunFailed'));
    assert.equal(failed.snapshot.sharedState.releasedPredictionRef,null);
    // The same location must never be reused to overwrite retained failure evidence.
    await assert.rejects(runNativeProof({out,python:join(temp,'absent-python')}),/EEXIST/);
  }finally{await rm(temp,{recursive:true,force:true});}
});
