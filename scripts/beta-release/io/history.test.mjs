import {test} from 'node:test';
import assert from 'node:assert/strict';
import {allPages} from './history.mjs';
test('history reads and joins all pages',async()=>{
 let count=0;const rows=Array.from({length:101},(_,id)=>({id}));
 const got=await allPages(async()=>({status:200,value:{total_count:101,workflow_runs:count++===0?rows.slice(0,100):rows.slice(100)}}),'/fixed','workflow_runs');
 assert.equal(got.length,101);assert.equal(count,2);
});
for(const [name,value] of Object.entries({
 'past cap':{total_count:1001,workflow_runs:[]},'early end':{total_count:101,workflow_runs:[]},
 'missing count':{workflow_runs:[]},'malformed rows':{total_count:1,workflow_runs:null}}))
 test('refuse history '+name,()=>assert.rejects(()=>allPages(async()=>({status:200,value}),'/fixed','workflow_runs')));
