import struct
import json, pathlib, subprocess, shutil, hashlib, time
out=pathlib.Path(__file__).parent.resolve()
parent=out.parents[3].parent/'9ae05dcc-cc09-405c-9934-ab364076aa21'
# Explicit reference path can be supplied when replaying outside the worker layout.
import os
reference=pathlib.Path(os.environ.get('CEZ_DESIGN_REFERENCE','/home/agent/projects/cezar/.ai/cezar/worktrees/9ae05dcc-cc09-405c-9934-ab364076aa21/.ai/design-reference/iteration-3/design'))
d=json.load(open(reference/'manifest.json'))
def browser(*args):
 return subprocess.run([str(out/'browser.sh'),*args],check=True,capture_output=True,text=True).stdout
routes={'6':'/git','7':'/git/commits','8':'/git/branches','9':'/github/issues/219','14':'/tasks/10000000-0000-4000-8000-000000000000/changes','15':'/tasks/10000000-0000-4000-8000-000000000000/commits','16':'/tasks/10000000-0000-4000-8000-000000000000/files','27A':'/github/prs/218','27B':'/github/prs/218/changes','27C':'/github/prs/218'}
selectors={'6':'[data-slot="repo-changes-toolbar"]','7':'[data-slot="repo-commits"]','8':'[data-slot="repo-branches"]','9':'[data-slot="gh-body"]','14':'[data-route="task-changes"]','15':'[data-slot="task-commits"]','16':'[data-slot="files-tree"]','27A':'[data-slot="gh-merge-box"]','27B':'[data-slot="gh-merge-box"]','27C':'[data-slot="gh-merge-box"]'}
rows=[]
if os.environ.get('CEZ_CAPTURE_FAMILY') and (out/'manifest.json').exists():
 rows=json.load(open(out/'manifest.json'))['pairs']
 rows=[r for r in rows if not any(r['frame'].startswith(f+'.') for f in os.environ['CEZ_CAPTURE_FAMILY'].split(','))]
for f in d['frames']:
 key=f['name'].split('.')[0]
 if key.startswith('27'): family=key
 else: family=key[:-1]
 if key == 'R2': family='9'
 if family not in routes: continue
 if os.environ.get('CEZ_CAPTURE_FAMILY') and family not in os.environ['CEZ_CAPTURE_FAMILY'].split(','): continue
 pixelWidth,pixelHeight=struct.unpack('>II',(reference/f['screenshot']).read_bytes()[16:24])
 f=dict(f,width=pixelWidth//2,height=pixelHeight//2)
 theme=f.get('theme',{}).get('mode')
 if theme not in ('light','dark'): theme='dark' if 'dark' in f['name'].lower() else 'light'
 if family.startswith('27'):
  mocks=json.load(open(out/'mock-api.json'))['mocks']
  merge=next(m['body'] for m in mocks if 'merge-state' in m['path'])
  state=merge['mergeState']
  if family=='27A':
   state.update(eligibility='ready',canMerge=True,blockers=[])
   state['checks'][0]['required']=True
  elif family=='27B':
   state.update(eligibility='blocked',canMerge=False,canOverride=True,mergeable='mergeable',reviewDecision='review-required',blockers=[dict(code='review-required',message='A required review is missing.')])
   state['checks'][0].update(state='passing',required=True)
  json.dump(merge,open(out/(family+'-merge-state.json'),'w'),indent=2)
  for prefix in ['**/api/v1','**/api/v1/p/*']:
   browser('network','unroute',prefix+'/github/prs/218/merge-state')
   browser('network','route',prefix+'/github/prs/218/merge-state','--body',json.dumps(merge))
 browser('set','viewport',str(f['width']),str(f['height']))
 browser('eval',f"localStorage.setItem('cez-theme','{theme}');localStorage.setItem('cez-sidebar-width','264');localStorage.setItem('cez-density','comfortable')")
 if key == 'R2':
  width=280 if 'minimum' in f['name'] else 520 if 'maximum' in f['name'] else 360
  browser('eval',f"localStorage.setItem('cez-github-list-width', '{width}')")
 browser('open','http://127.0.0.1:44663'+routes[family])
 try: browser('wait',selectors[family])
 except subprocess.CalledProcessError: pass
 if family.startswith('27'):
  eligibility=json.loads(browser('eval',"document.querySelector('[data-slot=gh-merge-box]').dataset.eligibility"))
  assert eligibility=={'27A':'ready','27B':'blocked','27C':'unknown'}[family], (family,eligibility)
 browser('eval','document.fonts.ready.then(() => true)')
 time.sleep(.5)
 png=out/(f['id']+'-browser.png')
 observed=json.loads(browser('eval',"({theme:getComputedStyle(document.documentElement).colorScheme,width:innerWidth,height:innerHeight,font:getComputedStyle(document.body).fontFamily})"))
 assert observed['theme']==theme and observed['width']==f['width'] and observed['height']==f['height'], observed
 browser('screenshot',str(png))
 shutil.copyfile(reference/f['screenshot'],out/(f['id']+'-design.png'))
 rows.append(dict(frame=f['name'],frameId=f['id'],viewport={'width':f['width'],'height':f['height']},theme=theme,density='comfortable',observed=observed,route=routes[family],design= f['id']+'-design.png',browser=f['id']+'-browser.png',verdict='pending visual review'))
 json.dump({'sourceSha256':d['penFileSha256'],'pairs':rows},open(out/'manifest.json','w'),indent=2)
 print(f['id'],f['name'],flush=True)
