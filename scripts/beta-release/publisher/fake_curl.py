#!/usr/bin/env python3
"""Fixed fake HTTP transport for the exact extracted workflow glue; never networks."""
import hashlib,json,os,sys
from pathlib import Path
from urllib.parse import urlsplit,parse_qs
base=Path(os.environ['FIXTURE_DIR']);state=json.loads((base/'state.json').read_text());args=sys.argv[1:]
method='GET';out=None;headers=None;code_out=False;url=None;data=None;auth=False;i=0
valued={'--request','--header','--dump-header','--output','-o','--write-out','--data-binary','--connect-timeout','--max-time','--retry'}
while i<len(args):
 a=args[i]
 if a in valued:
  v=args[i+1];i+=2
  if a=='--request':method=v
  elif a in ('--output','-o'):out=Path(v)
  elif a=='--dump-header':headers=Path(v)
  elif a=='--write-out':code_out=True
  elif a=='--data-binary':data=v
  elif a=='--header' and v.startswith('Authorization:'):auth=True
 else:
  if a.startswith('https://'):url=a
  i+=1
assert '--retry' in args and args[args.index('--retry')+1]=='0'
u=urlsplit(url);path=u.path;q=parse_qs(u.query);kind=state['case'];sha=state['sha'];version=state['version'];run=state['run'];number=state['number']
assert auth==(u.hostname in ('api.github.com','uploads.github.com')), 'Credential crosses artifact redirect'
state['calls'].append({'method':method,'path':path})
status=200;value={};blob=None;extra='';lost=False
def release(draft=True):
 return {'id':201,'tag_name':'v'+version,'target_commitish':sha,'draft':draft,'prerelease':True,'assets':state['assets']}
def own():
 return {'id':run,'run_number':number,'workflow_id':5,'display_title':'ML beta '+version+' / dry_run=false','head_sha':sha,
  'head_branch':'main','path':'.github/workflows/publish.yml','event':'workflow_dispatch','run_attempt':1,'status':'in_progress'}
prefix='/repos/footprintjs/footprintjs-ml'
if u.hostname.endswith('.blob.core.windows.net'):blob=(base/'candidate.zip').read_bytes()
elif path==prefix+'/actions/artifacts/102':
 value={'id':102,'workflow_run':{'id':run,'head_sha':sha,'head_branch':'main'},'name':'beta-candidate-'+str(run)+'-1','digest':'sha256:'+state['digest'],'expired':False}
 if kind=='rebound-artifact':value['workflow_run']['id']=1
elif path==prefix+'/actions/artifacts/102/zip':status=302;extra='Location: https://artifact.blob.core.windows.net/candidate.zip\r\n'
elif path==prefix+'/git/ref/heads/main':value={'object':{'type':'commit','sha':'b'*40 if kind=='moved-main' else sha}}
elif path==prefix+'/actions/runs/'+str(run):value=own()
elif path==prefix+'/actions/workflows/ci.yml/runs':
 value={'workflow_runs':[{'id':73,'run_attempt':1,'head_sha':sha,'head_branch':'main','event':'push','path':'.github/workflows/ci.yml','status':'completed','conclusion':'success'}]}
 if kind=='ci-changed':value['workflow_runs'][0]['run_attempt']=2
elif path==prefix+'/actions/workflows/publish.yml/runs':
 rows=[own()]
 if number==2:
  prior={**own(),'id':state.get('priorRun',90),'run_number':1,'status':'completed'}
  if kind=='earlier-dry':prior['display_title']='ML beta '+version+' / dry_run=true'
  if kind=='bad-title':prior['display_title']='unparseable'
  if kind!='history-gap':rows.insert(0,prior)
 value={'total_count':len(rows),'workflow_runs':rows}
 if kind=='history-cap':value['total_count']=1001
 if kind=='history-incomplete':value={'total_count':101,'workflow_runs':[]}
elif path==prefix+'/actions/runs/'+str(state.get('priorRun',90))+'/jobs':
 conclusion='skipped' if kind=='prior-skipped' or kind.startswith('prior-field:') else 'failure'
 jobs=[{'id':1,'run_id':state.get('priorRun',90),'name':'publish','status':'completed','conclusion':conclusion,'steps':[] if conclusion=='skipped' else [{'name':'Create draft'}]}]
 if kind=='prior-unknown':jobs=[]
 if kind=='prior-rerun-skipped':jobs.append({'id':2,'run_id':state.get('priorRun',90),'name':'publish','status':'completed','conclusion':'skipped','steps':[]})
 if kind.startswith('prior-pages-'):
  jobs=[{'id':i+1,'run_id':state.get('priorRun',90),'name':'publish' if i in (0,100) else 'admit','status':'completed','conclusion':'skipped' if i in (0,100) else 'success','steps':[]} for i in range(101)]
  last=jobs[-1]
  if kind=='prior-pages-duplicate':last=jobs[0]
  if kind=='prior-pages-missing-id':last={k:v for k,v in last.items() if k!='id'}
  if kind=='prior-pages-wrong-run':last={**last,'run_id':1}
  if kind=='prior-pages-missing-run':last={k:v for k,v in last.items() if k!='run_id'}
  if kind=='prior-pages-started':last={**last,'conclusion':'failure','steps':[{'name':'Create draft'}]}
  jobs=(jobs if kind=='prior-pages-oversized' else jobs[:100]) if q.get('page',['1'])[0]=='1' else [last]
  value={'total_count':101,'jobs':jobs}
 else:value={'total_count':len(jobs),'jobs':jobs}
elif path.startswith(prefix+'/git/ref/tags/'):
 status=404
 if state.get('created') and kind in ('tag-moved','tag-correct'):
  status=200;value={'object':{'type':'commit','sha':'b'*40 if kind=='tag-moved' else sha}}
elif path==prefix+'/releases' and method=='GET':
 value=[release(True)] if kind=='same-tag-draft' else []
 if kind.startswith('release-pages-'):
  rows=[{'id':i+1,'tag_name':'v0.1.0-beta.'+str(i),'draft':False} for i in range(101)]
  if q.get('page',['1'])[0]=='1':
   value=rows if kind=='release-pages-oversized' else rows[:100];extra='Link: <https://api.github.com/repos/footprintjs/footprintjs-ml/releases?page=2>; rel="next"\r\n'
  else:
   value=[rows[0] if kind=='release-pages-duplicate' else rows[-1]]
   if kind=='release-pages-missing-id':value=[{k:v for k,v in value[0].items() if k!='id'}]
elif path==prefix+'/releases' and method=='POST':
 status=201;state['created']=True;value=release(True)
 if kind=='create-unknown':lost=True
 if kind=='create-wrong-id':value['id']='wrong'
 if kind=='create-wrong-source':value['target_commitish']='b'*40
elif u.hostname=='uploads.github.com':
 name=q['name'][0];payload=Path(data[1:]).read_bytes();asset={'id':1000+len(state['assets']),'name':name,'size':len(payload),
  'digest':'sha256:'+hashlib.sha256(payload).hexdigest(),'state':'uploaded'}
 state['assets'].append(asset);status=201;value=asset
 if kind=='upload-2-fail' and len(state['assets'])==2:status=500;value={'error':'PRIVATE-FIXTURE-ERROR-NOT-FOR-LOG'}
 if kind=='upload-2-unknown' and len(state['assets'])==2:lost=True
 if kind=='upload-wrong-digest':value['digest']='sha256:'+'f'*64
elif path.startswith(prefix+'/releases/assets/'):
 aid=int(path.rsplit('/',1)[1]);value=next(a for a in state['assets'] if a['id']==aid)
elif path==prefix+'/releases/201/assets':
 value=state['assets']
 if kind=='final-renamed':value=[{**a,'name':'changed'} for a in value]
elif path==prefix+'/releases/201' and method=='PATCH':
 state['published']=True;value=release(False)
 if kind=='undraft-unknown':lost=True
else:raise AssertionError('Unexpected request '+method+' '+path)
# Malformed native data remains inert JSON; this transport never networks.
if kind.startswith(('field:','prior-field:')):
 _,location,field,variant=kind.split(':')
 target=None
 if location=='release-row' and path==prefix+'/releases' and method=='GET':
  value=[{'id':101,'tag_name':'v0.1.0-beta.1'}];target=value[0]
 if location=='prior-run' and path==prefix+'/actions/workflows/publish.yml/runs':target=value['workflow_runs'][0]
 if location=='prior-job' and path==prefix+'/actions/runs/'+str(state.get('priorRun',90))+'/jobs':
  value['jobs'].append({'id':2,'run_id':state.get('priorRun',90),'name':'admit','status':'completed','conclusion':'success','steps':[]})
  value['total_count']=2;target=value['jobs'][1]
 if location=='ci' and path==prefix+'/actions/workflows/ci.yml/runs':target=value['workflow_runs'][0]
 if location=='artifact' and path==prefix+'/actions/artifacts/102':target=value
 if location=='created' and path==prefix+'/releases' and method=='POST':target=value
 if location=='final-array' and method=='GET' and path==prefix+'/releases/201/assets':value={str(i):row for i,row in enumerate(value)}
 if target is not None:
  if variant=='missing':target.pop(field,None)
  else:target[field]={'null':None,'number':7,'empty':'','array':['completed'],'object':{}}[variant]
(base/'state.json').write_text(json.dumps(state))
if headers:headers.write_text('HTTP/1.1 '+str(status)+' Result\r\n'+extra+'\r\n')
if out:out.write_bytes(blob if blob is not None else json.dumps(value).encode())
if lost:
 if code_out:sys.stdout.write('000')
 sys.exit(28)
if code_out:sys.stdout.write(str(status))
sys.exit(22 if status>=400 else 0)
