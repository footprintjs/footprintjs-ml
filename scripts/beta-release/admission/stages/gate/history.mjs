import {pythonVersion} from './version.mjs';
export function unusedVersion(f) {
  const h=f.history;
  if(!h||h.complete!==true||!Array.isArray(h.runs)||h.runs.length>1000||
    new Set(h.runs.map(r=>r.id)).size!==h.runs.length)return false;
  const own=h.runs.filter(r=>r.id===f.runId);
  if(own.length!==1||own[0].number!==f.runNumber||own[0].sha!==f.sha||
    !Number.isSafeInteger(own[0].workflowId)||own[0].workflowId<1||
    own[0].title!=='ML beta '+f.version+' / dry_run='+f.dryRun||own[0].status!=='in_progress')return false;
  const prior=[];
  for(const r of h.runs) {
    const title=/^ML beta (.+) \/ dry_run=(true|false)$/.exec(r.title||'');
    if(!title||!pythonVersion(title[1])||r.workflowId!==own[0].workflowId||
      r.event!=='workflow_dispatch'||r.path!=='.github/workflows/publish.yml'||
      !Number.isSafeInteger(r.number)||r.number<1)return false;
    if(r.number<=own[0].number)prior.push(r.number);
    if(r.id===f.runId||r.number>own[0].number||title[2]==='true'||title[1]!==f.version)continue;
    const publish=r.jobs?.filter(j=>j.name==='publish');
    if(!publish?.length||!publish.every(j=>j.status==='completed'&&j.conclusion==='skipped'&&
      Array.isArray(j.steps)&&j.steps.length===0))return false;
  }
  // A missing/deleted/lagged earlier native run cannot be cleared by a complete-looking snapshot.
  return prior.length===own[0].number && new Set(prior).size===prior.length;
}
