#!/usr/bin/env python3
"""Refresh approved data files while retaining every currently deployed UI blob."""
import argparse,hashlib,json,os,re,subprocess,urllib.error,urllib.request
from pathlib import Path
DATA_PATHS={
 'flooddashboard':('data/petss_forecast.csv','data/petss_forecast.json','data/petss_meta.json','data/peaks_navd88.json','data/petss_station_debug.txt'),
 'floodmapper':('forecast.json','forecasts.json','observed.json','observedoverflow.json','toptides.json','data/experimental_petss_guidance.json'),
}
def request(site,app,token,endpoint,method='GET',value=None,raw=False):
 url=site.rstrip('/')+'/wp-json/shorelysafe/v1/apps/'+app+'/'+endpoint
 body=value if raw else (json.dumps(value).encode() if value is not None else None)
 req=urllib.request.Request(url,data=body,method=method,headers={'X-ShorelySafe-Token':token,'Content-Type':'application/octet-stream'if raw else'application/json'})
 try:
  with urllib.request.urlopen(req,timeout=120)as r:return json.load(r)
 except urllib.error.HTTPError as e:
  try:d=json.loads(e.read());msg=d.get('message','Request refused');code=d.get('code','unknown')
  except Exception:msg='Request refused';code='unknown'
  # No retries or alternate route around a hosting write gate.
  raise RuntimeError(f'HTTP {e.code} {code}: {msg}')from None

def overlay(base,source,paths,replacements):
 before=base['files'];assert isinstance(before,dict)and'index.html'in before,'Published UI manifest missing'
 after={k:dict(v)for k,v in before.items()};payloads={};changed=[]
 for name in paths:
  p=source/name
  if not p.is_file():continue
  assert not p.is_symlink(),f'Symlink data file: {name}'
  raw=p.read_bytes();assert len(raw)<67108864,f'Data file unexpectedly large: {name}'
  text=raw.decode('utf-8')
  for old,new in replacements:text=text.replace(old,new)
  data=text.encode();sha=hashlib.sha256(data).hexdigest();entry={'sha256':sha,'size':len(data)}
  if before.get(name)!=entry:changed.append(name);payloads[sha]=data
  after[name]=entry
 for name,entry in before.items():
  if name not in paths:assert after[name]==entry,'UI asset changed'
 assert after['index.html']==before['index.html'],'Index changed'
 return after,payloads,changed

def main():
 p=argparse.ArgumentParser();p.add_argument('--app',required=True);p.add_argument('--site',default='https://cupajoe.live');p.add_argument('--dry-run',action='store_true');args=p.parse_args()
 assert args.site=='https://cupajoe.live','Unexpected publication site'
 root=Path.cwd();apps=json.loads((root/'.shorelysafe/apps.json').read_text());app=next(a for a in apps if a['id']==args.app)
 assert os.environ.get('GITHUB_REPOSITORY',app['repository'])==app['repository'],'Repository/app mismatch'
 assert args.app=='floodmapper--north-wildwood','This repair is scoped to the current North Wildwood mapper'
 assert app['repository']=='hondrospj/North-Wildwood-floodmapper','Unexpected source repository'
 import sys
 sys.path.insert(0,str(root/'tools'))
 from release_data import GENERATED_FILES,GENERATED_DIRECTORIES,is_generated_data,validate_data,read_json
 from release_gate import GitHub,assert_current
 names=set(p for p in GENERATED_FILES if (root/p).is_file())
 for prefix in GENERATED_DIRECTORIES:
  directory=root/prefix
  if directory.is_dir():
   names.update(p.relative_to(root).as_posix() for p in directory.rglob('*.json') if p.is_file())
 paths=tuple(sorted(names));assert paths and all(is_generated_data(p) for p in paths)
 source_sha=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
 github=GitHub(app['repository'],os.environ['GH_TOKEN'])
 assert_current(github,source_sha)
 forecast=read_json(root/'forecast.json')
 assert forecast['stationId']=='8535581' and forecast['usgsGaugeId']=='01411360','Forecast reference station changed'
 assert forecast['operationalForecastProduct']=='TWL' and forecast['operationalForecastStatistic']=='ensemble_mean','Forecast product changed'
 assert forecast['thresholdsNAVD88']=={'minorLow':3.25,'moderateLow':4.25,'majorLow':5.25},'Forecast warning thresholds changed'
 assert forecast['thresholdsMLLW']=={'minorLow':6.0,'moderateLow':7.0,'majorLow':8.0},'Tidal warning thresholds changed'
 token=os.environ['SHORELYSAFE_TOKEN'];assert token,'Publisher credential missing'
 state=request(args.site,args.app,token,'state?manifest=1');assert state.get('published')and state.get('manifest'),'No currently published UI; refusing to create a new site'
 base=state['manifest'];replacements=[('https://hondrospj.github.io/'+a['repository'].split('/')[1]+'/',a['path'])for a in apps]
 after,payloads,changed=overlay(base,root,paths,replacements)
 validation=validate_data(root,changed)
 assert_current(github,source_sha)
 result={'app':args.app,'mode':'current-manifest-data-overlay','data_source_commit':source_sha,'preserved_ui_commit':state.get('commit'),'base_deployment':state.get('deployment'),'file_count':len(after),'preserved_nondatablobs':sum(k not in paths for k in base['files']),'changed_data_files':changed,'index_sha256_before':base['files']['index.html']['sha256'],'index_sha256_after':after['index.html']['sha256'],'dry_run':args.dry_run,'data_validation':validation,'allowlisted_generated_files':len(paths)}
 print(json.dumps(result),flush=True)
 if changed and not args.dry_run:
  body={'files':[{'path':k,**v}for k,v in sorted(after.items())],'commit':state.get('commit')or base.get('commit')or source_sha}
  Path('data-overlay-publication-receipt.json').write_text(json.dumps(result,indent=2)+'\n')
  plan=request(args.site,args.app,token,'plan','POST',body)
  for sha in plan['missing']:
   assert sha in payloads,'Server is missing a non-data UI blob; refusing to recreate/replace UI'
   data=payloads[sha];offset=0
   while True:
    chunk=data[offset:offset+524288];r=request(args.site,args.app,token,f'blobs/{sha}?deployment={plan["deployment"]}&offset={offset}','PUT',chunk,True)
    if r.get('complete'):break
    nxt=int(r['offset']);assert offset<nxt<=len(data),'Upload made no progress';offset=nxt
  # Detect concurrent publication before switching the active deployment.
  assert_current(github,source_sha)
  latest=request(args.site,args.app,token,'state')
  assert latest.get('deployment')==state.get('deployment'),'Concurrent publication changed base; retry against new manifest'
  published=request(args.site,args.app,token,'commit','POST',{'deployment':plan['deployment']})
  verify=request(args.site,args.app,token,'state?manifest=1');assert verify.get('deployment')==plan['deployment']and verify['manifest']['files']==after,'Published manifest verification failed'
  result.update({'published':published.get('published'),'deployment':plan['deployment'],'url':published.get('url'),'ui_blobs_unchanged_verified':True})
 else:result['no_op']=not changed
 print(json.dumps(result),flush=True);Path('data-overlay-publication-receipt.json').write_text(json.dumps(result,indent=2)+'\n')
if __name__=='__main__':main()
