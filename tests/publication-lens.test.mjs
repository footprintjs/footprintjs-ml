import test from 'node:test';
import assert from 'node:assert/strict';
import {openAdapterWorkflowRun} from '../lens/session.mjs';

// Synthetic public bridge: checks binding/time isolation, not native tool behavior.
function fixture(rename={}) {
 const bindings={model:'model',receipt:'evaluation',decision:'releaseDecision',allowed:'allowed',releasedModel:'released'};
 const publication={pin:'planPin',plan:'pinnedPlan',preparation:'prepared',publication:'published',attempt:'attempt',...rename};
 const gate=allowed=>({kind:'model-release-decision',schemaVersion:1,allowed,status:allowed?'allow':'deny',reasons:[]});
 const changes=[{planPin:{sha256:'original'},pinnedPlan:{releaseId:'test'},released:null,published:null},
  {model:{id:'wrong'},evaluation:{id:'expected'},attempt:{number:1},releaseDecision:gate(false),allowed:false},
  {model:{id:'winner'},prepared:{modelArtifact:{sha256:'winner'}},attempt:{number:2},releaseDecision:gate(true),allowed:true},
  {published:{status:'already-published',revision:'one',modelArtifact:{sha256:'winner'}},attempt:{number:3},releaseDecision:gate(true),allowed:true,released:{id:'winner'}}
 ].map(c=>Object.fromEntries(Object.entries(c).map(([key,value])=>{
  const name=Object.entries({pin:'planPin',plan:'pinnedPlan',preparation:'prepared',publication:'published',attempt:'attempt'}).find(([,original])=>original===key)?.[0];
  return[name?publication[name]:key,value];
 })));
 return{mlInvestigation:{schemaVersion:1,bindings,publication},rows:[{type:'retry',event:{runtimeStageId:'publish#3',attempt:1,error:'Lost acknowledgement'}}],
  footprint:{executionTree:{id:'synthetic'},commitLog:changes.map((overwrite,idx)=>({idx,runtimeStageId:`stage-${idx}#${idx}`,stage:`Synthetic stage ${idx}`,overwrite}))}};
}
function bridge(){const calls=[];
 const stateAt=(s,i)=>({state:s.commitLog.slice(0,i+1).reduce((a,c)=>Object.assign(a,structuredClone(c.overwrite)),{}),basis:'synthetic'});
 return{calls,stateAt,openRecording:r=>r,traceToolpack:r=>r,
  callTraceTool:async(_t,name,args)=>{calls.push({name,args});return `SYNTHETIC ${name}: warnings unchanged`;},
  findLastWriter(log,key,before=log.length){for(let i=Math.min(before,log.length)-1;i>=0;i--)if(Object.hasOwn(log[i].overwrite,key))return log[i];},
  timeTravel(snapshot){let index=0;const stops=snapshot.commitLog.map((c,i)=>({step:i,commitIdx:i,runtimeStageId:c.runtimeStageId}));return{stops,at:()=>stops[index],stateAt:()=>stateAt(snapshot,index),changedSince:()=>[],jumpTo(t){const next=typeof t==='number'?t:stops.findIndex(s=>s.runtimeStageId===t);if(next<0||next>=stops.length)return{moved:false};const moved=next!==index;index=next;return{moved};}};}};
}

test('publication evidence at an earlier denial does not borrow later preparation or acknowledgement',async()=>{
 const input=fixture(),before=JSON.stringify(input),native=bridge(),s=openAdapterWorkflowRun(input,native,{decisionStageId:'stage-1#1'});
 assert.equal(s.summary.releaseDecision.kind,'model-release-decision');assert.equal(s.summary.releaseDecision.allowed,false);
 assert.deepEqual(s.summary.publication.pin,{sha256:'original'});assert.equal(s.summary.publication.preparation,undefined);
 assert.equal(s.summary.publication.publication,null);assert.deepEqual(s.summary.releasedModel,{id:'winner'});
 assert.equal(s.summary.publication.writerStageIds.pin,'stage-0#0');
 await s.investigate('publication');assert.equal(s.transcript.length,20);
 for(const key of Object.values(input.mlInvestigation.publication))assert.ok(native.calls.some(c=>c.name==='get_value'&&c.args.key===key&&c.args.runtimeStageId==='stage-1#1'));
 assert.ok(native.calls.some(c=>c.name==='who_wrote'&&c.args.key==='published'&&c.args.beforeStageId==='stage-2#2'));
 assert.ok(native.calls.some(c=>c.name==='backtrack'&&c.args.variable==='prepared'&&c.args.before===2));
 assert.ok(s.transcript.every(c=>c.result===`SYNTHETIC ${c.tool}: warnings unchanged`));
 assert.equal(s.supplemental[0].kind,'Retry callback');assert.equal(s.supplemental[0].event.error,'Lost acknowledgement');
 assert.equal(JSON.stringify(input),before);
});

test('renamed publication keys expose the recorded final acknowledgement and its writer',async()=>{
 const input=fixture({pin:'authority',plan:'plan',preparation:'approval',publication:'ack',attempt:'delivery'}),native=bridge(),s=openAdapterWorkflowRun(input,native);
 assert.equal(s.summary.publication.publication.status,'already-published');assert.equal(s.summary.publication.attempt.number,3);
 assert.equal(s.summary.publication.writerStageIds.publication,'stage-3#3');assert.equal(s.anchors.releasePreparation,'stage-2#2');
 await s.investigate('publication');for(const key of Object.values(input.mlInvestigation.publication))assert.ok(native.calls.some(c=>c.name==='get_value'&&c.args.key===key));
 assert.equal(s.recording.mlInvestigation.publication.publication,'ack');
});

test('publication bindings are optional; missing captured values do not become a success',async()=>{
 const input=fixture();delete input.mlInvestigation.publication;const s=openAdapterWorkflowRun(input,bridge());
 assert.equal(Object.hasOwn(s.summary,'publication'),false);await assert.rejects(s.investigate('publication'),/requires explicit/);
 const absent=fixture();for(const c of absent.footprint.commitLog)for(const key of Object.values(absent.mlInvestigation.publication))delete c.overwrite[key];
 const missing=openAdapterWorkflowRun(absent,bridge());assert.equal(missing.summary.publication.publication,undefined);assert.equal(missing.summary.publication.writerStageIds.pin,undefined);
});

test('publication bindings reject malformed and colliding keys; unknown decision kinds reject',()=>{
 for(const bad of [null,[],{pin:'x'},{pin:'x',plan:'x',preparation:'p',publication:'r',attempt:'a'},
  {pin:'model',plan:'x',preparation:'p',publication:'r',attempt:'a'}]){const input=fixture();input.mlInvestigation.publication=bad;assert.throws(()=>openAdapterWorkflowRun(input,bridge()),/publication|distinct/);}
 const cross=fixture();cross.mlInvestigation.selection={manifest:'m',results:'rs',receipt:'r',decision:'d',candidate:'planPin'};assert.throws(()=>openAdapterWorkflowRun(cross,bridge()),/distinct/);
 const unknown=fixture();unknown.footprint.commitLog[3].overwrite.releaseDecision.kind='unrecognized-decision';assert.throws(()=>openAdapterWorkflowRun(unknown,bridge()),/not recorded/);
});
