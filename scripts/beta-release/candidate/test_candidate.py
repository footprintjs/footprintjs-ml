"""Small real Git/tar/wheel fixtures; no package execution, installs or network."""
import base64,hashlib,io,json,os,subprocess,sys,tarfile,tempfile,unittest,zipfile
from pathlib import Path
GEN=Path(__file__).with_name('generate.py')
V='0.6.0-beta.14';PV='0.6.0b14'
class CandidateTests(unittest.TestCase):
 def candidate(self,case):
  temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);base=Path(temp.name);root=base/'repo';root.mkdir();out=base/'assets';out.mkdir()
  py='SDK_VERSION="'+V+'"\nPYTHON_VERSION="'+PV+'"\nFOOTPRINTJS_VERSION="11.0.0"\nAGENTFOOTPRINT_VERSION="14.0.0"\nFOOTTRACE_VERSION="1.11.1"\n'
  pkg={'name':'footprintjs-ml','version':V,'files':['dist','src','README.md','LICENSE','pyproject.toml','python/*.py'],
   'devDependencies':{'footprintjs':'11.0.0','agentfootprint':'14.0.0','foottrace':'1.11.1'}}
  if case=='wrong-cohort':py=py.replace('14.0.0','13.0.0')
  source={'package.json':json.dumps(pkg),'package-lock.json':json.dumps({'version':V,'packages':{'':{'version':'bad' if case=='wrong-lock' else V}}}),
   'README.md':'SDK guide\n','LICENSE':'MIT\n','src/index.ts':'export const value=1;\n',
   'python/footprint_ml_versions.py':py,'python/footprint_ml_workflow.py':'# inert fixture\n',
   'python/reference_worker.py':'# inspectable source, not an importable wheel module\n',
   'pyproject.toml':'[project]\nname="footprintjs-ml"\nversion="'+PV+'"\nrequires-python=">=3.11"\ndependencies=[]\n[tool.setuptools]\npy-modules=["footprint_ml_versions","footprint_ml_workflow"]\n[tool.setuptools.data-files]\n"share/footprintjs-ml"=["README.md"]\n"share/footprintjs-ml/python"=["python/reference_worker.py"]\n',
   'release-notes/'+V+'.md':'Real separately reviewed SDK reason.\n'}
  for name,text in source.items():
   p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)
  def git(*args):return subprocess.check_output(['git','-C',str(root),*args],stderr=subprocess.DEVNULL).decode().strip()
  git('init','-q');git('add','.')
  git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','inert source fixture')
  sha=git('rev-parse','HEAD')
  dist={'dist/index.js':b'export const value=1;\n','dist/index.d.ts':b'export declare const value=1;\n'}
  for name,data in dist.items():p=root/name;p.parent.mkdir(exist_ok=True);p.write_bytes(data)
  npm={name:txt.encode() for name,txt in source.items() if name not in ('package-lock.json','release-notes/'+V+'.md')};npm.update(dist)
  if case=='missing-npm':npm.pop('src/index.ts')
  if case=='changed-npm':npm['README.md']=b'foreign'
  archive=out/('footprintjs-ml-'+V+'.tgz')
  with tarfile.open(archive,'w:gz') as t:
   for name,data in npm.items():
    info=tarfile.TarInfo('package/'+name);info.size=len(data);info.mode=0o644;t.addfile(info,io.BytesIO(data))
   if case in ('duplicate-tar','alias-tar','unsafe-tar','linked-tar'):
    name={'duplicate-tar':'package/README.md','alias-tar':'package/./README.md','unsafe-tar':'../escape','linked-tar':'package/link'}[case]
    info=tarfile.TarInfo(name);info.size=0
    if case=='linked-tar':info.type=tarfile.SYMTYPE;info.linkname='README.md'
    t.addfile(info,io.BytesIO())
  d='footprintjs_ml-'+PV+'.dist-info/';prefix='footprintjs_ml-'+PV+'.data/data/share/footprintjs-ml/'
  files={'footprint_ml_versions.py':py.encode(),'footprint_ml_workflow.py':b'# inert fixture\n',prefix+'README.md':b'SDK guide\n',
   d+'METADATA':('Metadata-Version: 2.4\nName: footprintjs-ml\nVersion: '+('0.6.0b13' if case=='wrong-wheel-version' else PV)+'\nRequires-Python: >=3.11\n'+('Requires-Dist: injected\n' if case=='runtime-dep' else '')).encode(),
   prefix+'python/reference_worker.py':b'# inspectable source, not an importable wheel module\n',
   d+'WHEEL':b'Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
   d+'top_level.txt':b'footprint_ml_versions\nfootprint_ml_workflow\n',d+'licenses/LICENSE':b'MIT\n'}
  formats={'wheel-format-future':b'2.0','wheel-format-minor':b'1.1','wheel-format-malformed':b'v1.0'}
  if case in formats:files[d+'WHEEL']=files[d+'WHEEL'].replace(b'1.0',formats[case],1)
  if case=='wheel-format-missing':files[d+'WHEEL']=files[d+'WHEEL'].replace(b'Wheel-Version: 1.0\n',b'')
  if case=='wheel-format-duplicate':files[d+'WHEEL']=b'Wheel-Version: 2.0\n'+files[d+'WHEEL']
  if case=='missing-module':files.pop('footprint_ml_workflow.py')
  if case=='missing-resource':files.pop(prefix+'README.md')
  if case=='wheel-hook':files['injected.pth']=b'import side_effect\n'
  record=[]
  for name,data in files.items():
   digest=base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip('=')
   record.append(name+',sha256='+digest+','+str(len(data))+'\n')
  if case=='bad-record':record[0]=record[0].replace('sha256=','sha256=wrong')
  record.append(d+'RECORD,,\n');files[d+'RECORD']=''.join(record).encode()
  with zipfile.ZipFile(out/('footprintjs_ml-'+PV+'-py3-none-any.whl'),'w') as z:
   for name,data in files.items():z.writestr(name,data)
   if case=='duplicate-wheel':z.writestr('footprint_ml_versions.py',py)
  admission={'sha':sha,'version':V,'runId':91,'runNumber':1,'attempt':1,'allowed':True,'mode':'first-attempt',
    'sourceCI':{'id':73,'attempt':1,'headSha':sha,'conclusion':'success','jobs':[{}]*5}}
  if case.startswith('native-integer:'):
   _,target,key,variant=case.split(':');obj=admission['sourceCI'] if target=='ci' else admission
   obj[key]=True if variant=='true' else float(obj[key])
  ap=base/'admission.json';ap.write_text(json.dumps(admission))
  env={k:v for k,v in os.environ.items() if k in ('PATH','LANG','LC_ALL')}
  env.update(GITHUB_REPOSITORY='footprintjs/footprintjs-ml',GITHUB_RUN_ID='91',GITHUB_RUN_ATTEMPT='1',GITHUB_RUN_NUMBER='1',GITHUB_SHA=sha,GITHUB_WORKFLOW_REF='footprintjs/footprintjs-ml/.github/workflows/publish.yml@refs/heads/main')
  result=subprocess.run([sys.executable,'-I',str(GEN),str(root),str(out),sha,str(ap)],env=env,capture_output=True,text=True,timeout=10)
  return result,out
 def test_complete_candidate(self):
  r,out=self.candidate('positive');self.assertEqual(r.returncode,0,r.stderr)
  proof=json.loads((out/'verification.json').read_text());self.assertTrue(proof['passed'])
  self.assertEqual(proof['producer']['attempt'],1);self.assertEqual(proof['wheel']['requiresDist'],[])
 def test_admission_native_fields_require_integers(self):
  for target,keys in [('admission',['runId','runNumber','attempt']),('ci',['id','attempt'])]:
   for key in keys:
    for variant in ['true','float']:
     case=':'.join(['native-integer',target,key,variant])
     with self.subTest(case=case):
      result,_=self.candidate(case);self.assertNotEqual(result.returncode,0)
 def test_wheel_format_is_supported(self):
  good,_=self.candidate('positive');self.assertEqual(good.returncode,0,good.stderr)
  for case in ['wheel-format-future','wheel-format-minor','wheel-format-missing','wheel-format-malformed','wheel-format-duplicate']:
   with self.subTest(case=case):
    bad,_=self.candidate(case);self.assertNotEqual(bad.returncode,0)
 def test_changed_or_unsafe_candidate_refused(self):
  for case in ['wrong-cohort','wrong-lock','missing-npm','changed-npm','duplicate-tar','alias-tar','unsafe-tar','linked-tar',
   'wrong-wheel-version','runtime-dep','missing-module','missing-resource','wheel-hook','bad-record','duplicate-wheel']:
   with self.subTest(case=case):
    r,_=self.candidate(case);self.assertNotEqual(r.returncode,0)
if __name__=='__main__':unittest.main()
