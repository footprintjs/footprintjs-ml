"""Execute the reviewed workflow's literal publisher with a finite offline transport."""
import hashlib,json,os,subprocess,tempfile,textwrap,unittest,zipfile
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
class PublisherTests(unittest.TestCase):
 def run_case(self,case,previous=None):
  t=tempfile.TemporaryDirectory();self.addCleanup(t.cleanup);base=Path(t.name);work=base/'work';work.mkdir();bin=base/'bin';bin.mkdir()
  (bin/'curl').symlink_to(HERE/'fake_curl.py')
  source='a'*40;tree='b'*40;run=92 if previous else 91;number=2 if case.startswith(('prior-','earlier-','bad-title','history-gap')) else 1;version='0.6.0-beta.14'
  producer={'repository':'footprintjs/footprintjs-ml','workflow':'.github/workflows/publish.yml','sha':source,'run':run,'runNumber':number,'attempt':1}
  payloads={'footprintjs-ml-'+version+'.tgz':b'reviewed npm bytes','footprintjs_ml-0.6.0b14-py3-none-any.whl':b'reviewed wheel bytes',
   'source-manifest.json':json.dumps({'commit':source,'tree':tree}).encode(),
   'verification.json':json.dumps({'commit':source,'tree':tree,'producer':producer,'hosted':{'id':73,'attempt':1}}).encode(),'release-notes.md':b'Reviewed SDK release reason.\n'}
  files=[{'file':n,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()} for n,b in payloads.items()]
  if case=='coherent-wrong-run-number':
   producer['runNumber']=number+1;verification=json.loads(payloads['verification.json']);verification['producer']['runNumber']=number+1;payloads['verification.json']=json.dumps(verification).encode()
  if case.startswith('receipt:'):
   _,target,key,variant=case.split(':');verification=json.loads(payloads['verification.json'])
   obj=producer if target=='binding-producer' else verification[target]
   if variant=='missing':obj.pop(key,None)
   else:obj[key]={'true':True,'false':False,'float':float(obj[key]),'null':None,'string':str(obj[key])}[variant]
   payloads['verification.json']=json.dumps(verification).encode()
  if case.startswith('receipt:') or case=='coherent-wrong-run-number':
   files=[{'file':n,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()} for n,b in payloads.items()]
  if case=='unsafe-member':payloads['../escape.py']=b'bad'
  if case=='changed-bytes':payloads['release-notes.md']=b'changed'
  if case=='changed-bytes-same-size':payloads['release-notes.md']=b'x'*len(payloads['release-notes.md'])
  zpath=base/'candidate.zip'
  with zipfile.ZipFile(zpath,'w') as z:
   for n,b in payloads.items():z.writestr(n,b)
  digest=hashlib.sha256(zpath.read_bytes()).hexdigest()
  state={'priorRun':previous['run'] if previous else 90,'case':case,'sha':source,'version':version,'run':run,'number':number,'digest':digest,'calls':[],'assets':[]}
  (base/'state.json').write_text(json.dumps(state))
  binding={'sha':source,'tree':tree,'version':version,'producer':producer,'ciRun':73,'ciAttempt':1,'files':files}
  workflow=getattr(self,'workflow',ROOT/'.github/workflows/publish.yml').read_text()
  glue=textwrap.dedent(workflow.split('# BEGIN PUBLISH GLUE\n',1)[1].split('          # END PUBLISH GLUE',1)[0])
  (base/'publisher.sh').write_text(glue)
  env={k:v for k,v in os.environ.items() if k in ('PATH','LANG','LC_ALL','SYSTEMROOT')}
  env.update({'PATH':str(bin)+':'+env.get('PATH',''),'FIXTURE_DIR':str(base),'RUNNER_TEMP':str(work),'GITHUB_REF':'refs/heads/main',
   'GITHUB_RUN_ATTEMPT':'1','GITHUB_RUN_ID':str(run),'GITHUB_RUN_NUMBER':str(number),'SOURCE_SHA':source,'RELEASE_VERSION':version,
   'ARTIFACT_ID':'102','ARTIFACT_DIGEST':digest,'BINDING':json.dumps(binding),'GH_TOKEN':'fixture-only-not-a-credential'})
  result=subprocess.run(['bash',str(base/'publisher.sh')],env=env,capture_output=True,text=True,timeout=30)
  state=json.loads((base/'state.json').read_text())
  self.assertNotIn('PRIVATE-FIXTURE-ERROR-NOT-FOR-LOG',result.stdout+result.stderr)
  return result,state
 def test_positive(self):
  result,state=self.run_case('positive');self.assertEqual(result.returncode,0,result.stderr)
  self.assertTrue(state['published']);self.assertEqual(len(state['assets']),4)
  self.assertEqual(sum(x['method']=='POST' for x in state['calls']),5)
  self.assertEqual(sum(x['method']=='PATCH' for x in state['calls']),1)
 def test_matching_materialized_tag(self):
  result,state=self.run_case('tag-correct');self.assertEqual(result.returncode,0,result.stderr);self.assertTrue(state['published'])
 def test_prior_skipped_permits_first_effect(self):
  result,state=self.run_case('prior-skipped');self.assertEqual(result.returncode,0,result.stderr);self.assertTrue(state['published'])
 def test_prior_dry_is_not_consumed(self):
  result,state=self.run_case('earlier-dry');self.assertEqual(result.returncode,0,result.stderr);self.assertTrue(state['published'])
 def test_zero_writes_for_refused_inputs(self):
  for case in ['rebound-artifact','moved-main','ci-changed','unsafe-member','changed-bytes','changed-bytes-same-size','history-cap','history-incomplete','same-tag-draft',
   'prior-failure','prior-unknown','prior-rerun-skipped','bad-title','history-gap']:
   with self.subTest(case=case):
    result,state=self.run_case(case);self.assertNotEqual(result.returncode,0)
    self.assertFalse(any(c['method']!='GET' for c in state['calls']))
 def test_candidate_native_run_number_matches_current_producer(self):
  bad,state=self.run_case('coherent-wrong-run-number');self.assertNotEqual(bad.returncode,0)
  self.assertFalse(any(c['method']!='GET' for c in state['calls']))
 def test_candidate_native_integers_are_not_booleans_or_floats(self):
  good,state=self.run_case('positive');self.assertEqual(good.returncode,0,good.stderr)
  for target,keys in [('producer',['run','runNumber','attempt']),('hosted',['id','attempt']),('binding-producer',['run','runNumber','attempt'])]:
   for key in keys:
    for variant in ['true','false','float','null','missing','string']:
     case=':'.join(['receipt',target,key,variant])
     with self.subTest(case=case):
      bad,state=self.run_case(case);self.assertNotEqual(bad.returncode,0)
      self.assertFalse(any(c['method']!='GET' for c in state['calls']))
 def test_unknown_postwrite_shapes_stop_at_prior_count(self):
  for case,posts in [('field:created:assets:missing',1),('field:created:assets:null',1),
   ('field:created:assets:object',1),('field:final-array:shape:object',5)]:
   with self.subTest(case=case):
    result,state=self.run_case(case);self.assertNotEqual(result.returncode,0)
    self.assertEqual(sum(c['method']=='POST' for c in state['calls']),posts)
    self.assertEqual(sum(c['method']=='PATCH' for c in state['calls']),0)
 def test_typed_native_fields_before_writes(self):
  rows=[('field','release-row','tag_name'),('prior-field','prior-run','head_sha'),
   ('prior-field','prior-run','status'),('prior-field','prior-job','name'),
   ('prior-field','prior-job','status'),('prior-field','prior-job','conclusion'),
   ('field','ci','head_sha'),('field','ci','status'),('field','ci','conclusion'),
   ('field','artifact','name')]
  for prefix,location,field in rows:
   for variant in ['missing','null','number']:
    case=':'.join([prefix,location,field,variant])
    with self.subTest(case=case):
     result,state=self.run_case(case);self.assertNotEqual(result.returncode,0)
     self.assertFalse(any(c['method']!='GET' for c in state['calls']))
 def test_release_census_identity(self):
  good,state=self.run_case('release-pages-unique');self.assertEqual(good.returncode,0,good.stderr)
  for case in ['release-pages-duplicate','release-pages-missing-id','release-pages-oversized']:
   with self.subTest(case=case):
    bad,state=self.run_case(case);self.assertNotEqual(bad.returncode,0)
    self.assertFalse(any(c['method']!='GET' for c in state['calls']))
 def test_complete_unique_job_census(self):
  good,state=self.run_case('prior-pages-skipped');self.assertEqual(good.returncode,0,good.stderr)
  for case in ['prior-pages-duplicate','prior-pages-missing-id','prior-pages-wrong-run','prior-pages-missing-run','prior-pages-started','prior-pages-oversized']:
   with self.subTest(case=case):
    bad,state=self.run_case(case);self.assertNotEqual(bad.returncode,0)
    self.assertFalse(any(c['method']!='GET' for c in state['calls']))
 def test_stop_after_unknown_or_failed_write(self):
  for case,posts,patches in [('create-unknown',1,0),('create-wrong-id',1,0),('create-wrong-source',1,0),('upload-2-fail',3,0),
   ('upload-2-unknown',3,0),('upload-wrong-digest',2,0),('final-renamed',5,0),('tag-moved',5,0),('undraft-unknown',5,1)]:
   with self.subTest(case=case):
    result,state=self.run_case(case);self.assertNotEqual(result.returncode,0)
    self.assertEqual(sum(c['method']=='POST' for c in state['calls']),posts)
    self.assertEqual(sum(c['method']=='PATCH' for c in state['calls']),patches)
 def test_two_run_unknown_never_retries(self):
  for kind in ['create-unknown','upload-2-unknown','undraft-unknown']:
   with self.subTest(kind=kind):
    first,state=self.run_case(kind);self.assertNotEqual(first.returncode,0);self.assertTrue(state['created'])
    second,next_state=self.run_case('prior-failure',previous=state);self.assertNotEqual(second.returncode,0)
    self.assertNotEqual(state['run'],next_state['run'])
    self.assertTrue(any(c['path'].endswith('/actions/runs/'+str(state['run'])+'/jobs') for c in next_state['calls']))
    self.assertFalse(any(c['method']!='GET' for c in next_state['calls']))
if __name__=='__main__':unittest.main()
