"""Data-only release inspection; never imports or executes package contents."""
import ast, base64, csv, email, fnmatch, hashlib, io, json, os, re, stat, subprocess, sys, tarfile, tomllib, zipfile
from pathlib import Path, PurePosixPath
if not __debug__: raise RuntimeError('non-optimized interpreter required')

def inspect_candidate(root,archive,wheel,commit):
    root,archive,wheel=Path(root),Path(archive),Path(wheel)
    pkg_source=json.loads((root/'package.json').read_text())
    version=pkg_source['version']
    match=re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)',version)
    assert match,'Canonical beta version required'
    python_version='.'.join(match.groups()[:3])+'b'+match[4]
    sha = lambda b: hashlib.sha256(b).hexdigest()
    def git(*args):
        return subprocess.check_output(['git', '-C', str(root), *args])
    def receipt(path):
        b=path.read_bytes()
        return {'file':path.name,'bytes':len(b),'sha256':sha(b)}
    def safe(name):
        p=PurePosixPath(name)
        assert name and str(p)==name and not p.is_absolute() and '..' not in p.parts and '\\' not in name, 'Unsafe archive member'
        return p
    assert git('rev-parse','HEAD').decode().strip()==commit
    assert git('diff','--name-only').strip()==b''
    assert git('diff','--cached','--name-only').strip()==b''
    tree=git('rev-parse',commit+'^{tree}').decode().strip()
    source=[]
    tracked=set()
    for row in git('ls-tree','-rz',commit).split(b'\0'):
        if not row:continue
        entry,name=row.split(b'\t',1);mode,kind,blob=entry.decode().split();name=name.decode()
        assert kind=='blob' and mode in ('100644','100755'), 'Unexpected source entry type'
        data=git('cat-file','blob',blob)
        assert (root/name).read_bytes()==data,'Source checkout differs from immutable commit'
        source.append({'file':name,'mode':mode,'gitBlob':blob,'bytes':len(data),'sha256':sha(data)})
        tracked.add(name)
    manifest={'schema':'footprint-ml-source-manifest/v1','version':version,'commit':commit,'tree':tree,'files':source}
    assert archive.stat().st_size<=67108864 and wheel.stat().st_size<=67108864
    seen=set();npm=[];generated=[];unpacked=0
    with tarfile.open(archive,'r:gz') as t:
        for member in t.getmembers():
            p=safe(member.name)
            assert member.name not in seen,'Duplicate tar member'
            seen.add(member.name)
            assert p.parts[0]=='package','Unexpected tar prefix'
            if member.isdir():continue
            assert member.isfile(),'Nonregular tar entry'
            unpacked+=member.size
            assert 0<=member.size<=67108864 and unpacked<=268435456 and not member.mode&0o7000,'Archive capacity or mode'
            name=str(PurePosixPath(*p.parts[1:]));data=t.extractfile(member).read()
            assert data==(root/name).read_bytes(),'Tar payload differs from release checkout/build'
            if name not in tracked:
                assert name.startswith('dist/'),'Unexpected generated package member'
                generated.append({'file':name,'bytes':len(data),'sha256':sha(data)})
            npm.append({'file':name,'mode':member.mode,'bytes':len(data),'sha256':sha(data)})
        pkg=json.loads(t.extractfile('package/package.json').read())
        assert pkg['name']=='footprintjs-ml' and pkg['version']==version
        assert not pkg.get('dependencies')
    assert generated,'No compiled JS artifacts in package'
    expected_npm={'package.json'}
    for pattern in pkg_source['files']:
        for match_path in root.glob(pattern):
            matched=match_path.rglob('*') if match_path.is_dir() else [match_path]
            for path in matched:
                name=path.relative_to(root).as_posix()
                if path.is_file() and (name in tracked or name.startswith('dist/')):
                    assert not path.is_symlink()
                    expected_npm.add(name)
    assert {row['file'] for row in npm}==expected_npm,'Incomplete or extra npm package membership'
    project=tomllib.loads((root/'pyproject.toml').read_text())
    assert project['project']['name']==pkg_source['name'] and project['project']['version']==python_version
    assert project['project'].get('dependencies',[])==[]
    lock=json.loads((root/'package-lock.json').read_text())
    assert lock['version']==lock['packages']['']['version']==version
    resource_sources={}
    for destination,patterns in project['tool']['setuptools']['data-files'].items():
        assert str(safe(destination)).startswith('share/footprintjs-ml')
        for pattern in patterns:
            for path in root.glob(pattern):
                name=path.relative_to(root).as_posix()
                assert path.is_file() and name in tracked
                target='footprintjs_ml-'+python_version+'.data/data/'+destination+'/'+path.name
                assert target not in resource_sources or resource_sources[target]==name
                resource_sources[target]=name
    setuptools=project['tool']['setuptools']
    declared=setuptools.get('py-modules',[])
    assert isinstance(declared,list) and len(declared)==len(set(declared))
    assert all(isinstance(n,str) and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*',n) for n in declared)
    expected_modules={name+'.py' for name in declared}
    assert all('python/'+name in tracked for name in expected_modules)
    find=setuptools.get('packages',{}).get('find',{})
    if find:
        assert find['where']==['python'] and find.get('namespaces',True) is False
        for name in tracked:
            if not name.startswith('python/') or not name.endswith('.py'):continue
            relative=PurePosixPath(name[len('python/'):]);parents=list(relative.parents)[:-1]
            package='.'.join(relative.parts[:-1])
            if package and any(fnmatch.fnmatchcase(package,pattern) for pattern in find['include']):
                assert all('python/'+str(parent/'__init__.py') in tracked for parent in parents)
                expected_modules.add(str(relative))
    modules=resources=0
    with zipfile.ZipFile(wheel) as z:
        assert len(z.namelist())==len(set(z.namelist())),'Duplicate wheel member'
        for info in z.infolist():
            safe(info.filename)
            assert not info.is_dir() and not stat.S_ISLNK(info.external_attr>>16),'Unsafe wheel member type'
        assert sum(i.file_size for i in z.infolist())<=268435456 and all(i.file_size<=67108864 for i in z.infolist()),'Wheel capacity'
        dist='footprintjs_ml-'+python_version+'.dist-info/'
        expected_info={dist+n for n in ['METADATA','WHEEL','top_level.txt','RECORD','licenses/LICENSE']}
        assert set(z.namelist())==expected_modules|set(resource_sources)|expected_info,'Unexpected wheel member'
        assert {n for n in z.namelist() if '.data/data/share/footprintjs-ml/' in n}==set(resource_sources),'Incomplete wheel resources'
        assert {n for n in z.namelist() if n.endswith('.py') and '.data/' not in n}==expected_modules,'Incomplete wheel modules'
        metadata=[n for n in z.namelist() if n.endswith('.dist-info/METADATA')]
        assert len(metadata)==1
        m=email.message_from_bytes(z.read(metadata[0]))
        assert m['Name']=='footprintjs-ml' and m['Version']==python_version
        assert m['Requires-Python']==project['project']['requires-python']
        assert not m.get_all('Requires-Dist'), 'Wheel adds runtime dependency'
        wm=email.message_from_bytes(z.read(dist+'WHEEL'))
        assert wm['Root-Is-Purelib']=='true' and wm.get_all('Tag')==['py3-none-any']
        assert z.read(dist+'licenses/LICENSE')==(root/'LICENSE').read_bytes()
        record=[n for n in z.namelist() if n.endswith('.dist-info/RECORD')]
        assert len(record)==1
        rows=list(csv.reader(io.StringIO(z.read(record[0]).decode())))
        assert len(rows)==len(set(r[0] for r in rows))
        assert set(r[0] for r in rows)==set(z.namelist()),'Wheel RECORD incomplete'
        for name,h,size in rows:
            data=z.read(name)
            if name==record[0]:assert not h and not size
            else:
                assert h=='sha256='+base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip('=')
                assert str(len(data))==size
            source_name=None
            prefix='footprintjs_ml-'+python_version+'.data/data/share/footprintjs-ml/'
            if name.startswith(prefix):source_name=resource_sources[name];resources+=1
            elif name.endswith('.py') and '.dist-info/' not in name:source_name='python/'+name;modules+=1
            if source_name:
                assert source_name in tracked and data==(root/source_name).read_bytes(),'Wheel source/resource mismatch'
        constants={}
        for n in ast.parse(z.read('footprint_ml_versions.py')).body:
            if isinstance(n,ast.Assign) and len(n.targets)==1 and isinstance(n.targets[0],ast.Name) and isinstance(n.value,ast.Constant):
                constants[n.targets[0].id]=ast.literal_eval(n.value)
        assert constants['SDK_VERSION']==version and constants['PYTHON_VERSION']==python_version
        assert all(constants[key]==pkg_source['devDependencies'][name] for key,name in [('FOOTPRINTJS_VERSION','footprintjs'),('AGENTFOOTPRINT_VERSION','agentfootprint'),('FOOTTRACE_VERSION','foottrace')])
        assert modules and resources
    return {'version':version,'pythonVersion':python_version,'manifest':manifest,
        'cohort':{name:pkg_source['devDependencies'][name] for name in ['footprintjs','agentfootprint','foottrace']},
        'sourceFiles':len(source),'npm':{'files':len(npm),'bytes':sum(x['bytes'] for x in npm),'allPayloadsMatchSourceOrBuild':True,'generatedFiles':generated},
        'wheel':{'sourceModules':modules,'guidanceResources':resources,'recordHashesVerified':True,'requiresDist':[]}}

if __name__=='__main__':
    result=inspect_candidate(sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4])
    report={'schema':'ml-beta-package-inspection/v1','profile':'inspection-only-not-admission','passed':True,**result}
    Path(sys.argv[5]).write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'passed':True,'version':result['version'],'npmFiles':result['npm']['files'],'wheelModules':result['wheel']['sourceModules']}))
