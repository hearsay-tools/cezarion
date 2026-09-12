import json,pathlib,subprocess,time,copy
out=pathlib.Path(__file__).parent.resolve()
def browser(*args):return subprocess.run([str(out/'browser.sh'),*args],check=True,text=True,stdout=subprocess.PIPE).stdout
def route(path,body):
 for prefix in ['**/api/v1','**/api/v1/p/*']:
  browser('network','unroute',prefix+path)
  browser('network','route',prefix+path,'--body',json.dumps(body))
def capture(name,theme,width,height,reference):
 time.sleep(.3)
 browser('screenshot',str(out/(name+'.png')))
 rows.append(dict(state=name,theme=theme,viewport={'width':width,'height':height},density='comfortable',browser=name+'.png',design=reference+'-design.png',verdict='pending visual review'))
rows=[]
for theme in ['light','dark']:
 for width,height in [(1440,1300),(402,2052)]:
  suffix=f'{theme}-{width}'
  ref=('zSB9u' if theme=='light' else 'Z3tJLp') if width==1440 else ('RvbXf' if theme=='light' else 'MnEgv')
  browser('set','viewport',str(width),str(height));browser('eval',f"localStorage.setItem('cez-theme','{theme}')")
  blocked=json.load(open(out/'27B-merge-state.json'))
  route('/github/prs/218/merge-state',blocked)
  browser('open','http://127.0.0.1:44663/github/prs/218/changes');browser('wait','[data-slot="gh-merge-box"]')
  browser('check','[data-slot="gh-merge-box"] input[type="checkbox"]')
  browser('eval',"[...document.querySelectorAll('[data-slot=gh-merge-box] button')].find(b=>b.textContent==='Squash and merge').click()")
  browser('wait','[data-slot="gh-merge-confirm"]')
  capture('bypass-confirm-'+suffix,theme,width,height,ref)
  # No confirm/merge request is ever submitted.
  conflict=copy.deepcopy(blocked);conflict['mergeState'].update(canOverride=False,mergeable='conflicting',blockers=[dict(code='conflicts',message='Conflicts must be resolved before merging.')])
  route('/github/prs/218/merge-state',conflict)
  browser('open','http://127.0.0.1:44663/github/prs/218/changes');browser('wait','[data-slot="gh-merge-box"]')
  capture('conflict-'+suffix,theme,width,height,ref)
  browser('eval',"[...document.querySelectorAll('[data-slot=gh-merge-box] button')].find(b=>b.textContent==='Run agent on this PR').click()")
  capture('conflict-handoff-'+suffix,theme,width,height,ref)
  for state,payload in [('text',dict(content='# Readme\n\nPopulated file preview.\n',binary=False,tooLarge=False)),('binary',dict(binary=True,tooLarge=False)),('too-large',dict(binary=False,tooLarge=True))]:
   height=1120 if width==1440 else 1471
   browser('set','viewport',str(width),str(height))
   route('/runs/10000000-0000-4000-8000-000000000000/files?path=README.md',dict(type='file',path='README.md',size=4096,**payload))
   browser('open','http://127.0.0.1:44663/tasks/10000000-0000-4000-8000-000000000000/files');browser('wait','[data-slot="files-tree"]');browser('click','[data-slot="files-file"][data-path="README.md"]')
   browser('wait','[data-slot="file-preview-head"]')
   fileRef=('MFtcY' if theme=='light' else 'l3f2r3') if width==1440 else ('LAKkC' if theme=='light' else 'S1Gdo')
   capture('file-'+state+'-'+suffix,theme,width,height,fileRef)
  json.dump(rows,open(out/'interaction-manifest.json','w'),indent=2)
  print(suffix,flush=True)
