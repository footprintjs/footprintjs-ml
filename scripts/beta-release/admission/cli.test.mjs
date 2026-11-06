import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
test('malformed dispatch refuses natively, without network or raw input in records',()=>{
 const root=fileURLToPath(new URL('../../../',import.meta.url)),temp=mkdtempSync(join(tmpdir(),'ml-refusal-'));
 try {
  const preload=join(temp,'no-network.mjs');
  writeFileSync(preload,'globalThis.fetch=()=>{process.exit(99)};\n');
  const marker='PRIVATE-FIXTURE-NOT-A-VERSION';
  const child=spawnSync(process.execPath,['--import',preload,'scripts/beta-release/admit.mjs'],{
   cwd:root,env:{PATH:process.env.PATH,RELEASE_SHA:marker,RELEASE_VERSION:marker,
    RELEASE_OUT:join(temp,'record'),GITHUB_RUN_ID:'91',GITHUB_RUN_NUMBER:'1',GITHUB_RUN_ATTEMPT:'1'},
   encoding:'utf8',timeout:30000,maxBuffer:1048576});
  assert.equal(child.status,1,child.stderr);
  const recording=readFileSync(join(temp,'record','recording.json'),'utf8');
  const admission=JSON.parse(readFileSync(join(temp,'record','admission.json'),'utf8'));
  assert.equal(admission.allowed,false);assert.equal(admission.sha,null);assert.equal(admission.version,null);
  assert.ok(admission.refused.includes('context'));
  assert.ok(JSON.parse(recording).snapshot.commitLog.length>0);
  assert.equal(recording.includes(marker),false);
 } finally {rmSync(temp,{recursive:true,force:true});}
});
