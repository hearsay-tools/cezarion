"""Capture the real built fixture. Usage: python3 capture.py AUTHORITATIVE_PARENT_ROOT."""
import json, subprocess, sys, hashlib, time
from pathlib import Path
from PIL import Image
ROOT=Path.cwd(); OUT=Path(__file__).resolve().parent; PARENT=Path(sys.argv[1]); B=str(OUT/'browser.sh')
manifest=json.loads((PARENT/'.ai/design-reference/iteration-2/design/manifest.json').read_text())
assert manifest['penFileSha256']=='37378246893ba6259088ec3ddb2702e4220f44ca643ac13e5ac293263021a74b'
frames={n['id']:n for n in manifest['frames']}; records=[]

def cmd(*args):
 r=subprocess.run([B,*args],text=True,capture_output=True,timeout=40)
 if r.returncode: raise RuntimeError(r.stdout+r.stderr)
 return r.stdout
def js(code): return cmd('eval',code)
def settle(): js('new Promise(resolve => setTimeout(resolve, 250))')
def prepare(frame, theme, route, density='comfortable', width='wide'):
 f=frames[frame]; im=Image.open(PARENT/'.ai/design-reference/iteration-2/design'/f'{frame}.png'); w=int(f['width']); h=f.get('height'); h=int(h) if isinstance(h,(int,float)) else round(im.height*w/im.width)
 cmd('set','viewport',str(w),str(h)); js("fetch('/api/v1/workspace/ui-state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({appearance:"+json.dumps(dict(accent='cezarion',density=density,width=width))+"})}).then(r=>r.status)")
 js('localStorage.setItem("cez-theme",'+json.dumps(theme)+')')
 cmd('open','http://127.0.0.1:44636/p/default/'+route); cmd('wait','[data-slot="run-header"]' if route.startswith('tasks/') else 'textarea'); settle()
 # Theme state is browser preference; navigation does not remount its provider.
 js('document.documentElement.classList.toggle("light",'+str(theme=='light').lower()+'); document.documentElement.classList.toggle("dark",'+str(theme=='dark').lower()+')')
 return w,h
def capture(frame,name,theme,route,action=None,density='comfortable',width='wide'):
 w,h=prepare(frame,theme,route,density,width)
 if route=='new':
  cmd('fill','textarea','Add a dark mode toggle to the settings page. Remember the user’s preference between visits.')
  js('document.activeElement.blur()'); settle()
 if action: action()
 settle(); js('document.fonts.ready'); path=OUT/f'{name}-browser.png';cmd('screenshot',str(path))
 design=OUT/f'{frame}-design.png'
 if not design.exists():
  im=Image.open(PARENT/'.ai/design-reference/iteration-2/design'/f'{frame}.png'); im.resize((w,h),Image.Resampling.LANCZOS).save(design)
 proof=js('JSON.stringify({url:location.href,font:getComputedStyle(document.body).fontFamily,density:document.documentElement.dataset.density,width:document.documentElement.dataset.width,theme:document.documentElement.className,overflow:document.documentElement.scrollWidth>innerWidth,assets:performance.getEntriesByType("resource").map(x=>x.name).filter(x=>x.includes("/assets/")),controls:[...document.querySelectorAll("button")].map(x=>x.getAttribute("aria-label")||x.innerText)})')
 records.append(dict(frame=frame,frameName=frames[frame]['name'],name=name,viewport=dict(width=w,height=h),theme=theme,density=density,readingWidth=width,fixture='serve-fixture.mjs',browser=path.name,design=design.name,browserProof=proof,verdict='pending visual inspection'))
 (OUT/'captures.json').write_text(json.dumps(records,indent=2)); print(name,flush=True)
def click(label):cmd('click',f'[aria-label="{label}"]')
def menu():click('Run actions')
def menuitem(text):
 menu(); js('Array.from(document.querySelectorAll("[role=menuitem]")).find(x=>x.textContent.trim()==='+json.dumps(text)+')?.click()')
for frame,name,theme in [('xD5Vz','start-mobile-light','light'),('NMS9D','start-mobile-dark','dark'),('twLlb','start-desktop-light','light'),('qtABD','start-desktop-dark','dark'),('HU3Q7','starters-light','light'),('R5A7rF','starters-dark','dark')]:capture(frame,name,theme,'new')
for frame,name,theme in [('gC8ds','session-desktop-light','light'),('RWNTz','session-desktop-dark','dark'),('StTvu','session-mobile-light','light'),('SAzUR','session-mobile-dark','dark')]:capture(frame,name,theme,'tasks/fixture-session')
def expand(): js('document.querySelector("[data-slot=ctx-group] button")?.click()')
for frame,name,theme in [('Dr8VY','activity-desktop-light','light'),('HJtbl','activity-desktop-dark','dark'),('laAFF','activity-mobile-light','light'),('yjIzI','activity-mobile-dark','dark')]:capture(frame,name,theme,'tasks/fixture-session',expand)
for theme in ['light','dark']:
 for mobile in [False,True]:
  frame=('DgFDf' if theme=='light' else 'xHfq2') if mobile else ('dABhL' if theme=='light' else 'Fsizd'); suffix=('mobile' if mobile else 'desktop')+'-'+theme
  capture(frame,'actions-'+suffix,theme,'tasks/fixture-review',menu)
  capture(frame,'notes-'+suffix,theme,'tasks/fixture-review',lambda:menuitem('Notes'))
  capture(frame,'chooser-'+suffix,theme,'tasks/fixture-review',lambda:menuitem('Open in…'))
  for action in ['Finish','Archive','Delete']:
   capture(frame if mobile else ('ghWjg' if theme=='light' else 'uSLd4'),'confirm-'+action.lower()+'-'+suffix,theme,'tasks/fixture-review',lambda action=action:menuitem(action))
for theme in ['light','dark']:
 for density in ['comfortable','compact','ultra']:
  for width in ['narrow','wide']:capture('hkFbY','reading-'+theme+'-'+density+'-'+width,theme,'tasks/fixture-session',density=density,width=width)
for theme in ['light','dark']:
 for mobile in [False,True]:
  frame=('xD5Vz' if theme=='light' else 'NMS9D') if mobile else ('twLlb' if theme=='light' else 'qtABD')
  for label in ['Model','Runner','Effort','Parallel variants','Base branch','Choose a skill or workflow','Insert a prompt template']:
   capture(frame,'picker-'+label.lower().replace(' ','-').replace('/','-')+'-'+('mobile' if mobile else 'desktop')+'-'+theme,theme,'new',lambda label=label:click(label))
