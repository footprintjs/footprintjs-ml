/** Inspect installed identities as data; never import a package or execute its scripts. */
import assert from 'node:assert/strict';
import {readFile,readdir,realpath,stat,lstat} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
const names=['footprintjs','agentfootprint','foottrace'];
export async function inspectNativeCopies(root,expected) {
 assert.deepEqual(Object.keys(expected).sort(),[...names].sort(),'Expected the closed native cohort');
 for(const name of names)assert.match(expected[name],/^\d+\.\d+\.\d+$/,'Expected exact native versions');
 const base=await realpath(join(root,'node_modules'));
 const owners=new Map(names.map(name=>[name,new Map()])),visited=new Map();
 async function visit(path,kind) {
  const actual=await realpath(path);
  if(!(await stat(actual)).isDirectory())return;
  const local=relative(base,actual);
  assert(!isAbsolute(local)&&local!=='..'&&!local.startsWith('../')&&!local.startsWith('..\\'),
   'Native census encountered an external directory link');
  let manifest,hasManifest=false;
  if(kind==='candidate') {
   const file=join(actual,'package.json');
   try {manifest=JSON.parse(await readFile(file,'utf8'));hasManifest=true;}
   catch(error) {
    if(error.code!=='ENOENT')throw Error('Native census cannot read a package manifest');
    let entry;try {entry=await lstat(file);}catch(missing) {if(missing.code!=='ENOENT')throw missing;}
    assert(!entry,'Native census encountered an unreadable manifest link');
   }
   if(hasManifest) {
    assert(manifest&&typeof manifest==='object'&&!Array.isArray(manifest)&&typeof manifest.name==='string'&&manifest.name,
     'Native census encountered an unknown package identity');
    if(owners.has(manifest.name)) {
     assert.equal(typeof manifest.version,'string','Native package version is unknown');
     owners.get(manifest.name).set(actual,manifest.version);
    }
   }
  }
  const modes=visited.get(actual)||new Set();
  if(modes.has(kind))return;
  modes.add(kind);visited.set(actual,modes);
  assert(visited.size<=100000,'Native census directory limit exceeded');
  // Search payload directories for nested installations too. A payload manifest
  // alone is data; a package-position manifest is an installed identity.
  for(const entry of await readdir(actual,{withFileTypes:true})) {
   if(!entry.isDirectory()&&!entry.isSymbolicLink())continue;
   const childKind=entry.name==='node_modules'?'modules':
    kind==='modules'||(kind==='candidate'&&!hasManifest)?'candidate':'payload';
   await visit(join(actual,entry.name),childKind);
  }
 }
 await visit(base,'modules');
 const versions={};
 for(const name of names) {
  const copies=owners.get(name);
  assert.equal(copies.size,1,`Expected one physical ${name} installation`);
  const version=copies.values().next().value;
  assert.equal(version,expected[name],`Installed ${name} version differs`);versions[name]=version;
 }
 return versions;
}
