import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {checkAgentDocs,documentationResources} from './check-agent-docs.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const args=process.argv.slice(2),options={python:process.env.PYTHON||'python3',out:'python-dist'};
for(let i=0;i<args.length;i+=2){
  if(!['--python','--out','--report'].includes(args[i])||!args[i+1])
    throw new Error('Use build-python.mjs [--python PYTHON] [--out DIRECTORY] [--report FILE].');
  options[args[i].slice(2)]=args[i+1];
}
const run=(inputArgs)=>{
  try{return execFileSync(options.python,inputArgs,{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024,timeout:180_000});}
  catch(error){throw new Error(`Python wheel build failed:\n${error.stdout||''}\n${error.stderr||error.message}`);}
};
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const project=JSON.parse(run(['-I','-c',
  'import json,pathlib,tomllib; p=tomllib.loads(pathlib.Path("pyproject.toml").read_text()); print(json.dumps({"project":p["project"],"buildSystem":p["build-system"]}))']));
const matched=/^(\d+\.\d+\.\d+)(?:-(alpha|beta|rc)\.(\d+))?$/.exec(pkg.version);
if(!matched)throw new Error(`Unsupported npm version mapping: ${pkg.version}`);
const pythonVersion=matched[1]+(matched[2]?({alpha:'a',beta:'b',rc:'rc'}[matched[2]]+matched[3]):'');
if(project.project.name!==pkg.name||project.project.version!==pythonVersion)
  throw new Error(`Version mismatch: npm ${pkg.name}@${pkg.version} requires Python ${pkg.name}==${pythonVersion}; pyproject declares ${project.project.name}==${project.project.version}.`);
const constants=JSON.parse(run(['-I','-c',
  'import json,runpy; v=runpy.run_path("python/footprint_ml_versions.py"); print(json.dumps({"sdk":v["SDK_VERSION"],"python":v["PYTHON_VERSION"]}))']));
if(constants.sdk!==pkg.version||constants.python!==pythonVersion)
  throw new Error(`Version mismatch in footprint_ml_versions: expected SDK ${pkg.version} and Python ${pythonVersion}.`);
if(project.buildSystem['build-backend']!=='setuptools.build_meta')throw new Error('Expected the standard setuptools.build_meta backend.');
const guidance=await checkAgentDocs(root);
const resourceHashes=await Promise.all((await documentationResources(root)).map(async file=>({file,sha256:createHash('sha256').update(await readFile(join(root,file))).digest('hex')})));
const out=resolve(root,options.out);await mkdir(out,{recursive:true});
const buildOutput=run(['-m','pip','wheel','--no-deps','--no-build-isolation','.', '--wheel-dir',out]);
const candidates=(await readdir(out)).filter(name=>name.startsWith(`footprintjs_ml-${pythonVersion}-`)&&name.endsWith('.whl'));
if(candidates.length!==1)throw new Error(`Expected one ${pythonVersion} wheel, found ${candidates.length}.`);
const wheel=join(out,candidates[0]);
const validation=JSON.parse(run(['-I','-c',String.raw`
import email,hashlib,json,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    names=archive.namelist()
    metadata_files=[name for name in names if name.endswith('.dist-info/METADATA')]
    assert len(metadata_files)==1, 'Expected one METADATA file'
    metadata=email.message_from_bytes(archive.read(metadata_files[0]))
    required=['footprint_ml_workflow.py','footprint_ml_setup.py','footprint_ml_versions.py','footprint_ml_adapter/__init__.py']
    assert all(name in names for name in required), 'Missing public Python module'
    assert metadata['Name']=='footprintjs-ml', 'Unexpected Python distribution name'
    assert metadata['Version']==sys.argv[2], 'Unexpected Python distribution version'
    assert not metadata.get_all('Requires-Dist'), 'Python wheel must not install runtime dependencies'
    assert not any('/node_modules/' in name or name.startswith('dist/') or '/share/footprintjs-ml/dist/' in name for name in names), 'Native compiled runtime must be installed explicitly'
    prefix='footprintjs_ml-'+sys.argv[2]+'.data/data/share/footprintjs-ml/'
    resources=json.loads(sys.argv[3])
    for resource in resources:
        name=prefix+resource['file']
        assert name in names, 'Missing installed agent guidance resource: '+resource['file']
        assert hashlib.sha256(archive.read(name)).hexdigest()==resource['sha256'], 'Guidance source bytes differ: '+resource['file']
    examples_js=any(name.startswith(prefix+'examples/') and name.endswith('.mjs') for name in names)
    assert examples_js, 'Inspectable example source is missing'
    print(json.dumps({'name':metadata['Name'],'version':metadata['Version'],'requiresPython':metadata['Requires-Python'],
        'requiresDist':metadata.get_all('Requires-Dist',[]),'requiredModulesPresent':True,'nativeRuntimeBundled':False,
        'documentationExamplesJs':examples_js,'guidanceResourcesMatchSource':len(resources),'files':len(names)}))
`,wheel,pythonVersion,JSON.stringify(resourceHashes)]));
const bytes=await readFile(wheel);
const report={schema:'footprint-ml-python-wheel-build/v1',passed:true,npmVersion:pkg.version,pythonVersion,
  backend:'setuptools.build_meta',buildIsolation:false,
  guidance:{featureCount:guidance.featureCount,markdownFiles:guidance.markdownFiles,localLinks:guidance.localLinks},
  wheel:{file:candidates[0],path:wheel,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},validation};
const reportPath=options.report?resolve(root,options.report):join(out,'python-build.json');
await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
console.log(buildOutput.trim());console.log(JSON.stringify(report,null,2));
