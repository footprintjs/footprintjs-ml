import {test} from 'node:test';
import assert from 'node:assert/strict';
import {historyRun,ciRun,jobRows} from './profile.mjs';
const history=()=>({id:91,run_number:1,workflow_id:5,display_title:'ML beta 0.6.0-beta.13 / dry_run=true',head_sha:'a'.repeat(40),event:'workflow_dispatch',path:'.github/workflows/publish.yml',status:'in_progress'});
const ci=()=>({id:73,run_attempt:1,head_sha:'a'.repeat(40),head_branch:'main',event:'push',path:'.github/workflows/ci.yml',status:'completed',conclusion:'success'});
const job=()=>({id:1,run_id:73,name:'check',status:'completed',conclusion:'success',steps:[{name:'check',status:'completed',conclusion:'success'}]});
for(const [kind,make,check,fields] of [
 ['run',history,historyRun,['display_title','head_sha','event','path','status']],
 ['CI',ci,ciRun,['head_sha','head_branch','event','path','status','conclusion']],
 ['job',job,r=>jobRows([r],73),['name','status','conclusion']],
 ['step',()=>job().steps[0],r=>jobRows([{...job(),steps:[r]}],73),['name','status','conclusion']],
]) {
 test(kind+' complete strings pass',()=>assert.doesNotThrow(()=>check(make())));
 for(const key of fields)for(const value of [undefined,null,7,'',[]])test(kind+' refuses '+key+' '+JSON.stringify(value),()=>{
  const r=make();if(value===undefined)delete r[key];else r[key]=value;
  assert.throws(()=>check(r));
 });
}
test('nonterminal null conclusion is retained as incomplete, never completed success',()=>{
 assert.doesNotThrow(()=>ciRun({...ci(),status:'in_progress',conclusion:null}));
 assert.doesNotThrow(()=>jobRows([{...job(),status:'in_progress',conclusion:null,steps:[{name:'pending',status:'in_progress',conclusion:null}]}],73));
});
test('unknown source, job owner and container shapes refuse',()=>{
 assert.throws(()=>historyRun({...history(),head_sha:'unknown'}));
 assert.throws(()=>ciRun({...ci(),head_sha:'unknown'}));
 assert.throws(()=>jobRows([{...job(),run_id:74}],73));
 assert.throws(()=>jobRows([{...job(),steps:{}}],73));
 for(const bad of [null,[],7])assert.throws(()=>ciRun(bad));
});
