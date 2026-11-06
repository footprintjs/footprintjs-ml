/** Fixed public-repository GET collector; no mutation or automatic retry. */
const root='https://api.github.com/repos/footprintjs/footprintjs-ml';
export async function getJson(route,{fetcher=fetch,token=process.env.GITHUB_TOKEN}={}) {
  if(!route.startsWith('/')||route.includes('..')||route.includes('#')) throw Error('invalid-route');
  const response=await fetcher(root+route,{headers:{Accept:'application/vnd.github+json',
    ...(token?{Authorization:'Bearer '+token}:{})},signal:AbortSignal.timeout(30000),redirect:'error'});
  if(response.status===404)return {status:404};
  if(response.status!==200)throw Error('read-status');
  const reader=response.body.getReader(),chunks=[];let size=0;
  while(true) {
    const {done,value}=await reader.read();
    if(done)break;
    size+=value.byteLength;
    if(size>2*1024*1024){await reader.cancel();throw Error('read-capacity');}
    chunks.push(value);
  }
  const raw=Buffer.concat(chunks).toString('utf8');
  try{return {status:200,value:JSON.parse(raw)};}catch{throw Error('read-json');}
}
