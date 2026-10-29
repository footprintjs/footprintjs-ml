import {readFile} from 'node:fs/promises';
import {createLocalModelPublisher} from '../dist/release/index.js';
const [root,input]=process.argv.slice(2);
const raw=JSON.parse(await readFile(input,'utf8'));
const result=await createLocalModelPublisher({root}).publish({...raw,modelBytes:new Uint8Array(Buffer.from(raw.modelBytes,'base64'))});
process.stdout.write(JSON.stringify(result));
