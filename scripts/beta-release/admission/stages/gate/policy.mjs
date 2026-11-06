/** Positive machine predicates only; a dispatch is not a machine-readable review. */
const REPO='footprintjs/footprintjs-ml';
import {unusedVersion} from './history.mjs';
import {pythonVersion} from './version.mjs';
export const gateIds=['context','source','versions','notes','checks','absence','history'];
export function checkGate(id,f) {
  if(!f || typeof f!=='object' || f.collectionError===true)return false;
  const v=pythonVersion(f.version);
  const predicates={
    context:()=>f.event==='workflow_dispatch' && f.repo===REPO && f.ref==='refs/heads/main' &&
      f.workflowRef===REPO+'/.github/workflows/publish.yml@refs/heads/main' &&
      /^[a-f0-9]{40}$/.test(f.sha) && Number.isSafeInteger(f.runId) && f.runId>0 &&
      Number.isSafeInteger(f.attempt) && f.attempt>0 && typeof f.dryRun==='boolean',
    source:()=>f.checkoutClean===true && /^[a-f0-9]{40}$/.test(f.sha) && f.sha===f.main && f.sha===f.head && f.sha===f.platformSha,
    versions:()=>v!==null && f.packageVersion===f.version && f.lockVersion===f.version &&
      f.lockRootVersion===f.version && f.sdkVersion===f.version && f.pythonVersion===v &&
      f.projectVersion===v,
    notes:()=>f.notesTracked===true && typeof f.notes==='string' && f.notes.trim().length>0 &&
      Buffer.byteLength(f.notes,'utf8')<=65536,
    checks:()=>validChecks(f),
    absence:()=>f.tagStatus===404 && f.releaseStatus===404,
    history:()=>unusedVersion(f),
  };
  return Object.hasOwn(predicates,id) && predicates[id]()===true;
}
function validChecks(f) {
  const r=f.ci;
  const names=f.expectedChecks;
  if(!Array.isArray(names)||names.length!==5||new Set(names).size!==names.length ||
      !r || r.headSha!==f.sha || r.event!=='push' || r.branch!=='main' ||
      r.path!=='.github/workflows/ci.yml' || r.status!=='completed' || r.conclusion!=='success' ||
      !Number.isSafeInteger(r.id)||r.id<=0||!Number.isSafeInteger(r.attempt)||r.attempt<1||
      !Array.isArray(r.jobs)||r.jobs.length!==names.length||
      r.jobs.some(j=>!j||!Number.isSafeInteger(j.id)||j.id<=0)||
      new Set(r.jobs.map(j=>j.id)).size!==r.jobs.length) return false;
  return names.every(name=> {
    const matched=r.jobs.filter(j=>j.name===name);
    return matched.length===1 && matched[0].runId===r.id &&
      matched[0].status==='completed' && matched[0].conclusion==='success' &&
      Array.isArray(matched[0].steps) && matched[0].steps.length>0 &&
      matched[0].steps.every(s=>s.status==='completed'&&s.conclusion==='success');
  });
}
