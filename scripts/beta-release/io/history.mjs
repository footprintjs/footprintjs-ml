/** Closed native Actions census; diagnostic history can only add refusals. */
import {historyRun,jobRows} from './profile.mjs';
export async function allPages(get,route,key) {
  const values=[],identities=new Set();let total=null;
  for(let page=1;page<=10;page++) {
    const reply=await get(route+(route.includes('?')?'&':'?')+'per_page=100&page='+page);
    const d=reply.value;
    if(reply.status!==200||!d||!Number.isSafeInteger(d.total_count)||d.total_count<0||d.total_count>1000||
      !Array.isArray(d[key])||d[key].length>100||(total!==null&&total!==d.total_count))throw Error('history-incomplete');
    for(const row of d[key]) {
      if(!row||!Number.isSafeInteger(row.id)||row.id<1||identities.has(row.id))throw Error('history-identity');
      identities.add(row.id);
    }
    total=d.total_count;values.push(...d[key]);
    if(values.length>total)throw Error('history-incomplete');
    if(values.length===total)return values;
    if(d[key].length!==100)throw Error('history-incomplete');
  }
  throw Error('history-capacity');
}
export async function collectHistory(get,version) {
  const runs=await allPages(get,'/actions/workflows/publish.yml/runs','workflow_runs');
  const entries=[];
  for(const r of runs) {
    historyRun(r);
    let jobs=null;
    if(r.display_title==='ML beta '+version+' / dry_run=false') {
      // filter=all retains earlier attempts: a skipped rerun never erases an earlier started job.
      try {jobs=await allPages(get,'/actions/runs/'+r.id+'/jobs?filter=all','jobs');jobRows(jobs,r.id);}
      catch {jobs=null;}
    }
    entries.push({id:r.id,number:r.run_number,workflowId:r.workflow_id,title:r.display_title,sha:r.head_sha,
      event:r.event,path:r.path,status:r.status,jobs:jobs?.map(j=>({id:j.id,runId:j.run_id,name:j.name,status:j.status,
        conclusion:j.conclusion,steps:j.steps?.map(s=>({name:s.name}))}))||null});
  }
  return {complete:true,runs:entries};
}
