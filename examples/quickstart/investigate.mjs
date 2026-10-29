import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openAdapterWorkflowRun} from 'footprintjs-ml/lens';
import {openRecording,traceToolpack,callTraceTool} from 'agentfootprint/observe';
import {stateAt,findLastWriter,timeTravel} from 'foottrace';

export async function investigate(args=process.argv.slice(2)){
 const opts={decision:'stale'};
 for(let i=0;i<args.length;i+=2){if(!['--run','--decision'].includes(args[i])||!args[i+1])throw new Error('Use --run DIR [--decision stale|fresh].');opts[args[i].slice(2)]=args[i+1];}
 if(!opts.run||!['stale','fresh'].includes(opts.decision))throw new Error('Use --run DIR [--decision stale|fresh].');
 const root=resolve(opts.run), input=JSON.parse(await readFile(resolve(root,'recording.json'),'utf8'));
 if(input.schema!=='footprint-ml-quickstart-recording/v1'||input.backendLifecycle?.closed!==true)throw new Error('Expected a completed quickstart recording.');
 const status=opts.decision==='stale'?'deny':'allow';
 const selected=input.snapshot.commitLog.find(c=>c.overwrite?.releaseDecision?.status===status);
 if(!selected)throw new Error('The recording does not contain that decision.');
 const bridge={openRecording,traceToolpack,callTraceTool,stateAt,findLastWriter,timeTravel};
 const session=openAdapterWorkflowRun(input,bridge,{decisionStageId:selected.runtimeStageId});
 await session.investigate('release');
 const report={schema:'footprint-ml-quickstart-investigation/v1',decision:opts.decision,summary:session.summary,
  anchors:session.anchors,transcript:session.transcript,boundaries:session.boundaries,
  execution:{savedJsonOnly:true,trainerStarted:false,trainingRepeated:false}};
 await writeFile(resolve(root,opts.decision==='stale'?'investigation.json':'investigation-fresh.json'),JSON.stringify(report,null,2)+'\n');
 console.log(`Saved ${opts.decision} decision: ${session.summary.releaseDecision.status}`);
 console.log(`Model last changed at: ${session.summary.modelWriterStageId}`);
 console.log(`Evaluation last written at: ${session.summary.receiptWriterStageId}`);
 console.log(`Native Lens queries: ${session.transcript.length}. Trainer was not started.`);
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))investigate().catch(e=>{console.error(e.message);process.exitCode=1;});
