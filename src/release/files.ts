import {constants} from 'node:fs';
import {mkdir,lstat,realpath,open,link,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {artifactRef,canonicalJson,cloneJson,detached,fail,nonempty} from '../contracts.js';
import type {ArtifactRef,JsonValue} from '../contracts.js';
import type {ReleaseArtifactStore} from '../release.js';

const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
export const safeOpenRead=constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0);
export const safeOpenNew=constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0);
export function exactFields(value:unknown,keys:readonly string[],label:string):asserts value is Record<string,unknown>{
  if(value===null||typeof value!=='object'||Array.isArray(value))fail('invalid-local-record',label+' must be an object');
  if(Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key)))fail('invalid-local-record',label+' has missing or unsupported fields');
}
/** The caller owns/trusts root and its parent entries. Observed symlinks are
 * refused; this local helper does not defeat a hostile filesystem rename race. */
export function trustedDirectory(root:string){
  const requested=resolve(nonempty(root,'root'));let initialized:Promise<string>|undefined;
  return()=>initialized??=(async()=>{await mkdir(requested,{recursive:true});const info=await lstat(requested);
    if(!info.isDirectory()||info.isSymbolicLink())fail('unsafe-artifact-root','The managed root must be a real directory');
    return realpath(requested);})();
}
function pathFor(identity:{sha256:string;format:string}){return 'sha256-'+identity.sha256.toLowerCase()+'-'+sha(identity.format)+'.bin';}
export function managedReference(value:unknown):ArtifactRef{
  exactFields(value,['kind','path','sha256','bytes','format'],'managed artifact');
  const ref=artifactRef(value);
  if(ref.path!==pathFor(ref))fail('unsafe-artifact-path','Artifact path must match its managed content and format identity');
  return detached({...ref,sha256:ref.sha256.toLowerCase()});
}
export async function readPlainFile(file:string,options:{readonly expectedBytes?:number;readonly maxBytes?:number}={}):Promise<Uint8Array>{
  const handle=await open(file,safeOpenRead);
  try{const info=await handle.stat();if(!info.isFile())fail('unsafe-artifact-path','Managed records must be regular files');
    if(!Number.isSafeInteger(info.size)||info.size<0)fail('invalid-local-record','Managed file size must be a nonnegative safe integer');
    if(options.expectedBytes!==undefined&&info.size!==options.expectedBytes)fail('artifact-bytes-mismatch','Stored artifact size does not match its reference');
    if(options.maxBytes!==undefined&&info.size>options.maxBytes)fail('local-record-too-large','Managed metadata exceeds its byte limit');
    // Bound allocation and reads to the opened descriptor's observed size.
    // One extra byte detects growth without reading an unbounded replacement.
    const bytes=new Uint8Array(info.size);let offset=0;
    while(offset<bytes.length){const result=await handle.read(bytes,offset,Math.min(bytes.length-offset,1024*1024),offset);
      if(result.bytesRead===0)fail('artifact-bytes-mismatch','Managed file changed size while being read');offset+=result.bytesRead;}
    const extra=new Uint8Array(1),tail=await handle.read(extra,0,1,bytes.length);
    if(tail.bytesRead!==0||(await handle.stat()).size!==bytes.length)fail('artifact-bytes-mismatch','Managed file changed size while being read');
    return bytes;}finally{await handle.close();}
}
export interface FileArtifactStore extends ReleaseArtifactStore{
  putJson(value:unknown,format?:string):Promise<ArtifactRef>;
}
/** Content + format addressed immutable files. Format labels are bound to
 * their filenames; arbitrary binary formats are not parsed or authenticated. */
export function createFileArtifactStore(options:{readonly root:string}):FileArtifactStore{
  const directory=trustedDirectory(options.root);
  const read=async(value:ArtifactRef)=>{
    const ref=managedReference(value),root=await directory(),bytes=await readPlainFile(join(root,ref.path),{expectedBytes:ref.bytes});
    if(bytes.length!==ref.bytes||sha(bytes)!==ref.sha256)fail('artifact-bytes-mismatch','Stored artifact bytes do not match their reference');
    return bytes;
  };
  const put=async(value:Uint8Array,options:{readonly format:string})=>{
    if(!(value instanceof Uint8Array))fail('invalid-release-bytes','Artifact contents must be Uint8Array bytes');
    const bytes=new Uint8Array(value),format=nonempty(options.format,'format');
    const ref=detached({kind:'artifact' as const,path:pathFor({sha256:sha(bytes),format}),sha256:sha(bytes),bytes:bytes.length,format});
    const root=await directory(),temporary=join(root,'.artifact-'+process.pid+'-'+randomUUID()+'.tmp');
    let owned=false;
    try{const file=await open(temporary,safeOpenNew,0o600);owned=true;
      try{await file.writeFile(bytes);}finally{await file.close();}
      try{await link(temporary,join(root,ref.path));}
      catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;await read(ref);}
      return ref;
    }finally{if(owned)await unlink(temporary).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});}
  };
  return{read,put,putJson:(value,format='application/json')=>{
    const snapshot=cloneJson(value,'JSON artifact') as JsonValue;
    return put(new TextEncoder().encode(canonicalJson(snapshot)),{format});
  }};
}
