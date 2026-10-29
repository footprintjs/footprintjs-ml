import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openRecording,traceToolpack,callTraceTool} from 'agentfootprint/observe';
import {openWorkflowRecording} from 'footprintjs-ml/lens';

export async function investigateSelection(recording,{variables=['wrongAttempt','correctAttempt']}={}){
  if(recording?.schema!=='footprint-ml-selection-backtracking/v1')throw new Error('Expected selection-backtracking evidence.');
  const session=openWorkflowRecording(recording,{openRecording,traceToolpack,callTraceTool},
    {toolpack:{valueMaxChars:8000}});
  for(const variable of variables)await session.backtrack(variable);
  const transcript=session.transcript;
  return {schema:'footprint-ml-selection-backtracking-investigation/v1',transcript,
    decisions:{wrong:recording.snapshot.sharedState.wrongDecision,correct:recording.snapshot.sharedState.correctDecision},
    execution:{savedJsonOnly:true,trainerStarted:false,numericalTrainingRepeated:false,numericalEvaluationRepeated:false},
    boundaries:recording.boundaries};
}
export async function investigateFile(path,outPath){
  const recording=JSON.parse(await readFile(path,'utf8'));
  const report=await investigateSelection(recording);
  if(outPath)await writeFile(outPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [input,out]=process.argv.slice(2);
  if(!input)throw new Error('Use investigate.mjs RECORDING.json [NEW_REPORT.json].');
  const report=await investigateFile(resolve(input),out?resolve(out):undefined);
  console.log(JSON.stringify(report,null,2));
}
