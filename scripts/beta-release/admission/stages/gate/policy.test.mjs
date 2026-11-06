import {test} from 'node:test';
import assert from 'node:assert/strict';
import {facts} from './fixture.mjs';
import {gateIds,checkGate} from './policy.mjs';
import {pythonVersion} from './version.mjs';
test('complete positive machine facts pass; review remains procedural',()=>{
 const f=facts();assert.deepEqual(gateIds.filter(id=>!checkGate(id,f)),[]);
 assert.equal(pythonVersion(f.version),'0.6.0b14');
});
const cases=[
 ['context','event','push'],['context','repo','other/repo'],['context','ref','refs/heads/topic'],
 ['context','workflowRef','wrong'],['context','sha','bad'],['context','runId',0],['context','attempt',0],
 ['context','dryRun','false'],['source','main','b'.repeat(40)],['source','head','b'.repeat(40)],
 ['source','platformSha','b'.repeat(40)],['source','checkoutClean',false],
 ['versions','packageVersion','0.6.0-beta.13'],['versions','lockVersion','0.6.0-beta.13'],
 ['versions','lockRootVersion','0.6.0-beta.13'],['versions','sdkVersion','0.6.0-beta.13'],
 ['versions','projectVersion','0.6.0b13'],['versions','pythonVersion','0.6.0b13'],
 ['versions','version','00.6.0-beta.14'],['versions','version','0.6.0-rc.14'],
 ['notes','notesTracked',false],['notes','notes',''],['notes','notes','x'.repeat(65537)],
 ['absence','tagStatus',200],['absence','releaseStatus',200],['absence','tagStatus',500],
 ['absence','releaseStatus',null],
];
for(const [gate,key,value] of cases)test('refuse '+gate+' '+key+' '+String(value).slice(0,30),()=>{
 const f=facts();f[key]=value;assert.equal(checkGate(gate,f),false);
});
const ciCases={
 'empty expected names':f=>f.expectedChecks=[],
 'missing job':f=>f.ci.jobs.pop(),
 'duplicate job':f=>f.ci.jobs[1]=f.ci.jobs[0],
 'renamed job':f=>f.ci.jobs[0].name='unreviewed',
 'another source':f=>f.ci.headSha='b'.repeat(40),
 'another workflow':f=>f.ci.path='.github/workflows/other.yml',
 'PR instead of main run':f=>f.ci.event='pull_request',
 'wrong branch':f=>f.ci.branch='topic',
 'run incomplete':f=>f.ci.status='in_progress',
 'run conclusion null':f=>f.ci.conclusion=null,
 'jobs borrowed across runs':f=>f.ci.jobs[0].runId++,
 'a skipped job':f=>f.ci.jobs[0].conclusion='skipped',
 'a cancelled job':f=>f.ci.jobs[0].conclusion='cancelled',
 'empty steps':f=>f.ci.jobs[0].steps=[],
 'failed required step':f=>f.ci.jobs[0].steps[0].conclusion='failure',
 'skipped required step':f=>f.ci.jobs[0].steps[0].conclusion='skipped',
 'unknown run':f=>f.ci=null,
};
for(const [name,damage] of Object.entries(ciCases))test('refuse '+name,()=>{
 const f=facts();damage(f);assert.equal(checkGate('checks',f),false);
});
test('unknown reads refuse every predicate',()=>{
 assert.ok(gateIds.every(id=>!checkGate(id,{collectionError:true})));
});
