"""Read-only public verification. Package contents are data and are never imported."""
import hashlib,json,os,re,sys,urllib.error,urllib.request
from pathlib import Path
if not __debug__:raise RuntimeError('non-optimized interpreter required')
API='https://api.github.com/repos/footprintjs/footprintjs-ml'
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise ValueError('unexpected-api-redirect')
def api(route):
    request=urllib.request.Request(API+route,headers={'Accept':'application/vnd.github+json',
        'Authorization':'Bearer '+os.environ['GITHUB_TOKEN']})
    with urllib.request.build_opener(NoRedirect).open(request,timeout=30) as response:
        assert response.status==200
        data=response.read(2097153)
        assert len(data)<=2097152 and 'rel="next"' not in response.headers.get('Link','')
    return json.loads(data)
def verify(candidate,out,binding,read=api,download=None):
    producer=binding['producer'];assert type(producer) is dict
    for key in ('run','runNumber','attempt'):assert type(producer[key]) is int and 0<producer[key]<=9007199254740991
    out.mkdir(parents=True,exist_ok=False)
    v=binding['version'];assert re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)',v)
    names={'footprintjs-ml-'+v+'.tgz','footprintjs_ml-'+v.replace('-beta.','b')+'-py3-none-any.whl','source-manifest.json','verification.json'}
    assert len(binding['files'])==5 and {f['file'] for f in binding['files']}==names|{'release-notes.md'}
    notes=next(f for f in binding['files'] if f['file']=='release-notes.md')
    assert hashlib.sha256((candidate/'release-notes.md').read_bytes()).hexdigest()==notes['sha256']
    release=read('/releases/tags/v'+v);tag=read('/git/ref/tags/v'+v)
    assert release['tag_name']=='v'+v and release['draft'] is False and release['prerelease'] is True
    assert type(release['id']) is int and 0<release['id']<=9007199254740991
    assert release['target_commitish']==binding['sha']
    assert tag['object']['type']=='commit' and tag['object']['sha']==binding['sha']
    assert release['body']==(candidate/'release-notes.md').read_text(encoding='utf-8')
    rows=read('/releases/'+str(release['id'])+'/assets?per_page=100')
    files={f['file']:f for f in binding['files'] if f['file']!='release-notes.md'}
    assert all(type(a['id']) is int and 0<a['id']<=9007199254740991 for a in rows)
    assert len(files)==4 and len(rows)==4 and len({a['id'] for a in rows})==4 and {a['name'] for a in rows}==set(files)
    results=[]
    for a in rows:
        name=a['name'];f=files[name];size=f['bytes']
        assert type(a['size']) is int and 0<a['size']<=67108864
        assert a['state']=='uploaded' and a['size']==size and a['digest']=='sha256:'+f['sha256']
        assert type(size) is int and 0<size<=67108864
        assert hashlib.sha256((candidate/name).read_bytes()).hexdigest()==f['sha256']
        url='https://github.com/footprintjs/footprintjs-ml/releases/download/v'+v+'/'+name
        if download is None:
            # Public acquisition carries NO token, including on redirects.
            with urllib.request.urlopen(urllib.request.Request(url,headers={'Accept':'application/octet-stream'}),timeout=60) as response:
                assert response.status==200;data=response.read(size+1)
        else:data=download(url,size+1)
        (out/name).write_bytes(data)
        assert len(data)==size and hashlib.sha256(data).hexdigest()==f['sha256'] and data==(candidate/name).read_bytes()
        results.append({'file':name,'id':a['id'],'bytes':size,'sha256':f['sha256'],'matchesRetainedCandidate':True})
    receipt={'schema':'ml-beta-public-verification/v1','passed':True,'commit':binding['sha'],'tree':binding['tree'],
        'version':v,'releaseId':release['id'],'assets':results,'publisherReturnedSuccess':os.environ.get('PUBLISHER_SUCCESS')=='true',
        'nativeProducer':binding['producer'],'signatureVerified':False,'consumerAdoptionClaimed':False,
        'boundary':'Public bytes match the retained candidate; an unknown submission is not retrospectively claimed as owned success.'}
    (out/'verification.json').write_text(json.dumps(receipt,indent=2)+'\n')
    return receipt
if __name__=='__main__':
    try:
        result=verify(Path(sys.argv[1]),Path(sys.argv[2]),json.loads(os.environ['BINDING']))
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'],'a') as f:f.write('Four public assets exactly match retained build bytes. No signature or adoption claim.\n')
        print(json.dumps({'passed':True,'version':result['version'],'assets':len(result['assets'])}))
    except Exception:
        print('Public verification refused; retained data is not permission to retry or repair.',file=sys.stderr)
        sys.exit(1)
