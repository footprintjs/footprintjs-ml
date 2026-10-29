import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {flowChart, FlowChartExecutor, decide} from 'footprintjs';
import {checkRelease} from 'footprintjs-ml';
import {createPythonTrainerAdapter} from 'footprintjs-ml/adapter';

const here=fileURLToPath(new URL('.',import.meta.url));
const plain=value=>JSON.parse(JSON.stringify(value));
function options(args){
 const result={};
 for(let i=0;i<args.length;i+=2){if(!['--out','--python','--plugin','--plan'].includes(args[i])||!args[i+1])throw new Error('Use --out DIR [--python PYTHON] [--plugin FILE --plan FILE].');result[args[i].slice(2)]=args[i+1];}
 return result;
}
export async function runDemo(args=process.argv.slice(2)){
 const opts=options(args), root=resolve(opts.out||'quickstart-run');
 const plan=JSON.parse(await readFile(resolve(opts.plan||resolve(here,'plan.json')),'utf8'));
 if(!plan.profile||!plan.trainA||!plan.continueB||!plan.policy)throw new Error('Plan needs profile, trainA, continueB and policy.');
 await mkdir(dirname(root),{recursive:true});
 await mkdir(root,{recursive:false}); // Never overwrite a retained investigation.
 const save=(name,value)=>writeFile(resolve(root,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
 let trainer, emit=()=>{};
 const stage=fn=>async scope=>{emit=(name,payload)=>scope.$emit(name,payload);await fn(scope);};
 const evaluate=async scope=>{
  const result=await trainer.adapter.evaluate({modelRef:plain(scope.modelRef),datasetRef:trainer.datasets.validation,
   preprocessingVersion:trainer.backend.preprocessingVersion,evaluationMethodVersion:trainer.backend.evaluationMethodVersion,
   parameters:plan.evaluationParameters||{}});
  scope.evaluationReceipt=plain(result.receipt);
 };
 const guard=async scope=>{
  const verified=await trainer.adapter.verifyModel({modelRef:plain(scope.modelRef)});
  scope.modelRef=plain(verified);
  scope.releaseDecision=plain(checkRelease({modelRef:verified,receipt:plain(scope.evaluationReceipt),
   datasetRef:trainer.datasets.validation,preprocessingVersion:trainer.backend.preprocessingVersion,
   evaluationMethodVersion:trainer.backend.evaluationMethodVersion,parameters:plan.evaluationParameters||{},policy:plan.policy}));
  scope.releaseAllowed=scope.releaseDecision.allowed;
 };
 let chart=flowChart('Connect your Python trainer',stage(async s=>{
  trainer=await createPythonTrainerAdapter({root:resolve(root,'backend'),pluginPath:resolve(opts.plugin||resolve(here,'trainer.py')),
   config:plan.config||{},expectedProfile:plan.profile},{python:opts.python||process.env.PYTHON||'python3',emit:(n,p)=>emit(n,p)});
  s.backend=plain(trainer.backend);s.datasets=plain(trainer.datasets);s.approvedModel=null;
 }), 'connect-trainer');
 chart.addFunction('Train model A',stage(async s=>{const trained=await trainer.adapter.train(plan.trainA);s.modelRef=plain(trained.modelRef);s.modelA=plain(trained.modelRef);}), 'train-a');
 chart.addFunction('Evaluate model A',stage(async s=>{await evaluate(s);s.receiptA=plain(s.evaluationReceipt);}), 'evaluate-a');
 chart.addFunction('Continue training to model B; leave A’s receipt in place',stage(async s=>{
  const trained=await trainer.adapter.train({...plan.continueB,modelRef:plain(s.modelRef)});
  s.modelRef=plain(trained.modelRef);s.modelB=plain(trained.modelRef);
  if(s.modelA.inferenceIdentity.sha256===s.modelB.inferenceIdentity.sha256)throw new Error('The example needs genuinely changed model parameters.');
 }), 'continue-to-b');
 chart.addFunction('Check B against A’s stale evaluation',stage(async s=>{
  await guard(s);s.staleDecision=plain(s.releaseDecision);
  if(s.releaseAllowed||s.releaseDecision.status!=='deny')throw new Error('Expected the stale evaluation to be denied.');
 }), 'check-stale-receipt');
 const denied=chart.addDeciderFunction('Stop the handoff when evidence does not match',s=>decide(s,
  [{when:{releaseAllowed:{eq:true}},then:'unexpected-approval',label:'Only matching, passing evidence permits handoff'}],
  {branch:'stale-blocked',label:'The current model has no matching evaluation'}),'stale-release-policy');
 denied.addFunctionBranch('unexpected-approval','Fail if stale evidence approves B',()=>{throw new Error('Stale evidence was approved.');});
 denied.addFunctionBranch('stale-blocked','Record the blocked handoff',s=>{s.handoffStatus='blocked-stale-evidence';});
 chart=denied.end();
 chart.addFunction('Evaluate B on the same validation dataset',stage(async s=>{await evaluate(s);s.receiptB=plain(s.evaluationReceipt);}), 'evaluate-b');
 chart.addFunction('Check B against its own evaluation',stage(async s=>{
  await guard(s);s.freshDecision=plain(s.releaseDecision);
  if(!s.releaseAllowed)throw new Error('B did not pass the example policy; inspect its evaluation and choose an appropriate plan.');
 }), 'check-fresh-receipt');
 const approved=chart.addDeciderFunction('Choose the approved handoff',s=>decide(s,
  [{when:{releaseAllowed:{eq:true}},then:'approved',label:'B has matching evidence and passes the declared metric threshold'}],'fresh-blocked'),'fresh-release-policy');
 approved.addFunctionBranch('approved','Record the model approved for this demonstration',s=>{s.approvedModel=plain(s.modelRef);s.handoffStatus='approved-for-demo-handoff';});
 approved.addFunctionBranch('fresh-blocked','Keep the model blocked',s=>{s.handoffStatus='blocked';});
 chart=approved.end();
 const executor=new FlowChartExecutor(chart.build());executor.setReadTracking('full');executor.setWriteTracking('full');
 try{await executor.run();}finally{if(trainer)await trainer.close();}
 const snapshot=plain(executor.getSnapshot()), s=snapshot.sharedState;
 const mlInvestigation={schemaVersion:1,bindings:{model:'modelRef',receipt:'evaluationReceipt',decision:'releaseDecision',allowed:'releaseAllowed',releasedModel:'approvedModel'}};
 const recording={schema:'footprint-ml-quickstart-recording/v1',workflow:{kind:'ml-adapter-workflow/v1'},snapshot,mlInvestigation,
  backendLifecycle:{closed:true},scope:'Model approval demonstration; no model registry publication.'};
 const outcome={schema:'footprint-ml-quickstart-outcome/v1',modelA:s.modelA,modelB:s.modelB,
  evaluationA:s.receiptA,evaluationB:s.receiptB,staleDecision:s.staleDecision,freshDecision:s.freshDecision,
  approvedModel:s.approvedModel,backendClosed:true,modelRegistryPublication:false,commits:snapshot.commitLog.length};
 await save('recording.json',recording);await save('outcome.json',outcome);
 console.log(`A evaluated: ${plan.policy.metric}=${s.receiptA.metrics[plan.policy.metric]}`);
 console.log(`B with A's receipt: ${s.staleDecision.status}`);
 console.log(`B evaluated: ${plan.policy.metric}=${s.receiptB.metrics[plan.policy.metric]}; decision=${s.freshDecision.status}`);
 console.log(`Trainer stopped. Saved recording: ${resolve(root,'recording.json')}`);
 return outcome;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))runDemo().catch(e=>{console.error(e.message);process.exitCode=1;});
