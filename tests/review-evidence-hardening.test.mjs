import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,symlink,link,readdir,open,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {flowChart,FlowChartExecutor} from 'footprintjs';
import {openRecording,traceToolpack,callTraceTool} from 'agentfootprint/observe';
import {stateAt,findLastWriter,timeTravel} from 'foottrace';
import {createEvaluationReceipt,checkRelease} from '../dist/index.js';
import {runAdapterConformance} from '../dist/conformance/index.js';
import {openWorkflowRecording,openAdapterWorkflowRun} from '../lens/session.mjs';
import {evaluated,releaseRequest} from './fixtures.mjs';

const bridge={openRecording,traceToolpack,callTraceTool,stateAt,findLastWriter,timeTravel};
const cli=resolve('examples/quickstart/cli.mjs');
async function recording(allowed=false){
  const receipt=createEvaluationReceipt(evaluated()),request=releaseRequest(receipt);
  const chart=flowChart('Retain independent reference and evaluation',s=>{
    s.modelRef=request.modelRef;s.evaluationReceipt=receipt;s.value=14;s.approvedModel=null;
  },'seed').addFunction('Check the offered evidence',s=>{
    if(!allowed)s.modelRef={...s.modelRef,originArtifact:{...s.modelRef.originArtifact,sha256:'c'.repeat(64)}};
    s.releaseDecision=checkRelease({...request,modelRef:s.modelRef,receipt:s.evaluationReceipt});
    s.releaseAllowed=s.releaseDecision.allowed;
  },'guard');
  const executor=new FlowChartExecutor(chart.build());executor.setReadTracking('full');executor.setWriteTracking('full');
  await executor.run();
  return{snapshot:JSON.parse(JSON.stringify(executor.getSnapshot())),mlInvestigation:{schemaVersion:1,
    bindings:{model:'modelRef',receipt:'evaluationReceipt',decision:'releaseDecision',allowed:'releaseAllowed',releasedModel:'approvedModel'}}};
}
const ask=(source,args=[])=>spawnSync(process.execPath,[cli,'investigate','--run',source,...args],
  {encoding:'utf8',timeout:10000,maxBuffer:2*1024*1024});
async function directory(operation){const root=await mkdtemp(join(tmpdir(),'footprint-evidence-fix-'));try{await operation(root);}finally{await rm(root,{recursive:true,force:true});}}

test('every generic investigation mode refuses a source/report filename collision without changing the recording',async()=>{
  for(const [name,args,allowed] of [
    ['investigation-variable.json',['--variable','value'],false],
    ['investigation.json',['--decision','stale'],false],
    ['investigation-fresh.json',['--decision','fresh'],true],
    ['investigation-stage.json',['--stage','guard#1'],false],
  ])await directory(async root=>{
    const source=join(root,name),bytes=JSON.stringify(await recording(allowed));await writeFile(source,bytes);
    const result=ask(source,args);assert.notEqual(result.status,0);assert.match(result.stderr,/overwrite.*source recording/);
    assert.equal(await readFile(source,'utf8'),bytes,name);
  });
});

test('source aliases and unrelated recording targets remain intact',async()=>{
  for(const alias of ['hardlink',...(process.platform==='win32'?[]:['symlink'])])await directory(async root=>{
    const source=join(root,'recording.json'),output=join(root,'investigation-variable.json');
    const bytes=JSON.stringify(await recording());await writeFile(source,bytes);
    if(alias==='hardlink')await link(source,output);else await symlink(source,output);
    const result=ask(source,['--variable','value']);assert.notEqual(result.status,0);
    assert.equal(await readFile(source,'utf8'),bytes);assert.equal(await readFile(output,'utf8'),bytes);
  });
  await directory(async root=>{
    const source=join(root,'recording.json'),output=join(root,'investigation-variable.json');
    const bytes=JSON.stringify(await recording()),other=JSON.stringify(await recording(true));
    await writeFile(source,bytes);await writeFile(output,other);
    const result=ask(source,['--variable','value']);assert.notEqual(result.status,0);assert.match(result.stderr,/not an investigation report/);
    assert.equal(await readFile(source,'utf8'),bytes);assert.equal(await readFile(output,'utf8'),other);
  });
});

test('normal repeated investigations replace only their report and preserve source bytes',async()=>directory(async root=>{
  const source=join(root,'recording.json'),bytes=JSON.stringify(await recording());await writeFile(source,bytes);
  for(let attempt=0;attempt<2;attempt++){
    const result=ask(root,['--variable','value']);assert.equal(result.status,0,result.stderr);
    const report=JSON.parse(await readFile(join(root,'investigation-variable.json'),'utf8'));
    assert.equal(report.schema,'footprint-ml-variable-investigation/v1');assert.equal(report.execution.savedJsonOnly,true);
    assert.equal(await readFile(source,'utf8'),bytes);
  }
  assert(!(await readdir(root)).some(name=>name.startsWith('.investigation-')));
}));

test('oversized pre-existing report targets are refused without replacing either file',async()=>directory(async root=>{
  const source=join(root,'recording.json'),output=join(root,'investigation-variable.json');
  const bytes=JSON.stringify(await recording());await writeFile(source,bytes);
  const file=await open(output,'wx');try{await file.truncate(16*1024*1024+1);}finally{await file.close();}
  const result=ask(source,['--variable','value']);assert.notEqual(result.status,0);assert.match(result.stderr,/16 MiB/);
  assert.equal(await readFile(source,'utf8'),bytes);assert.equal((await stat(output)).size,16*1024*1024+1);
}));

test('both saved readers reject conflicting aliases before opening native tools, but accept equivalent aliases',async()=>{
  const first=await recording(),second=structuredClone(first);second.snapshot.sharedState.value=42;
  let opened=0;const stop={...bridge,openRecording(){opened++;throw new Error('Bridge must not open conflicting evidence');}};
  for(const read of [openWorkflowRecording,openAdapterWorkflowRun]){
    assert.throws(()=>read({...first,footprint:second.snapshot},stop),/Conflicting.*aliases/);
    let getters=0;const accessor={...first};Object.defineProperty(accessor,'footprint',{get(){getters++;return second.snapshot;}});
    assert.throws(()=>read(accessor,stop),/data property/);assert.equal(getters,0);
    const reordered=Object.fromEntries(Object.entries(structuredClone(first.snapshot)).reverse());
    assert.equal(read({...first,footprint:reordered},bridge).snapshot.sharedState.value,14);
    assert.equal(read({...first,footprint:undefined},bridge).snapshot.sharedState.value,14);
  }
  assert.equal(opened,0);
  assert.equal(openWorkflowRecording(first.snapshot,bridge).snapshot.sharedState.value,14);
  assert.equal(openWorkflowRecording({footprint:first.snapshot},bridge).snapshot.sharedState.value,14);
});

test('misspelled or unsupported approval-policy fields never silently drop constraints',()=>{
  const receipt=createEvaluationReceipt(evaluated());
  for(const key of ['maxAgeMS','maxAgems','minimumRows']){
    const request=releaseRequest(receipt);request.policy[key]=1;
    const result=checkRelease(request);assert.equal(result.allowed,false);assert.equal(result.status,'unknown');
    assert(result.reasons.some(reason=>reason.message.includes(key)));
  }
  const expired=releaseRequest(receipt);expired.policy.maxAgeMs=1;
  assert.equal(checkRelease(expired).status,'deny');
  const valid=releaseRequest(receipt);valid.policy.maxAgeMs=100;
  assert.equal(checkRelease(valid).allowed,true);
});

test('conformance binds the returned plan to the frozen request and allows key reordering',async t=>{
  const python=process.env.FOOTPRINT_ML_TEST_PYTHON||'python3';
  if(spawnSync(python,['--version']).status!==0){t.skip('Python is unavailable');return;}
  const options={pluginPath:'fixture.py',out:'fixture-output',python,runnerPath:resolve('tests/fixtures/conformance_runner.py'),
    plan:{train:{steps:1},metric:'accuracy'},config:{mode:'wrong-plan'}};
  await assert.rejects(runAdapterConformance(options),error=>error.code==='invalid-report'&&/plan differs/.test(error.message));
  const valid=await runAdapterConformance({...options,config:{mode:'reordered-plan'}});
  assert.equal(valid.passed,true);assert.deepEqual(valid.plan,options.plan);
});
