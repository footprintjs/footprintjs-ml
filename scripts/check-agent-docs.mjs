import assert from 'node:assert/strict';
import {readFile,readdir,stat,writeFile} from 'node:fs/promises';
import {resolve,join,relative,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

export const guideNames = ['README.md','QUICKSTART.md','COMPATIBILITY.md','ADAPTER.md','BACKTRACKING.md',
  'DATA-LINEAGE.md','SELECTION.md','RELEASE.md','PYTHON.md','MLFLOW.md','TESTING.md','python/README.md'];
export const featureNames = ['references','evaluation','trainer-adapter','approval','investigation','data-lineage','selection','publication'];
export const skillFiles = ['skills/footprintjs-ml/SKILL.md','skills/footprintjs-ml/agents/openai.yaml'];

/** The source/examples in this inventory are documentation, not a bundled runtime. */
export async function documentationResources(root){
  const found=new Set([...guideNames,'LICENSE','features/README.md',...featureNames.map(name=>`features/${name}/README.md`),...skillFiles]);
  for(const entry of await readdir(root,{withFileTypes:true}))if(entry.isFile()&&entry.name.endsWith('.md'))found.add(entry.name);
  const visit=async folder=>{
    for(const entry of await readdir(join(root,folder),{withFileTypes:true})){
      const file=`${folder}/${entry.name}`;
      if(entry.isDirectory())await visit(file);
      else if(entry.isFile()&&(folder.startsWith('src')?/\.ts$/.test(file):/\.(?:py|mjs|md|txt)$/.test(file)))found.add(file);
    }
  };
  await visit('src');await visit('examples');
  found.add('lens/session.mjs');found.add('lens/session.d.ts');
  for(const entry of await readdir(join(root,'python'),{withFileTypes:true}))if(entry.isFile()&&entry.name.endsWith('.py'))found.add('python/'+entry.name);
  for(const entry of await readdir(join(root,'python/footprint_ml_adapter'),{withFileTypes:true}))if(entry.isFile()&&entry.name.endsWith('.py'))found.add('python/footprint_ml_adapter/'+entry.name);
  return [...found].sort();
}

export async function checkAgentDocs(root){
  root=resolve(root);
  const resources=await documentationResources(root);
  for(const file of resources)assert((await stat(join(root,file))).isFile(),`Missing distributed guidance: ${file}`);
  const markdown=resources.filter(file=>file.endsWith('.md'));
  const resourceSet=new Set(resources),links=[];
  for(const file of markdown){
    const source=await readFile(join(root,file),'utf8');
    for(const match of source.matchAll(/\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)){
      const target=match[1]??match[2];
      if(/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target))continue;
      const pathname=decodeURIComponent(target.split('#')[0].split('?')[0]);
      if(!pathname)continue;
      const absolute=resolve(dirname(join(root,file)),pathname);
      assert(absolute===root||absolute.startsWith(root+sep),`Guide link escapes SDK: ${file} -> ${target}`);
      const resolved=relative(root,absolute).split(sep).join('/');
      assert(resourceSet.has(resolved),`Guide link is not in installed guidance: ${file} -> ${target}`);
      assert((await stat(absolute)).isFile(),`Broken guide link: ${file} -> ${target}`);
      links.push({file,target,resolved});
    }
  }
  const skill=await readFile(join(root,skillFiles[0]),'utf8');
  const frontmatter=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill);
  assert(frontmatter,'Skill frontmatter is missing');
  assert(/^name:\s*footprintjs-ml\s*$/m.test(frontmatter[1]),'Skill name must match its folder');
  assert(/^description:\s*\S.+$/m.test(frontmatter[1]),'Skill description is missing');
  assert(!/\[TODO\b|\[FIXME\b/.test(skill),'Skill still contains a scaffold placeholder');
  const metadata=await readFile(join(root,skillFiles[1]),'utf8');
  assert(/default_prompt:.*\$footprintjs-ml/.test(metadata),'Skill UI prompt does not invoke the shipped skill');
  const exports=await readFile(join(root,'src/index.ts'),'utf8');
  const rootFunctions=['artifactRef','checkpointRef','inferenceIdentity','createEvaluationReceipt','checkRelease',
    'createDataLineageReceipt','checkDataLineage','runExperiment','createSelectionReceipt','checkSelection',
    'prepareModelRelease','publishModelRelease','releaseModel'];
  for(const name of rootFunctions)assert(new RegExp(`\\b${name}\\b`).test(exports),`Guide API is no longer exported: ${name}`);
  const adapter=await readFile(join(root,'src/adapter/index.ts'),'utf8');
  assert(/\bcreatePythonTrainerAdapter\b/.test(adapter),'Documented trainer adapter is no longer exported');
  const lens=await readFile(join(root,'lens/session.d.ts'),'utf8');
  assert(/export function openWorkflowRecording\b/.test(lens),'Documented saved-recording reader is no longer exported');
  const python=await readFile(join(root,'python/footprint_ml_workflow.py'),'utf8');
  for(const name of ['WorkflowCapture','MlflowArtifacts'])assert(new RegExp(`class ${name}\\b`).test(python),`Documented Python API is missing: ${name}`);
  for(const name of ['create_evaluation_receipt','check_release'])assert(new RegExp(`def ${name}\\(`).test(python),`Documented Python contract is missing: ${name}`);
  return {schema:'footprint-ml-agent-guidance/v1',passed:true,
    checks:{skillHasIdentityAndDescription:true,skillPromptInvokesSkill:true,localGuidanceLinksResolve:true,
      guideApisExist:true,documentationResourceFilesPresent:true},
    featureCount:featureNames.length,markdownFiles:markdown.length,localLinks:links.length,
    resources,links,boundaries:['Static guidance and packaging checks do not establish agent integration quality.']};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);let output;
  if(args.length){assert.equal(args.length,2);assert.equal(args[0],'--out');output=resolve(args[1]);}
  const result=await checkAgentDocs(fileURLToPath(new URL('..',import.meta.url)));
  if(output)await writeFile(output,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({...result,resources:undefined,links:undefined},null,2));
}
