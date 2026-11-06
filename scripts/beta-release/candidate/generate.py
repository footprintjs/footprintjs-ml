"""Generate the four release assets only in the admitted native build context."""
import hashlib,json,os,re,sys
from pathlib import Path
if not __debug__:raise RuntimeError('non-optimized interpreter required')
sys.path.insert(0,str(Path(__file__).resolve().parent))
from inspect_release import inspect_candidate
root,out,commit,admission_file=Path(sys.argv[1]),Path(sys.argv[2]),sys.argv[3],Path(sys.argv[4])
a=json.loads(admission_file.read_text())
assert a['allowed'] is True and a['mode']=='first-attempt' and a['sha']==commit
assert os.environ['GITHUB_WORKFLOW_REF']=='footprintjs/footprintjs-ml/.github/workflows/publish.yml@refs/heads/main'
assert os.environ['GITHUB_REPOSITORY']=='footprintjs/footprintjs-ml' and os.environ['GITHUB_SHA']==commit
producer={'repository':os.environ['GITHUB_REPOSITORY'],'sha':commit,'workflow':'.github/workflows/publish.yml',
    'run':int(os.environ['GITHUB_RUN_ID']),'runNumber':int(os.environ['GITHUB_RUN_NUMBER']),'attempt':int(os.environ['GITHUB_RUN_ATTEMPT'])}
assert producer['run']==a['runId'] and producer['runNumber']==a['runNumber'] and producer['attempt']==a['attempt']==1
version=json.loads((root/'package.json').read_text())['version']
assert version==a['version'] and re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)',version)
pv=version.replace('-beta.','b')
archive=out/('footprintjs-ml-'+version+'.tgz');wheel=out/('footprintjs_ml-'+pv+'-py3-none-any.whl')
result=inspect_candidate(root,archive,wheel,commit)
def receipt(path):
    data=path.read_bytes();return {'file':path.name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
manifest=out/'source-manifest.json';assert not manifest.exists()
manifest.write_text(json.dumps(result['manifest'],indent=2)+'\n')
ci=a['sourceCI'];assert ci['headSha']==commit and ci['conclusion']=='success' and len(ci['jobs'])==5
verification={'schema':'footprint-ml-release-verification/v1','passed':True,'commit':commit,'tree':result['manifest']['tree'],
    'version':version,'pythonVersion':pv,'cohort':result['cohort'],'hosted':ci,'producer':producer,
    'assets':[receipt(p) for p in (archive,wheel,manifest)],'sourceFiles':result['sourceFiles'],'npm':result['npm'],'wheel':result['wheel'],
    'distribution':'GitHub prerelease archives; no npm/PyPI publication',
    'limits':['Hashes compare content, not producer authentication or numerical correctness.','No signature-chain verification or consumer adoption claim.']}
vfile=out/'verification.json';assert not vfile.exists()
vfile.write_text(json.dumps(verification,indent=2)+'\n')
notes=(root/('release-notes/'+version+'.md')).read_bytes();notes.decode('utf-8')
assert 0<len(notes)<=65536
(out/'release-notes.md').write_bytes(notes)
binding={'sha':commit,'tree':result['manifest']['tree'],'version':version,'producer':producer,'ciRun':ci['id'],'ciAttempt':ci['attempt'],
    'files':[receipt(p) for p in (archive,wheel,manifest,vfile,out/'release-notes.md')]}
assert all(0<x['bytes']<=67108864 for x in binding['files'])
if os.environ.get('GITHUB_OUTPUT'):
    with open(os.environ['GITHUB_OUTPUT'],'a') as f:f.write('binding='+json.dumps(binding,separators=(',',':'))+'\n')
print(json.dumps({'passed':True,'commit':commit,'assets':binding['files']},indent=2))
