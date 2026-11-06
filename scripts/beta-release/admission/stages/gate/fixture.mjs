import {readFileSync} from 'node:fs';
const names=JSON.parse(readFileSync(new URL('../../../data/checks.json',import.meta.url))).checks;
export function facts() {
  const sha='a'.repeat(40),id=73;
  return {repo:'footprintjs/footprintjs-ml',event:'workflow_dispatch',ref:'refs/heads/main',
    workflowRef:'footprintjs/footprintjs-ml/.github/workflows/publish.yml@refs/heads/main',
    sha,head:sha,main:sha,platformSha:sha,checkoutClean:true,runId:91,runNumber:1,attempt:1,dryRun:true,
    history:{complete:true,runs:[{id:91,number:1,workflowId:5,title:'ML beta 0.6.0-beta.14 / dry_run=true',
      sha,event:'workflow_dispatch',path:'.github/workflows/publish.yml',status:'in_progress',jobs:null}]},
    version:'0.6.0-beta.14',packageVersion:'0.6.0-beta.14',lockVersion:'0.6.0-beta.14',
    lockRootVersion:'0.6.0-beta.14',sdkVersion:'0.6.0-beta.14',pythonVersion:'0.6.0b14',projectVersion:'0.6.0b14',
    notesTracked:true,notes:'A separately reviewed SDK release reason.',tagStatus:404,releaseStatus:404,
    expectedChecks:names,ci:{id,attempt:1,headSha:sha,event:'push',branch:'main',
      path:'.github/workflows/ci.yml',status:'completed',conclusion:'success',
      jobs:names.map(name=>({name,runId:id,status:'completed',conclusion:'success',
        steps:[{name:'Actual required step',status:'completed',conclusion:'success'}]}))}};
}
