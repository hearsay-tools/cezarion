import json,pathlib,subprocess,time,hashlib,urllib.request
out=pathlib.Path(__file__).parent.resolve()
def b(*args):return subprocess.run([str(out/'browser.sh'),*args],check=True,capture_output=True,text=True).stdout
def observe():return json.loads(b('eval',"(() => {const list=document.querySelector('[data-slot=gh-list]'),h=document.querySelector('[data-slot=gh-list-resize-handle]'),r=h.getBoundingClientRect();return {width:list.getBoundingClientRect().width,stored:localStorage.getItem('cez-github-list-width'),value:Number(h.getAttribute('aria-valuenow')),min:Number(h.getAttribute('aria-valuemin')),max:Number(h.getAttribute('aria-valuemax')),theme:getComputedStyle(document.documentElement).colorScheme,density:document.documentElement.dataset.density||'comfortable',viewport:{width:innerWidth,height:innerHeight},handle:{x:r.x+r.width/2,y:r.y+30}}})()"))
def drag(x):
 p=observe()['handle'];b('mouse','move',str(round(p['x'])),str(round(p['y'])));b('mouse','down');b('mouse','move',str(x),str(round(p['y'])));b('mouse','up');time.sleep(.1)
def verify(width):
 state=observe();assert state['width']==width and state['value']==width and int(state['stored'])==width,state
 assert state['min']==280 and state['max']==520,state
 return state
base='http://127.0.0.1:44663'
proof=json.loads((out/'build-proof.json').read_text())
assert hashlib.sha256(urllib.request.urlopen(base+'/').read()).hexdigest()==proof['servedIndexSha256']
b('open',base+'/git')
b('network','unroute')
for mock in json.loads((out/'populated-mocks.json').read_text())['mocks']:
 for prefix in ['**/api/v1','**/api/v1/p/*']:
  b('network','unroute',prefix+mock['path']);b('network','route',prefix+mock['path'],'--body',json.dumps(mock['body']))
b('set','viewport','1440','1900')
b('eval',"localStorage.removeItem('cez-github-list-width');localStorage.setItem('cez-density','comfortable');localStorage.setItem('cez-sidebar-width','264')")
rows=[]
for theme in ['light','dark']:
 b('eval',f"localStorage.setItem('cez-theme','{theme}')");b('open',base+'/github/issues/219');b('wait','[data-slot="gh-list-resize-handle"]')
 for width,frame in [(280,'pg6Nc' if theme=='light' else 'ZhYVg'),(360,'Gg8yJ' if theme=='light' else 'gW5PQ'),(520,'CEQfL' if theme=='light' else 'vETJh')]:
  if width==360:b('dblclick','[data-slot="gh-list-resize-handle"]');action='double-click restores default'
  else:drag(100 if width==280 else 1400);action='real pointer drag beyond '+('minimum' if width==280 else 'maximum')
  before=verify(width)
  b('open',base+'/github/issues/219');b('wait','[data-slot="gh-list-resize-handle"]');after=verify(width)
  assert after['theme']==theme and after['density']=='comfortable',after
  b('eval','document.fonts.ready.then(()=>true)');b('mouse','move','1425','1880');time.sleep(.2)
  name=frame+'-resize-browser.png';b('screenshot',str(out/name))
  sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
  rows.append(dict(frameId=frame,theme=theme,viewport=after['viewport'],width=width,action=action,beforeReload=before,afterReload=after,design=frame+'-design.png',browser=name,designSha256=sha(out/(frame+'-design.png')),browserSha256=sha(out/name),sourceSha256=proof['sourceSha256'],buildCommit=proof['buildCommit'],webDistSha256=proof['webDistSha256'],verdict='drag/reset and persistence passed; paired visual review retains documented shared-shell/document differences'))
  print(theme,width,action,'persisted',flush=True)
 # Keyboard alternatives remain reachable on the same real separator.
 b('focus','[data-slot="gh-list-resize-handle"]');b('press','Home');verify(280);b('press','End');verify(520);b('press','ArrowLeft');verify(504)
(out/'r2-resize-manifest.json').write_text(json.dumps({'pairs':rows,'keyboard':'Home=280, End=520, ArrowLeft=504 verified in both themes','fixture':'populated-mocks.json','status':'passed'},indent=2))
