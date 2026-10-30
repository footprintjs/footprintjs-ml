import {createFileArtifactStore,createLocalModelPublisher} from 'footprintjs-ml/release';
const [operation,storeRoot,publisherRoot]=process.argv.slice(2);
if(!['lookup','publish','target','state'].includes(operation)||!storeRoot||!publisherRoot)throw new Error('Use lookup|publish|target|state STORE_ROOT PUBLISHER_ROOT');
const chunks=[];let bytes=0;
for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>1024*1024)throw new Error('Publisher metadata exceeds1MiB');chunks.push(chunk);}
const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
const receiver=createLocalModelPublisher({root:publisherRoot});
let result;
if(operation==='target')result=await receiver.readTarget(input.name);
else if(operation==='state')result=await receiver.readState();
else{
 const request={payload:input.payload,payloadSha256:input.payloadSha256,preparedRef:input.preparedRef};
 if(operation==='publish')request.modelBytes=await createFileArtifactStore({root:storeRoot}).read(input.modelArtifact);
 result=await receiver[operation](request);
}
console.log(JSON.stringify(result));
