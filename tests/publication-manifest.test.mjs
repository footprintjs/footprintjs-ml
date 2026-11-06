import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const fingerprint=bytes=>({sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
async function verifyPublishedFiles(root) {
 const manifest=JSON.parse(await readFile(join(root,'publication-manifest.json'),'utf8'));
 assert.equal(manifest.schema,'footprint-ml-public-projection/v1');
 assert.ok(Array.isArray(manifest.files)&&manifest.files.length>0);
 const files=[];
 async function walk(directory,prefix='') {
  for(const entry of await readdir(directory,{withFileTypes:true})) {
   const path=prefix+entry.name;
   if(entry.isDirectory())await walk(join(directory,entry.name),path+'/');
   else {assert.ok(entry.isFile(),'Public export must contain regular files');if(path!=='publication-manifest.json')files.push(path);}
  }
 }
 await walk(root);
 const declared=manifest.files.map(entry=>entry.path);
 assert.deepEqual([...declared].sort(),files.sort(),'Manifest must cover every public file exactly once');
 for(const entry of manifest.files) {
  const actual=fingerprint(await readFile(join(root,entry.path)));
  assert.equal(actual.bytes,entry.published.bytes,'Published byte length differs: '+entry.path);
  assert.equal(actual.sha256,entry.published.sha256,'Published checksum differs: '+entry.path);
 }
 return files.length;
}
test('publication manifest matches every current static-export byte',async()=>{
 assert.ok(await verifyPublishedFiles(fileURLToPath(new URL('../docs/',import.meta.url)))>0);
});
async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'ml-publication-manifest-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'evidence'));
 const data={'index.html':Buffer.from('hello'),'evidence/input.json':Buffer.from('{}')};
 for(const [name,bytes] of Object.entries(data))await writeFile(join(root,name),bytes);
 const manifest={schema:'footprint-ml-public-projection/v1',files:Object.entries(data).map(([path,bytes])=>({path,published:fingerprint(bytes),originalRetainedSource:{sha256:'0'.repeat(64),bytes:999}}))};
 const save=()=>writeFile(join(root,'publication-manifest.json'),JSON.stringify(manifest));await save();return {root,manifest,save};
}
test('retained authoring-source fingerprints stay separate from public bytes',async t=>{
 const f=await fixture(t);assert.equal(await verifyPublishedFiles(f.root),2);
});
test('same-length changed public content refuses its stale checksum',async t=>{
 const f=await fixture(t);await writeFile(join(f.root,'index.html'),'jello');await assert.rejects(()=>verifyPublishedFiles(f.root),/checksum differs/);
});
test('declared published length must match independently of checksum',async t=>{
 const f=await fixture(t);f.manifest.files[0].published.bytes++;await f.save();await assert.rejects(()=>verifyPublishedFiles(f.root),/byte length differs/);
});
test('added, missing and repeated public entries cannot hide outside the census',async t=>{
 const f=await fixture(t);await writeFile(join(f.root,'new.txt'),'new');await assert.rejects(()=>verifyPublishedFiles(f.root),/every public file/);
 await rm(join(f.root,'new.txt'));f.manifest.files.push(f.manifest.files[0]);await f.save();await assert.rejects(()=>verifyPublishedFiles(f.root),/every public file/);
 f.manifest.files.pop();await f.save();await rm(join(f.root,'index.html'));await assert.rejects(()=>verifyPublishedFiles(f.root),/every public file/);
});
