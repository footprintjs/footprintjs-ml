import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import * as modules from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const root=fileURLToPath(new URL('..',import.meta.url));
const pkg=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
assert.deepEqual(pkg.dependencies??{},{});
assert.deepEqual(pkg.optionalDependencies??{},{});
const source=String.raw`
import importlib.abc,json,subprocess,sys,tempfile
from pathlib import Path
blocked=[]
forbidden={'numpy','mlflow','sklearn','jax','torch','footprint_ml_adapter'}
class Block(importlib.abc.MetaPathFinder):
    def find_spec(self,fullname,path=None,target=None):
        if fullname.split('.')[0] in forbidden:
            blocked.append(fullname)
            raise AssertionError('Unexpected dependency import: '+fullname)
sys.meta_path.insert(0,Block())
sys.path.insert(0,sys.argv[1])
original=subprocess.Popen
def no_spawn(*args,**kwargs):raise AssertionError('Import or constructor started a process')
subprocess.Popen=no_spawn
try:
    import footprint_ml_workflow,footprint_ml_promotion
    with tempfile.TemporaryDirectory() as tmp:
        capture=footprint_ml_workflow.WorkflowCapture(Path(tmp)/'unused.json')
        binding=footprint_ml_workflow.MlflowArtifacts(object(),Path(tmp)/'cache')
        publisher=footprint_ml_promotion.MlflowModelPublisher(object(),store_root=Path(tmp)/'store',journal_dir=Path(tmp)/'journal',registry_id='lazy',model_name='model',alias='champion',binding={'version':'1','runId':'lazy-run','source':'runs:/lazy-run/model','artifactPath':'model/bundle.json'})
        assert not (Path(tmp)/'journal').exists()
finally:subprocess.Popen=original
loaded=sorted(name for name in sys.modules if name.split('.')[0] in forbidden)
assert not blocked and not loaded
print(json.dumps(dict(isolatedPython=True,sitePackagesEnabled=False,blockedImports=blocked,thirdPartyLoaded=loaded,constructorsStartedNoProcess=True)))
`;
const result=spawnSync(process.env.PYTHON??'python3',['-I','-S','-c',source,resolve(root,'python')],
  {encoding:'utf8',timeout:10000,maxBuffer:128*1024});
assert.equal(result.status,0,result.stderr||String(result.error));
const python=JSON.parse(result.stdout);
const loaded=[];
assert.equal(typeof modules.registerHooks,'function','Run this import-graph check on Node 24.');
const hook=modules.registerHooks({load(url,context,next){loaded.push(url);return next(url,context);}});
try{
  const adapter=await import('footprintjs-ml/adapter');
  assert.equal(typeof adapter.servePythonCapture,'function');
  assert(!loaded.some(url=>/\/node_modules\/foottrace\//.test(url)));
}finally{hook.deregister();}
const requirements=(await readFile(resolve(root,'examples/mlflow/requirements.txt'),'utf8')).split(/\r?\n/).filter(line=>line&&!line.startsWith('#'));
const report={schema:'footprint-ml-optional-dependencies/v1',passed:true,version:pkg.version,
  checks:{coreRuntimeDependenciesZero:true,automaticOptionalDependenciesZero:true,
    pythonCaptureStdlibOnly:true,captureImportDoesNotStartProcess:true,adapterImportDoesNotLoadFoottrace:true},
  core:{dependencies:pkg.dependencies??{},optionalDependencies:pkg.optionalDependencies??{}},python,
  optionalRecordingHost:{node:'22+',foottrace:'explicit host installation; loaded only when serving capture'},
  exampleOnly:{requirements,installedAutomaticallyBySdk:false},
  limits:['Injected MLflow clients and numerical frameworks keep their own dependencies.',
    'Python orchestration still requires an explicitly started Node recording helper for this integration.']};
const args=process.argv.slice(2);
if(args.length){assert.equal(args.length,2);assert.equal(args[0],'--out');await writeFile(resolve(args[1]),JSON.stringify(report,null,2)+'\n',{flag:'wx'});}
console.log(JSON.stringify(report,null,2));
