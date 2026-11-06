import {test} from 'node:test';
import assert from 'node:assert/strict';
import {facts} from './fixture.mjs';
import {checkGate} from './policy.mjs';
const previous=()=>({id:90,number:1,workflowId:5,title:'ML beta 0.6.0-beta.14 / dry_run=false',
 sha:'a'.repeat(40),event:'workflow_dispatch',path:'.github/workflows/publish.yml',status:'completed',
 jobs:[{name:'publish',status:'completed',conclusion:'skipped',steps:[]}]});
function twoRun() {const f=facts();f.runNumber=2;f.history.runs[0].number=2;f.history.runs.unshift(previous());return f;}
test('earlier LIVE with publish skipped does not consume version',()=>assert.equal(checkGate('history',twoRun()),true));
for(const conclusion of ['success','failure','cancelled','timed_out',null])
 test('earlier started LIVE consumes version even with '+conclusion,()=>{
  const f=twoRun();f.history.runs[0].jobs[0].conclusion=conclusion;
  assert.equal(checkGate('history',f),false);
 });
const damage={
 'unknown job read':f=>f.history.runs[0].jobs=null,
 'missing publish':f=>f.history.runs[0].jobs=[],
 'in progress':f=>{f.history.runs[0].status='in_progress';f.history.runs[0].jobs[0].status='in_progress';},
 'unparseable title':f=>f.history.runs[0].title='unknown',
 'incomplete':f=>f.history.complete=false,
 'gap after unknown/lagged create':f=>f.history.runs.shift(),
 'duplicate native number':f=>f.history.runs[0].number=2,
 'different workflow':f=>f.history.runs[0].workflowId=6,
};
for(const [name,mutate] of Object.entries(damage))test('refuse '+name,()=>{
 const f=twoRun();mutate(f);assert.equal(checkGate('history',f),false);
});
test('earlier dry run does not consume a version',()=>{
 const f=twoRun();f.history.runs[0].title='ML beta 0.6.0-beta.14 / dry_run=true';
 f.history.runs[0].jobs=null;assert.equal(checkGate('history',f),true);
});
test('a skipped later attempt cannot erase an earlier UNKNOWN publish',()=>{
 const f=twoRun();f.history.runs[0].jobs.push({name:'publish',status:'completed',conclusion:'failure',steps:[{name:'Create draft'}]});
 assert.equal(checkGate('history',f),false);
});
