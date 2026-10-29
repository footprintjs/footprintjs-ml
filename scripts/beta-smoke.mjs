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
await rename(join(runDir,'backend'),join(temp,'backend-unavailable-during-reopen'));
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
const staleChain=stale.transcript.find(call=>call.tool==='backtrack').result;
for(const stage of ['check-stale-receipt#4','evaluate-a#2','train-a#1','continue-to-b#3','connect-trainer#0'])
 assert(staleChain.includes(stage),`Stale chain missed ${stage}`);
assert(!staleChain.includes('evaluate-b#7'),'A later evaluation leaked into the earlier decision');
assert(staleChain.includes('control edges unavailable'),'Missing control evidence was concealed');
const freshChain=fresh.transcript.find(call=>call.tool==='backtrack').result;
for(const stage of ['check-fresh-receipt#8','evaluate-b#7','continue-to-b#3'])assert(freshChain.includes(stage));
const original=JSON.parse(await readFile(join(runDir,'recording.json'),'utf8'));
const staleCommit=original.snapshot.commitLog.findIndex(c=>c.runtimeStageId==='check-stale-receipt#4');
assert(staleCommit>=0);
run(process.execPath,[...readOnlyInvestigation,'--variable','evaluationReceipt','--before',String(staleCommit+1)],consumer,{PYTHON:badPython});
const variable=JSON.parse(await readFile(join(runDir,'investigation-variable.json'),'utf8'));
assert.equal(variable.schema,'footprint-ml-variable-investigation/v1');
assert(variable.transcript[0].result.includes('evaluate-a#2'));
assert(!variable.transcript[0].result.includes('evaluate-b#7'));
run(process.execPath,[...readOnlyInvestigation,'--stage','check-stale-receipt#4'],consumer,{PYTHON:badPython});
const pinned=JSON.parse(await readFile(join(runDir,'investigation-stage.json'),'utf8'));
assert.equal(pinned.summary.selectedDecisionStageId,'check-stale-receipt#4');
// A real prefix through evaluation A has neither a release decision nor ML
// release bindings. Its saved observation is still a native backtrack target.
const {stateAt}=await import('foottrace');
const prefix=structuredClone(original.snapshot), cutoff=prefix.commitLog.findIndex(c=>c.runtimeStageId==='evaluate-a#2');
assert(cutoff>=0);prefix.commitLog=prefix.commitLog.slice(0,cutoff+1);
prefix.sharedState=stateAt(original.snapshot,cutoff).state;
const ids=new Set(prefix.commitLog.map(c=>c.runtimeStageId));
const trim=node=>{
 if(!node||!ids.has(node.runtimeStageId))return undefined;
 const next={...node};if(next.next){next.next=trim(next.next);if(!next.next)delete next.next;}
 if(next.children)next.children=next.children.map(trim).filter(Boolean);return next;
};
prefix.executionTree=trim(prefix.executionTree);
const prefixDir=join(consumer,'evaluation-only');await mkdir(prefixDir);
await writeFile(join(prefixDir,'recording.json'),JSON.stringify({snapshot:prefix}));
const askSaved=(dir)=>run(process.execPath,['--permission',`--allow-fs-read=${consumer}`,`--allow-fs-write=${dir}`,
 cli,'investigate','--run',dir,'--variable','evaluationReceipt'],consumer,{PYTHON:badPython});
askSaved(prefixDir);
const ordinary=JSON.parse(await readFile(join(prefixDir,'investigation-variable.json'),'utf8'));
for(const stage of ['evaluate-a#2','train-a#1','connect-trainer#0'])assert(ordinary.transcript[0].result.includes(stage));
assert(!ordinary.transcript[0].result.includes('check-stale-receipt#4'));
const missingDir=join(consumer,'missing-reads');await mkdir(missingDir);
const missing=structuredClone(prefix);
const omitReads=value=>{if(value&&typeof value==='object'){delete value.stageReads;for(const child of Object.values(value))omitReads(child);}};
omitReads(missing.executionTree);
await writeFile(join(missingDir,'recording.json'),JSON.stringify({snapshot:missing}));
askSaved(missingDir);
const incomplete=JSON.parse(await readFile(join(missingDir,'investigation-variable.json'),'utf8'));
assert(incomplete.transcript[0].result.includes('no per-step read tracking'));
assert(!incomplete.transcript[0].result.includes('train-a#1'));
const selectionDir=join(consumer,'selection-proof');
run(process.execPath,['--permission',`--allow-fs-read=${consumer}`,`--allow-fs-write=${consumer}`,
 join(installed,'examples','selection-backtracking','run.mjs'),'--out',selectionDir],consumer,{PYTHON:badPython});
const selection=JSON.parse(await readFile(join(selectionDir,'outcome.json'),'utf8'));
const selectionTrace=JSON.parse(await readFile(join(selectionDir,'investigation.json'),'utf8'));
assert.equal(selection.wrong.candidateId,'steps-30');assert.equal(selection.wrong.allowed,false);
assert.equal(selection.corrected.candidateId,'steps-100');assert.equal(selection.corrected.allowed,true);
for(const call of selectionTrace.transcript){
 assert(call.result.includes('retain-candidate-observations#1'));
 assert(!call.result.includes('unrelated-telemetry#2'));
}
assert.equal(sha(await readFile(join(runDir,'recording.json'))),recordingBefore);
const nativeQueryCount=[stale,fresh,variable,pinned,ordinary,incomplete,selectionTrace].reduce((n,r)=>n+r.transcript.length,0);
assert.equal(nativeQueryCount,35);
const artifactDir=resolve(root,'.artifacts');await mkdir(artifactDir,{recursive:true});
await copyFile(archive,join(artifactDir,filename));
const report={schema:'footprint-ml-clean-consumer/v1',passed:true,version:pkg.version,node:process.version,
 package:{file:filename,sha256:sha(await readFile(archive)),bytes:(await readFile(archive)).length},
 checks:{freshDirectory:true,installedTarball:true,sourceCheckoutNotUsedByConsumer:true,
  actualPythonTraining:true,staleReceiptDenied:true,freshReceiptAllowed:true,trainerClosed:true,
  backendFilesUnavailableDuringReopen:true,separateInvestigationProcesses:true,childProcessesDisallowedDuringReopen:true,configuredPythonPathUnavailable:true,
  nativeLensQueries:nativeQueryCount,recordingUnchanged:true,transitiveBacktracking:true,historicalCutoff:true,
  explicitDecisionStage:true,evaluationWithoutRelease:true,missingReadsDisclosed:true,
  installedSelectionProof:true,selectionProducerInNativeSlice:true,unrelatedStagesExcluded:true},
 metrics:{aMse:outcome.evaluationA.metrics.mse,bMse:outcome.evaluationB.metrics.mse},
 execution:{modelRegistryPublication:false},
 limits:['This checks one NumPy CPU trainer and installed integration; it does not establish other-trainer or remote-publisher support.']};
await writeFile(join(artifactDir,'beta-smoke.json'),JSON.stringify(report,null,2)+'\n');
console.log(demoOutput+staleOutput+freshOutput);
console.log(JSON.stringify(report,null,2));
