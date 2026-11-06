import {mkdir,writeFile,appendFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {collectFacts} from './io/collect.mjs';
import {runAdmission} from './admission/run.mjs';
const out=resolve(process.env.RELEASE_OUT||'.artifacts/beta-admission');
await mkdir(out,{recursive:true});
let facts;
try {facts=await collectFacts();}
catch {facts={collectionError:true,sha:process.env.RELEASE_SHA||null,version:process.env.RELEASE_VERSION||null,
  runId:Number(process.env.GITHUB_RUN_ID)||null,attempt:Number(process.env.GITHUB_RUN_ATTEMPT)||null};}
const record=await runAdmission(facts);
await writeFile(join(out,'recording.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx'});
const outcome=record.snapshot.sharedState.outcome;
await writeFile(join(out,'admission.json'),JSON.stringify({sha:facts.sha,version:facts.version,
  runId:facts.runId,runNumber:facts.runNumber,attempt:facts.attempt,notes:facts.notes||null,...outcome},null,2)+'\n',{flag:'wx'});
if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,
  'allowed='+outcome.allowed+'\nmode='+outcome.mode+'\n');
if(!outcome.allowed){console.error('Release refused: '+outcome.refused.join(','));process.exitCode=1;}
