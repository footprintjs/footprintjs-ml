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
import '../scripts/beta-release/io/collect.test.mjs';
import '../scripts/beta-release/io/profile.test.mjs';
import '../scripts/beta-release/route.test.mjs';
for(const folder of ['candidate',''])test('beta route Python '+(folder||'public verification'),()=>{
 const result=spawnSync(process.env.PYTHON||'python3',['-I','-m','unittest','discover',
   '-s','scripts/beta-release/'+folder,'-p','test_*.py','-v'],
   {encoding:'utf8',timeout:90000,maxBuffer:1024*1024});
 assert.equal(result.status,0,(result.stderr||result.error?.message||'')+result.stdout);
});

// Discover every publisher method, retaining the existing 90s group and 30s case limits.
// One larger aggregate timed out under the second reader's load; no method is excluded.
const python=process.env.PYTHON||'python3';
const inventory=spawnSync(python,['-I','-c',`import json,unittest
suite=unittest.defaultTestLoader.discover('scripts/beta-release/publisher')
def ids(s):
 for item in s:
  if isinstance(item,unittest.TestSuite):yield from ids(item)
  else:yield item.id()
print(json.dumps(list(ids(suite))))`],{encoding:'utf8',timeout:10000});
assert.equal(inventory.status,0,inventory.stderr);
const publisherMethods=JSON.parse(inventory.stdout);
assert.ok(publisherMethods.length>0&&new Set(publisherMethods).size===publisherMethods.length);
for(const method of publisherMethods)test('beta route publisher '+method,()=>{
 const result=spawnSync(python,['-I','-m','unittest','discover','-s','scripts/beta-release/publisher','-k',method,'-v'],
  {encoding:'utf8',timeout:90000,maxBuffer:1024*1024});
 assert.equal(result.status,0,(result.stderr||result.error?.message||'')+result.stdout);
 assert.match(result.stderr,/Ran 1 test in /);
});
