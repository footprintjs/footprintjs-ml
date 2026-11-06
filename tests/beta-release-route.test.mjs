// The unchanged normal Node22/24 entry also runs new route fixture suites.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import '../scripts/beta-release/admission/stages/gate/policy.test.mjs';
import '../scripts/beta-release/admission/stages/gate/history.test.mjs';
import '../scripts/beta-release/admission/chart.test.mjs';
import '../scripts/beta-release/admission/cli.test.mjs';
import '../scripts/beta-release/io/github.test.mjs';
import '../scripts/beta-release/io/history.test.mjs';
import '../scripts/beta-release/route.test.mjs';
for(const folder of ['candidate','publisher',''])test('beta route Python '+(folder||'public verification'),()=>{
 const result=spawnSync(process.env.PYTHON||'python3',['-I','-m','unittest','discover',
   '-s','scripts/beta-release/'+folder,'-p','test_*.py','-v'],
   {encoding:'utf8',timeout:90000,maxBuffer:1024*1024});
 assert.equal(result.status,0,(result.stderr||result.error?.message||'')+result.stdout);
});
