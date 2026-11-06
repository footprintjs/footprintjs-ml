import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {getJson} from './github.mjs';
import {collectHistory} from './history.mjs';
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
export async function collectFacts({env=process.env,get=getJson}={}) {
  const profile=await json('scripts/beta-release/data/checks.json');
  const sha=env.RELEASE_SHA, version=env.RELEASE_VERSION;
  if(!/^[a-f0-9]{40}$/.test(sha||'')||!/^(\d+\.){2}\d+-beta\.\d+$/.test(version||''))throw Error('invalid-input');
  const pkg=await json('package.json'),lock=await json('package-lock.json');
  const project=await readFile('pyproject.toml','utf8');
  const constants=await readFile('python/footprint_ml_versions.py','utf8');
  const main=await get('/git/ref/heads/main');
  const runs=await get('/actions/workflows/ci.yml/runs?head_sha='+sha+'&event=push&per_page=1');
  const r=runs.value?.workflow_runs?.[0];let jobs=[];
  if(r && Number.isSafeInteger(r.id) && Number.isSafeInteger(r.run_attempt)) {
    const page=await get('/actions/runs/'+r.id+'/attempts/'+r.run_attempt+'/jobs?per_page=100');
    jobs=page.value?.jobs||[];
    if(page.status!==200||page.value.total_count!==jobs.length)jobs=[];
  }
  const tag=await get('/git/ref/tags/v'+version),release=await get('/releases/tags/v'+version);
  const notesPath='release-notes/'+version+'.md';
  let notes='',notesTracked=false;
  try {notes=git('show',sha+':'+notesPath);notesTracked=true;}catch{}
  return {repo:env.GITHUB_REPOSITORY,event:env.GITHUB_EVENT_NAME,ref:env.GITHUB_REF,
    workflowRef:env.GITHUB_WORKFLOW_REF,platformSha:env.GITHUB_SHA,
    runId:Number(env.GITHUB_RUN_ID),runNumber:Number(env.GITHUB_RUN_NUMBER),attempt:Number(env.GITHUB_RUN_ATTEMPT),dryRun:env.RELEASE_DRY_RUN==='true'?true:env.RELEASE_DRY_RUN==='false'?false:null,
    sha,version,head:git('rev-parse','HEAD'),checkoutClean:git('status','--porcelain','--untracked-files=no')==='',main:main.value?.object?.type==='commit'?main.value.object.sha:null,
    packageVersion:pkg.version,lockVersion:lock.version,lockRootVersion:lock.packages?.['']?.version,
    projectVersion:/^version = "([^"]+)"$/m.exec(project)?.[1]||null,
    sdkVersion:/^SDK_VERSION = "([^"]+)"$/m.exec(constants)?.[1]||null,
    pythonVersion:/^PYTHON_VERSION = "([^"]+)"$/m.exec(constants)?.[1]||null,
    notes,notesTracked,tagStatus:tag.status,releaseStatus:release.status,expectedChecks:profile.checks,
    history:await collectHistory(get,version),
    ci:r?{id:r.id,attempt:r.run_attempt,headSha:r.head_sha,event:r.event,branch:r.head_branch,path:r.path,
      status:r.status,conclusion:r.conclusion,jobs:jobs.map(j=>({name:j.name,runId:j.run_id,status:j.status,
        conclusion:j.conclusion,steps:j.steps?.map(s=>({name:s.name,status:s.status,conclusion:s.conclusion}))}))}:null};
}
