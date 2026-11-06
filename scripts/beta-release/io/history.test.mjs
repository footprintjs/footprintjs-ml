import {test} from 'node:test';
import assert from 'node:assert/strict';
import {allPages} from './history.mjs';
test('history reads and joins all pages',async()=>{
 let count=0;const rows=Array.from({length:101},(_,id)=>({id:id+1}));
 const got=await allPages(async()=>({status:200,value:{total_count:101,workflow_runs:count++===0?rows.slice(0,100):rows.slice(100)}}),'/fixed','workflow_runs');
 assert.equal(got.length,101);assert.equal(count,2);
});
for(const [name,value] of Object.entries({
 'past cap':{total_count:1001,workflow_runs:[]},'early end':{total_count:101,workflow_runs:[]},
 'missing count':{workflow_runs:[]},'malformed rows':{total_count:1,workflow_runs:null}}))
 test('refuse history '+name,()=>assert.rejects(()=>allPages(async()=>({status:200,value}),'/fixed','workflow_runs')));

for(const key of ['workflow_runs','jobs'])test('refuse repeated '+key+' identity across pages',async()=>{
 const rows=Array.from({length:100},(_,id)=>({id:id+1}));let page=0;
 await assert.rejects(()=>allPages(async()=>({status:200,value:{total_count:101,[key]:page++===0?rows:[rows[0]]}}),'/fixed',key));
});
for(const row of [{}, {id:null}, {id:0}, {id:-1}, {id:1.5}, {id:true}, {id:'1'}])
 test('refuse missing or malformed row identity '+JSON.stringify(row),()=>
  assert.rejects(()=>allPages(async()=>({status:200,value:{total_count:1,jobs:[row]}}),'/fixed','jobs')));

test('native admission refuses a duplicate page hiding an older started publisher',async()=>{
 const {collectHistory}=await import('./history.mjs');
 const {facts}=await import('../admission/stages/gate/fixture.mjs');
 const {runAdmission}=await import('../admission/run.mjs');
 const f=facts();f.runNumber=2;
 const raw=(id,number,dry)=>({id,run_number:number,workflow_id:5,display_title:'ML beta '+f.version+' / dry_run='+dry,
  head_sha:f.sha,event:'workflow_dispatch',path:'.github/workflows/publish.yml',status:id===91?'in_progress':'completed'});
 const jobs=Array.from({length:100},(_,i)=>({id:i+1,run_id:90,name:i===0?'publish':'admit',status:'completed',conclusion:i===0?'skipped':'success',steps:[]}));
 f.history=await collectHistory(async route=>route.startsWith('/actions/workflows/')?
  {status:200,value:{total_count:2,workflow_runs:[raw(90,1,false),raw(91,2,true)]}}:
  {status:200,value:{total_count:101,jobs:route.includes('page=1')?jobs:[jobs[0]]}},f.version);
 const record=await runAdmission(f);
 assert.equal(record.snapshot.sharedState.outcome.allowed,false);
 assert.ok(record.snapshot.sharedState.outcome.refused.includes('history'));
});
