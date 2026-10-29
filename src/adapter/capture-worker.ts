import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {servePythonCapture} from './capture.js';

// Safe to import. Only direct, explicit process startup serves the protocol.
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  servePythonCapture().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
}
