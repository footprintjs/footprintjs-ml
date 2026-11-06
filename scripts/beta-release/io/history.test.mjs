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

test('native admission refuses unknown strings in otherwise skipped prior history',async()=>{
 const {collectHistory}=await import('./history.mjs');
 const {facts}=await import('../admission/stages/gate/fixture.mjs');
 const {runAdmission}=await import('../admission/run.mjs');
 for(const [location,field] of [['run','head_sha'],['run','status'],['job','name'],['job','status'],['job','conclusion']])
 for(const variant of ['missing','null','number']) {
  const f=facts();f.runNumber=2;
  const raw=(id,number,dry)=>({id,run_number:number,workflow_id:5,display_title:'ML beta '+f.version+' / dry_run='+dry,
   head_sha:f.sha,event:'workflow_dispatch',path:'.github/workflows/publish.yml',status:id===91?'in_progress':'completed'});
  const runs=[raw(90,1,false),raw(91,2,true)];
  const jobs=[{id:1,run_id:90,name:'publish',status:'completed',conclusion:'skipped',steps:[]},
   {id:2,run_id:90,name:'admit',status:'completed',conclusion:'success',steps:[]}];
  const target=location==='run'?runs[0]:jobs[1];
  if(variant==='missing')delete target[field];else target[field]=variant==='null'?null:7;
  try {f.history=await collectHistory(async route=>route.startsWith('/actions/workflows/')?
   {status:200,value:{total_count:2,workflow_runs:runs}}:{status:200,value:{total_count:2,jobs}},f.version);}
  catch {f.collectionError=true;}
  const record=await runAdmission(f);
  assert.equal(record.snapshot.sharedState.outcome.allowed,false,location+'.'+field+':'+variant);
 }
});

test('array title cannot coerce into a known dry-run title',async()=>{
 const {collectHistory}=await import('./history.mjs');
 const {facts}=await import('../admission/stages/gate/fixture.mjs');
 const {runAdmission}=await import('../admission/run.mjs');
 const f=facts();f.runNumber=2;
 const own={id:91,run_number:2,workflow_id:5,display_title:'ML beta '+f.version+' / dry_run=true',head_sha:f.sha,event:'workflow_dispatch',path:'.github/workflows/publish.yml',status:'in_progress'};
 const prior={...own,id:90,run_number:1,status:'completed',display_title:[own.display_title]};
 try {f.history=await collectHistory(async()=>({status:200,value:{total_count:2,workflow_runs:[prior,own]}}),f.version);}
 catch {f.collectionError=true;}
 assert.equal((await runAdmission(f)).snapshot.sharedState.outcome.allowed,false);
});
