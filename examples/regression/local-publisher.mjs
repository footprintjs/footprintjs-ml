import {createFileArtifactStore,createLocalModelPublisher} from 'footprintjs-ml/release';
const [operation,storeRoot,publisherRoot]=process.argv.slice(2);
if(!['lookup','publish','state'].includes(operation)||!storeRoot||!publisherRoot)throw new Error('Use lookup|publish|state STORE_ROOT PUBLISHER_ROOT');
const publisher=createLocalModelPublisher({root:publisherRoot});
const chunks=[];let bytes=0;
for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>1024*1024)throw new Error('Publisher metadata exceeds 1 MiB');chunks.push(chunk);}
const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
let result;
if(operation==='state')result=await publisher.readState();
else{
 const request={payload:input.payload,payloadSha256:input.payloadSha256,preparedRef:input.preparedRef};
 if(operation==='publish')request.modelBytes=await createFileArtifactStore({root:storeRoot}).read(input.modelArtifact);
 result=await publisher[operation](request);
}
console.log(JSON.stringify(result));
