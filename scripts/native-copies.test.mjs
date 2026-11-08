import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,rename,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {inspectNativeCopies} from './native-copies.mjs';
const pins={footprintjs:'11.0.0',agentfootprint:'14.0.0',foottrace:'1.11.1'};
const ambiguous='Native census encountered an ambiguous module-container spelling';
async function lookupModules(dir) {
 try {return await realpath(join(dir,'node_modules'));}
 catch(error) {if(error.code!=='ENOENT')throw error;return null;}
}
async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'ml-native-copies-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 async function pkg(path,name,version=pins[name]) {
  const dir=join(root,'node_modules',path);await mkdir(dir,{recursive:true});
  await writeFile(join(dir,'package.json'),JSON.stringify({name,version,scripts:{postinstall:'node must-not-run.js'}}));
  await writeFile(join(dir,'must-not-run.js'),"throw Error('Package code must not execute');\n");return dir;
 }
 for(const name of Object.keys(pins))await pkg(name,name);
 return {root,pkg,mods:join(root,'node_modules')};
}
test('canonical physical identities pass without package execution',async t=>{
 const f=await fixture(t);assert.deepEqual(await inspectNativeCopies(f.root,pins),pins);
});
for(const path of ['second-record','@scope/alias','parent/node_modules/record','.cache/record','.bin','.bin/hidden/node_modules/record','parent/vendor/node_modules/record'])
 test('refuse a second native identity at '+path,async t=>{
  const f=await fixture(t);
  if(path.startsWith('parent/'))await f.pkg('parent','unrelated','1.0.0');
  await f.pkg(path,'foottrace');
  await assert.rejects(()=>inspectNativeCopies(f.root,pins),/one physical foottrace/);
 });
test('opaque container manifests cannot hide nested copies',async t=>{
 const f=await fixture(t);await f.pkg('.bin','unrelated','1.0.0');
 await f.pkg('.bin/hidden/node_modules/other','foottrace');
 await assert.rejects(()=>inspectNativeCopies(f.root,pins),/one physical foottrace/);
});
test('one aliased identity is found from its manifest, not basename',async t=>{
 const f=await fixture(t);await rename(join(f.mods,'foottrace'),join(f.mods,'second-record'));
 assert.deepEqual(await inspectNativeCopies(f.root,pins),pins);
});
test('same physical directory aliases and cycles are finite and deduplicated',async t=>{
 const f=await fixture(t);await symlink('foottrace',join(f.mods,'second-record'));
 await symlink('.',join(f.mods,'.cycle'));assert.deepEqual(await inspectNativeCopies(f.root,pins),pins);
});
test('ordinary executable links in .bin are not package owners',async t=>{
 const f=await fixture(t);await mkdir(join(f.mods,'.bin'));await symlink('../foottrace/must-not-run.js',join(f.mods,'.bin/tool'));
 assert.deepEqual(await inspectNativeCopies(f.root,pins),pins);
});
for(const content of ['{bad','null','{}','{"name":7}'])test('unknown manifest refuses '+content,async t=>{
 const f=await fixture(t);await mkdir(join(f.mods,'unknown'));await writeFile(join(f.mods,'unknown/package.json'),content);
 await assert.rejects(()=>inspectNativeCopies(f.root,pins));
});
test('broken manifest and directory links refuse incomplete census',async t=>{
 const f=await fixture(t);await mkdir(join(f.mods,'unknown'));await symlink('missing.json',join(f.mods,'unknown/package.json'));
 await assert.rejects(()=>inspectNativeCopies(f.root,pins));
 await rm(join(f.mods,'unknown'),{recursive:true});await symlink('missing-directory',join(f.mods,'unknown'));
 await assert.rejects(()=>inspectNativeCopies(f.root,pins));
});
test('external directory links refuse rather than traverse an unbounded root',async t=>{
 const f=await fixture(t);await symlink(tmpdir(),join(f.mods,'outside'));
 await assert.rejects(()=>inspectNativeCopies(f.root,pins),/external directory link/);
});
test('missing identity and wrong version refuse',async t=>{
 const f=await fixture(t);await rm(join(f.mods,'foottrace'),{recursive:true});
 await assert.rejects(()=>inspectNativeCopies(f.root,pins),/one physical foottrace/);
 await f.pkg('foottrace','foottrace','1.8.0');await assert.rejects(()=>inspectNativeCopies(f.root,pins),/version differs/);
});
for(const duplicate of ['second-record','parent/NODE_MODULES/foottrace','parent/node_moduleſ/foottrace'])
test('CLI adapter refuses duplicate '+duplicate,async t=>{
 const f=await fixture(t),cli=new URL('./native-copies-cli.mjs',import.meta.url);
 const args=[cli.pathname,f.root,JSON.stringify(pins)];
 assert.deepEqual(JSON.parse(execFileSync(process.execPath,args,{encoding:'utf8'})),pins);
 await f.pkg('parent','unrelated','1.0.0');
 await f.pkg(duplicate,'foottrace');
 const check=()=>execFileSync(process.execPath,args,{encoding:'utf8',stdio:'pipe'});
 if(duplicate==='second-record'||await lookupModules(join(f.mods,'parent')))assert.throws(check);
 else assert.deepEqual(JSON.parse(check()),pins);
});

for(const duplicate of ['second-record','parent/Node_Modules/foottrace','parent/NODE_MODULEſ/foottrace'])
test('actual Python smoke guard refuses duplicate '+duplicate,async t=>{
 const f=await fixture(t),path=new URL('./python-install-smoke.py',import.meta.url).pathname;
 const source=readFileSync(path,'utf8'),start=source.indexOf('        node = shutil.which');
 const stop=source.indexOf('        for name, expected in guidance_bytes.items():',start);
 assert.ok(start>=0&&stop>start);
 const block=source.slice(start,stop).replace(/^        /gm,'');
 const code=`import json,shutil,subprocess
from pathlib import Path
__file__=${JSON.stringify(path)}
runtime=Path(${JSON.stringify(f.root)})
imported={'nativePins':${JSON.stringify(pins)}}
def run(exe,args,cwd):return subprocess.check_output([str(exe),*map(str,args)],cwd=cwd,text=True)
${block}
print(json.dumps(observed_native))
`;
 const options={encoding:'utf8',stdio:'pipe',env:{...process.env,PATH:dirname(process.execPath)+':'+process.env.PATH}};
 assert.deepEqual(JSON.parse(execFileSync(process.env.PYTHON||'python3',['-I','-c',code],options)),pins);
 await f.pkg('parent','unrelated','1.0.0');
 await f.pkg(duplicate,'foottrace');
 const check=()=>execFileSync(process.env.PYTHON||'python3',['-I','-c',code],options);
 if(duplicate==='second-record'||await lookupModules(join(f.mods,'parent')))assert.throws(check);
 else assert.deepEqual(JSON.parse(check()),pins);
});

for(const path of ['', '@scope', 'parent/node_modules'])
 for(const content of ['{"name":"unrelated","version":"1.0.0"}', 'null'])
 test('container-role manifest refuses '+path+' '+content,async t=>{
  const f=await fixture(t);
  if(path.startsWith('parent/'))await f.pkg('parent','unrelated','1.0.0');
  const dir=join(f.mods,path);await mkdir(dir,{recursive:true});
  await writeFile(join(dir,'package.json'),content);
  if(path==='@scope')await f.pkg('@scope/second-record','foottrace');
  await assert.rejects(()=>inspectNativeCopies(f.root,pins));
 });
test('reserved node_modules identity refuses instead of disappearing',async t=>{
 const f=await fixture(t);await f.pkg('node_modules','foottrace');
 await assert.rejects(()=>inspectNativeCopies(f.root,pins));
});
test('broken manifest links on scope containers refuse',async t=>{
 const f=await fixture(t);await mkdir(join(f.mods,'@scope'));
 await symlink('missing.json',join(f.mods,'@scope/package.json'));
 await assert.rejects(()=>inspectNativeCopies(f.root,pins));
});
test('a singleton scoped alias remains an installed package',async t=>{
 const f=await fixture(t);await rm(join(f.mods,'foottrace'),{recursive:true});
 await f.pkg('@scope/second-record','foottrace');
 assert.deepEqual(await inspectNativeCopies(f.root,pins),pins);
});

for(const spelling of ['NODE_MODULES','Node_Modules','nOdE_mOdUlEs','node_moduleſ','NODE_MODULEſ'])
 test('refuse a folded module container '+spelling,async t=>{
  const f=await fixture(t);await f.pkg('parent','unrelated','1.0.0');
  const nested=await f.pkg('parent/'+spelling+'/foottrace','foottrace');
  // Resolve only a JSON path; fixture package code is never loaded.
  const require=createRequire(join(f.mods,'parent/probe.cjs'));
  const resolved=await realpath(require.resolve('foottrace/package.json'));
  const folded=await lookupModules(join(f.mods,'parent'))===await realpath(join(f.mods,'parent',spelling));
  assert.equal(resolved,await realpath(join(folded?nested:join(f.mods,'foottrace'),'package.json')));
  t.diagnostic('actual Node lowercase lookup reaches folded container: '+folded);
  if(folded)await assert.rejects(()=>inspectNativeCopies(f.root,pins),{message:ambiguous});
  else assert.deepEqual(await inspectNativeCopies(f.root,pins),pins);
 });
for(const [parent,spelling,alias] of [['parent/vendor','NODE_MODULES','@scope/alias'],['.cache','Node_Modules','alias']])
 test('folded module-container payload policy '+parent,async t=>{
  const f=await fixture(t);await f.pkg('parent','unrelated','1.0.0');
  await f.pkg([parent,spelling,alias].join('/'),'foottrace');
  const containerParent=join(f.mods,parent);
  if(await lookupModules(containerParent))await assert.rejects(()=>inspectNativeCopies(f.root,pins),{message:ambiguous});
  else if(parent==='.cache')await assert.rejects(()=>inspectNativeCopies(f.root,pins),/one physical foottrace/);
  else assert.deepEqual(await inspectNativeCopies(f.root,pins),pins);
 });
