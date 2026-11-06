import hashlib,importlib.util,json,tempfile,unittest
from pathlib import Path
SPEC=importlib.util.spec_from_file_location('ml_public_verify',Path(__file__).with_name('verify.py'))
MODULE=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(MODULE)
class PublicVerificationTests(unittest.TestCase):
 def check(self,case):
  temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);base=Path(temp.name);candidate=base/'candidate';candidate.mkdir()
  version='0.6.0-beta.14';sha='a'*40;names=['footprintjs-ml-'+version+'.tgz','footprintjs_ml-0.6.0b14-py3-none-any.whl','source-manifest.json','verification.json','release-notes.md']
  payload={n:('retained '+n+'\n').encode() for n in names}
  files=[]
  for n,b in payload.items():
   (candidate/n).write_bytes(b);files.append({'file':n,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
  binding={'version':version,'sha':sha,'tree':'b'*40,'files':files,'producer':{'run':91,'runNumber':1,'attempt':1}}
  release={'id':201,'tag_name':'v'+version,'draft':False,'prerelease':True,'target_commitish':sha,'body':payload['release-notes.md'].decode()}
  tag={'object':{'type':'commit','sha':sha}}
  assets=[{'id':1000+i,'name':f['file'],'state':'uploaded','size':f['bytes'],'digest':'sha256:'+f['sha256']} for i,f in enumerate(files[:-1])]
  if case=='wrong-tag':tag['object']['sha']='c'*40
  if case=='draft':release['draft']=True
  if case=='wrong-body':release['body']='changed'
  if case=='missing-asset':assets.pop()
  if case=='same-count-duplicate':assets[-1]=assets[0]
  if case=='wrong-size':assets[0]['size']+=1
  if case=='wrong-digest':assets[0]['digest']='sha256:'+'f'*64
  if case.startswith('native-integer:'):
   _,target,key,variant=case.split(':')
   obj={'producer':binding['producer'],'asset':assets[0],'release':release}[target]
   obj[key]=True if variant=='true' else float(obj[key])
  calls=[]
  def read(route):
   if route.startswith('/git/ref'):return tag
   if route.startswith('/releases/tags'):return release
   return assets
  def download(url,limit):
   name=url.rsplit('/',1)[1];calls.append(name)
   assert url.startswith('https://github.com/footprintjs/footprintjs-ml/releases/download/v'+version+'/')
   return b'changed' if case=='wrong-bytes' else payload[name]
  result=MODULE.verify(candidate,base/'public',binding,read,download)
  return result,calls
 def test_public_whole_bytes(self):
  result,calls=self.check('positive');self.assertEqual(len(calls),4);self.assertTrue(result['passed'])
  self.assertFalse(result['signatureVerified']);self.assertFalse(result['consumerAdoptionClaimed'])
  self.assertFalse(result['publisherReturnedSuccess'])
 def test_public_native_fields_require_integers(self):
  for target,keys in [('producer',['run','runNumber','attempt']),('asset',['id','size']),('release',['id'])]:
   for key in keys:
    for variant in ['true','float']:
     case=':'.join(['native-integer',target,key,variant])
     with self.subTest(case=case):self.assertRaises(AssertionError,self.check,case)
 def test_mismatch_refuses(self):
  for case in ['wrong-tag','draft','wrong-body','missing-asset','same-count-duplicate','wrong-size','wrong-digest','wrong-bytes']:
   with self.subTest(case=case):self.assertRaises(AssertionError,self.check,case)
if __name__=='__main__':unittest.main()
