import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {collectFacts} from './collect.mjs';
import {checkGate} from '../admission/stages/gate/policy.mjs';
const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const names=JSON.parse(readFileSync('scripts/beta-release/data/checks.json','utf8')).checks;
for(const kind of ['unique','duplicate','missing','wrong-run'])test('collected CI census '+kind,async()=>{
 const jobs=names.map((name,i)=>({id:i+1,name,run_id:73,status:'completed',conclusion:'success',steps:[{name:'check',status:'completed',conclusion:'success'}]}));
 if(kind==='duplicate')jobs[1].id=jobs[0].id;
 if(kind==='missing')delete jobs[0].id;
 if(kind==='wrong-run')jobs[0].run_id=72;
 const get=async route=>{
  if(route==='/git/ref/heads/main')return {status:200,value:{object:{type:'commit',sha}}};
  if(route.startsWith('/actions/workflows/ci.yml/runs?'))return {status:200,value:{workflow_runs:[{id:73,run_attempt:1,head_sha:sha,event:'push',head_branch:'main',path:'.github/workflows/ci.yml',status:'completed',conclusion:'success'}]}};
  if(route==='/actions/runs/73/attempts/1/jobs?per_page=100&page=1')return {status:200,value:{total_count:jobs.length,jobs}};
  if(route==='/actions/workflows/publish.yml/runs?per_page=100&page=1')return {status:200,value:{total_count:0,workflow_runs:[]}};
  if(route.startsWith('/git/ref/tags/')||route.startsWith('/releases/tags/'))return {status:404,value:null};
  throw Error('unexpected fixture route');
 };
 const f=await collectFacts({get,env:{RELEASE_SHA:sha,RELEASE_VERSION:'0.6.0-beta.13'}});
 assert.equal(checkGate('checks',f),kind==='unique');
 if(kind==='unique')assert.deepEqual(f.ci.jobs.map(j=>j.id),[1,2,3,4,5]);
});
