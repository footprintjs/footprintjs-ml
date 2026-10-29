import {readFile,open,stat,lstat,rename,unlink} from 'node:fs/promises';
import {constants,createReadStream} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openAdapterWorkflowRun,openWorkflowRecording} from 'footprintjs-ml/lens';

const usage = 'Use --run DIR_OR_JSON [--decision stale|fresh | --stage DECISION_STAGE] or --run DIR_OR_JSON --variable KEY [--before INDEX].';
const MAX_REPORT_BYTES=16*1024*1024;

// Reports may replace earlier reports, but never a recording or an alias to it.
// The temporary file and atomic replacement also avoid truncating an earlier
// report on a failed write. The containing directory is application-trusted.
async function saveReport(root,filename,report,sourceFile){
 const output=resolve(root,filename),original=await stat(sourceFile);
 const check=async()=>{
  if(output===sourceFile)throw new Error('Refusing to overwrite the source recording with an investigation report.');
  let info;
  try{info=await lstat(output);}catch(error){if(error.code==='ENOENT')return;throw error;}
  if(info.dev===original.dev&&info.ino===original.ino)
   throw new Error('Refusing to overwrite an alias of the source recording.');
  if(info.isSymbolicLink()||!info.isFile())throw new Error('Investigation report output must be a regular report file.');
  if(info.size>MAX_REPORT_BYTES)throw new Error('Investigation report exceeds the 16 MiB report limit.');
  let previous;
  try{
   const chunks=[];let bytes=0;
   const flags=constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0);
   for await(const chunk of createReadStream(output,{flags,start:0,end:MAX_REPORT_BYTES,highWaterMark:65536})){
    bytes+=chunk.length;if(bytes>MAX_REPORT_BYTES)throw new Error('Report byte limit');chunks.push(chunk);
   }
   previous=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }catch{throw new Error('Refusing to replace an existing file that is not a bounded investigation report.');}
  if(previous?.schema!==report.schema||previous.execution?.savedJsonOnly!==true||
    ['snapshot','footprint','commitLog','executionTree'].some(key=>Object.hasOwn(previous,key)))
   throw new Error('Refusing to replace an existing file that is not an investigation report.');
 };
 await check();
 const encoded=JSON.stringify(report,null,2)+'\n';
 if(Buffer.byteLength(encoded)>MAX_REPORT_BYTES)throw new Error('Investigation report exceeds the 16 MiB report limit.');
 const temporary=resolve(root,`.investigation-${randomUUID()}.tmp`);
 let owned=false;
 try{
  const file=await open(temporary,'wx',0o600);owned=true;
  try{await file.writeFile(encoded);}finally{await file.close();}
  await check();
  await rename(temporary,output);owned=false;
 }finally{if(owned)await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
function parseArgs(args) {
 const opts = {};
 for(let i=0;i<args.length;i+=2){
  const flag=args[i], value=args[i+1];
  if(!['--run','--decision','--stage','--variable','--before'].includes(flag)||value===undefined||value.startsWith('--'))throw new Error(usage);
  const name=flag.slice(2);
  if(Object.hasOwn(opts,name))throw new Error(`Duplicate ${flag}. ${usage}`);
  opts[name]=value;
 }
 if(!opts.run||(opts.decision!==undefined&&!['stale','fresh'].includes(opts.decision)))throw new Error(usage);
 if(opts.variable!==undefined){
  if(!opts.variable.trim()||opts.stage!==undefined||opts.decision!==undefined)throw new Error(usage);
 }else if(opts.before!==undefined)throw new Error('--before requires --variable. '+usage);
 if(opts.before!==undefined){
  if(!/^\d+$/.test(opts.before)||!Number.isSafeInteger(Number(opts.before)))throw new Error('--before must be a nonnegative safe integer.');
  opts.before=Number(opts.before);
 }
 return opts;
}

export async function investigate(args=process.argv.slice(2)){
 const opts=parseArgs(args), source=resolve(opts.run);
 const isDirectory=(await stat(source)).isDirectory();
 const root=isDirectory?source:dirname(source),sourceFile=isDirectory?resolve(source,'recording.json'):source;
 const input=JSON.parse(await readFile(sourceFile,'utf8'));
 // Optional dependencies load only for an explicit investigation. Opening saved
 // evidence never imports the trainer adapter or starts a model/provider.
 const {openRecording,traceToolpack,callTraceTool}=await import('agentfootprint/observe');
 const nativeBridge={openRecording,traceToolpack,callTraceTool};
 if(opts.variable!==undefined){
  const session=openWorkflowRecording(input,nativeBridge);
  const entry=await session.backtrack(opts.variable,opts.before===undefined?{}:{before:opts.before});
  const report={schema:'footprint-ml-variable-investigation/v1',variable:opts.variable,
   ...(opts.before===undefined?{}:{before:opts.before}),transcript:session.transcript,
   execution:{savedJsonOnly:true,trainerStarted:false,trainingRepeated:false}};
  await saveReport(root,'investigation-variable.json',report,sourceFile);
  console.log(entry.result);
  console.log('Saved native backtracking evidence. Trainer was not started.');
  return report;
 }
 const {stateAt,findLastWriter,timeTravel}=await import('foottrace');
 const bridge={...nativeBridge,stateAt,findLastWriter,timeTravel};
 const discovered=openAdapterWorkflowRun(input,bridge);
 let selected;
 if(opts.stage!==undefined){
  selected=discovered.decisionChoices.find(choice=>choice.runtimeStageId===opts.stage);
  if(!selected)throw new Error(`The requested stage is not a recorded release decision: ${opts.stage}. Available: ${discovered.decisionChoices.map(choice=>choice.runtimeStageId).join(', ')}`);
  if(opts.decision!==undefined&&selected.status!==(opts.decision==='stale'?'deny':'allow'))throw new Error(`The requested stage does not match --decision ${opts.decision}.`);
 }else{
  const decision=opts.decision??'stale', status=decision==='stale'?'deny':'allow';
  const matches=discovered.decisionChoices.filter(choice=>choice.status===status);
  if(matches.length===0)throw new Error(`The recording does not contain a ${decision} decision.`);
  if(matches.length>1)throw new Error(`Multiple ${decision} decisions were recorded. Select one with --stage: ${matches.map(choice=>choice.runtimeStageId).join(', ')}`);
  selected=matches[0];
 }
 const session=selected.runtimeStageId===discovered.selectedDecisionStageId?discovered:
  openAdapterWorkflowRun(input,bridge,{decisionStageId:selected.runtimeStageId});
 await session.investigate('release');
 const decision=opts.decision??(selected.status==='deny'?'stale':'fresh');
 const report={schema:'footprint-ml-quickstart-investigation/v1',decision,
  ...(opts.stage===undefined?{}:{stage:opts.stage}),summary:session.summary,
  anchors:session.anchors,transcript:session.transcript,boundaries:session.boundaries,
  execution:{savedJsonOnly:true,trainerStarted:false,trainingRepeated:false}};
 const filename=opts.stage!==undefined?'investigation-stage.json':decision==='stale'?'investigation.json':'investigation-fresh.json';
 await saveReport(root,filename,report,sourceFile);
 console.log(`Saved ${decision} decision at ${selected.runtimeStageId}: ${session.summary.releaseDecision.status}`);
 console.log(`Model last changed at: ${session.summary.modelWriterStageId}`);
 console.log(`Evaluation last written at: ${session.summary.receiptWriterStageId}`);
 console.log(`Native Lens queries: ${session.transcript.length}. Trainer was not started.`);
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))investigate().catch(e=>{console.error(e.message);process.exitCode=1;});
