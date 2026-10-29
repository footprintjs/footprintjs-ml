#!/usr/bin/env node
const [command,...args]=process.argv.slice(2);
try{
 if(command==='demo'){const {runDemo}=await import('./run.mjs');await runDemo(args);}
 else if(command==='investigate'){const {investigate}=await import('./investigate.mjs');await investigate(args);}
 else if(!command||command==='--help')console.log('footprint-ml demo --out DIR [--python PYTHON] [--plugin FILE --plan FILE]\nfootprint-ml investigate --run DIR [--decision stale|fresh]');
 else throw new Error('Unknown command. Run footprint-ml --help.');
}catch(error){console.error(error.code==='ERR_MODULE_NOT_FOUND'?`${error.message}\nThe workflow example needs footprintjs@10.0.0, agentfootprint@11.0.0 and foottrace@1.8.0. See QUICKSTART.md.`:error.message);process.exitCode=1;}
