import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,mkdir,rename,copyFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

// Exercise the DISTRIBUTED tarball from a directory outside this checkout.
const root=fileURLToPath(new URL('..',import.meta.url));
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const temp=await realpath(await mkdtemp(join(tmpdir(),'footprint-ml-beta-')));
const consumer=join(temp,'consumer');await mkdir(consumer);
const npmCli=process.env.npm_execpath;
assert(npmCli,'Run this check with npm run beta:smoke.');
const env={...process.env,NODE_PATH:''};
const run=(executable,args,cwd=consumer,extra={})=>{
 try{return execFileSync(executable,args,{cwd,env:{...env,...extra},encoding:'utf8',maxBuffer:16*1024*1024});}
 catch(error){throw new Error(`${executable} ${args.join(' ')} failed:\n${error.stdout||''}\n${error.stderr||error.message}`);}
};
const npm=(args,cwd=consumer)=>run(process.execPath,[npmCli,...args],cwd);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
await writeFile(join(consumer,'package.json'),JSON.stringify({name:'footprint-ml-fresh-consumer',private:true,type:'module'}));
npm(['pack','--loglevel','error','--pack-destination',temp],root);
const filename=`footprintjs-ml-${pkg.version}.tgz`, archive=join(temp,filename);
npm(['install',archive,'footprintjs@10.0.0','agentfootprint@11.0.0','foottrace@1.8.0',
 '--ignore-scripts','--no-audit','--no-fund','--loglevel','error','--registry=https://registry.npmjs.org','--cache',join(temp,'npm-cache')]);
const installed=join(consumer,'node_modules','footprintjs-ml');
const installedPkg=JSON.parse(await readFile(join(installed,'package.json'),'utf8'));
assert.equal(installedPkg.version,pkg.version);assert.equal(installedPkg.private,undefined);
assert(npm(['exec','--no','--','footprint-ml','--help']).includes('footprint-ml demo'));
const cli=join(installed,'examples','quickstart','cli.mjs'), runDir=join(consumer,'run');
const configuredPython=process.env.PYTHON||'python3';
const python=/[/\\]/.test(configuredPython)?resolve(root,configuredPython):configuredPython;
const demoOutput=run(process.execPath,[cli,'demo','--out',runDir,'--python',python]);
const outcome=JSON.parse(await readFile(join(runDir,'outcome.json'),'utf8'));
assert.equal(outcome.staleDecision.allowed,false);assert.equal(outcome.staleDecision.status,'deny');
assert.equal(outcome.freshDecision.allowed,true);assert.equal(outcome.backendClosed,true);
assert.equal(outcome.modelRegistryPublication,false);
assert.notEqual(outcome.modelA.inferenceIdentity.sha256,outcome.modelB.inferenceIdentity.sha256);
assert(outcome.evaluationA.metrics.mse<=0.05);assert(outcome.evaluationB.metrics.mse<=0.05);
assert.deepEqual(outcome.approvedModel,outcome.modelB);
const recordingBefore=sha(await readFile(join(runDir,'recording.json')));
// Neither the Python executable nor checkpoint/dataset files are available to
// the separate investigation processes. Only retained JSON is required.
await rename(join(runDir,'backend'),join(runDir,'backend-unavailable-during-reopen'));
const badPython=join(temp,'does-not-exist-python');
const readOnlyInvestigation=['--permission',`--allow-fs-read=${consumer}`,`--allow-fs-write=${runDir}`,cli,'investigate','--run',runDir];
// No --allow-child-process: Node enforces that neither investigator can spawn a trainer.
const staleOutput=run(process.execPath,[...readOnlyInvestigation,'--decision','stale'],consumer,{PYTHON:badPython});
const freshOutput=run(process.execPath,[...readOnlyInvestigation,'--decision','fresh'],consumer,{PYTHON:badPython});
const stale=JSON.parse(await readFile(join(runDir,'investigation.json'),'utf8'));
const fresh=JSON.parse(await readFile(join(runDir,'investigation-fresh.json'),'utf8'));
assert.equal(stale.summary.releaseDecision.allowed,false);assert.equal(stale.summary.inferenceMatches,false);
assert.equal(fresh.summary.releaseDecision.allowed,true);assert.equal(fresh.summary.inferenceMatches,true);
assert.match(stale.summary.modelWriterStageId,/continue-to-b/);assert.match(stale.summary.receiptWriterStageId,/evaluate-a/);
assert.match(fresh.summary.receiptWriterStageId,/evaluate-b/);
for(const report of [stale,fresh]){
 assert.equal(report.transcript.length,10);
 assert(report.transcript.every(call=>call.owner==='agentfootprint/observe: existing Lens toolpack'));
 assert.equal(report.execution.trainerStarted,false);
 const nativeWriter=report.transcript.filter(call=>call.tool==='who_wrote').map(call=>call.result).join('\n');
 assert(nativeWriter.includes(report.summary.modelWriterStageId));
 assert(nativeWriter.includes(report.summary.receiptWriterStageId));
}
assert.equal(sha(await readFile(join(runDir,'recording.json'))),recordingBefore);
const artifactDir=resolve(root,'.artifacts');await mkdir(artifactDir,{recursive:true});
await copyFile(archive,join(artifactDir,filename));
const report={schema:'footprint-ml-clean-consumer/v1',passed:true,version:pkg.version,node:process.version,
 package:{file:filename,sha256:sha(await readFile(archive)),bytes:(await readFile(archive)).length},
 checks:{freshDirectory:true,installedTarball:true,sourceCheckoutNotUsedByConsumer:true,
  actualPythonTraining:true,staleReceiptDenied:true,freshReceiptAllowed:true,trainerClosed:true,
  backendFilesUnavailableDuringReopen:true,separateInvestigationProcesses:true,childProcessesDisallowedDuringReopen:true,configuredPythonPathUnavailable:true,
  nativeLensQueries:20,recordingUnchanged:true},
 metrics:{aMse:outcome.evaluationA.metrics.mse,bMse:outcome.evaluationB.metrics.mse},
 execution:{modelRegistryPublication:false},
 limits:['This checks one NumPy CPU trainer and installed integration; it does not establish other-trainer or remote-publisher support.']};
await writeFile(join(artifactDir,'beta-smoke.json'),JSON.stringify(report,null,2)+'\n');
console.log(demoOutput+staleOutput+freshOutput);
console.log(JSON.stringify(report,null,2));
