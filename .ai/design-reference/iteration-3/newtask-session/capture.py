"""Capture the real built fixture. Usage: python3 capture.py AUTHORITATIVE_PARENT_ROOT."""
import json, subprocess, sys, hashlib, time, re
from pathlib import Path
from PIL import Image
ROOT=Path.cwd(); OUT=Path(__file__).resolve().parent; PARENT=Path(sys.argv[1]); B=str(OUT/'browser.sh')
manifest=json.loads((PARENT/'.ai/design-reference/iteration-3/design/manifest.json').read_text())
assert manifest['penFileSha256']=='56a71a27c7795137cab1c0a40a5839edecbacab4014d2d39ddc90f89343275f8'
frames={n['id']:n for n in manifest['frames']}; FILTER=sys.argv[2] if len(sys.argv)>2 else None
records=json.loads((OUT/'captures.json').read_text()) if FILTER and (OUT/'captures.json').exists() else []
if FILTER: records=[r for r in records if not re.search(FILTER,r['name'])]

def cmd(*args):
 r=subprocess.run([B,*args],text=True,capture_output=True,timeout=40)
 if r.returncode: raise RuntimeError(r.stdout+r.stderr)
 return r.stdout
def js(code): return cmd('eval',code)
def settle(): js('new Promise(resolve => setTimeout(resolve, 250))')
def prepare(frame, theme, route, density='comfortable', width='wide'):
 for i,key in enumerate(['session','worker','review','variant','activity'],1): route=route.replace('fixture-'+key,'10000000-0000-4000-8000-00000000000'+str(i))
 f=frames[frame]; im=Image.open(PARENT/'.ai/design-reference/iteration-3/design'/f'{frame}.png'); w=int(f['width']); h=f.get('height'); h=int(h) if isinstance(h,(int,float)) else round(im.height*w/im.width)
 cmd('set','viewport',str(w),str(h)); js("fetch('/api/v1/workspace/ui-state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({appearance:"+json.dumps(dict(accent='cezarion',density=density,width=width))+"})}).then(r=>r.status)")
 js('localStorage.setItem("cez-theme",'+json.dumps(theme)+')')
 cmd('open','http://127.0.0.1:44636/p/default/'+route); cmd('wait','[data-slot="run-header"]' if route.startswith('tasks/') else 'textarea'); settle()
 # Theme state is browser preference; navigation does not remount its provider.
 js('document.documentElement.classList.toggle("light",'+str(theme=='light').lower()+'); document.documentElement.classList.toggle("dark",'+str(theme=='dark').lower()+')')
 js('document.querySelector("[data-slot=main]")?.scrollTo({top:0,behavior:"instant"})'); settle()
 return w,h
def capture(frame,name,theme,route,action=None,density='comfortable',width='wide'):
 if FILTER and not re.search(FILTER,name): return
 w,h=prepare(frame,theme,route,density,width)
 if route=='new':
  cmd('fill','textarea','Add a dark mode toggle to the settings page. Remember the user’s preference between visits.')
  js('document.activeElement.blur()'); settle()
 if action: action()
 settle(); js('document.fonts.ready'); path=OUT/f'{name}-browser.png';cmd('screenshot',str(path))
 design=OUT/f'{frame}-design.png'
 if not design.exists():
  im=Image.open(PARENT/'.ai/design-reference/iteration-3/design'/f'{frame}.png'); im.resize((w,h),Image.Resampling.LANCZOS).save(design)
 proof=js('JSON.stringify({url:location.href,font:getComputedStyle(document.body).fontFamily,density:document.documentElement.dataset.density,width:document.documentElement.dataset.width,theme:document.documentElement.className,overflow:document.documentElement.scrollWidth>innerWidth,assets:performance.getEntriesByType("resource").map(x=>x.name).filter(x=>x.includes("/assets/")),controls:[...document.querySelectorAll("button")].map(x=>x.getAttribute("aria-label")||x.innerText)})')
 records.append(dict(sourceSha256=manifest['penFileSha256'],fixtureSha256=hashlib.sha256((OUT/'serve-fixture.mjs').read_bytes()).hexdigest(),frame=frame,frameName=frames[frame]['name'],name=name,viewport=dict(width=w,height=h),theme=theme,density=density,readingWidth=width,buildIndexSha256=hashlib.sha256((ROOT/'packages/cezar/web/dist/index.html').read_bytes()).hexdigest(),fixture='serve-fixture.mjs',browser=path.name,design=design.name,browserProof=proof,verdict='pending visual inspection'))
 (OUT/'captures.json').write_text(json.dumps(records,indent=2)); print(name,flush=True)
def click(label):
 selector=f'[aria-label="{label}"]'
 js('(()=>{const e=document.querySelector('+json.dumps(selector)+');const r=e.getBoundingClientRect();if(r.top<0||r.bottom>innerHeight)e.scrollIntoView({block:"center",behavior:"instant"});})()'); settle()
 cmd('click',selector)
def menu():click('Run actions')
def menuitem(text):
 menu(); js('Array.from(document.querySelectorAll("[role=menuitem]")).find(x=>x.textContent.trim()==='+json.dumps(text)+')?.click()')
for frame,name,theme in [('x4dva','start-mobile-light','light'),('yhesD','start-mobile-dark','dark'),('mZMB8','start-desktop-light','light'),('Pusy6','start-desktop-dark','dark'),('O2W1k','starters-light','light'),('pf8QM','starters-dark','dark')]:capture(frame,name,theme,'new')
for frame,name,theme in [('cgGWE','session-desktop-light','light'),('igwKt','session-desktop-dark','dark'),('gVXYn','session-mobile-light','light'),('nu4S5','session-mobile-dark','dark')]:capture(frame,name,theme,'tasks/fixture-session')
def expand():
 js('document.querySelector("[data-slot=ctx-group] button")?.click()'); settle()
 js('document.querySelectorAll("[data-slot=tool-card] > button[aria-expanded=false]").forEach(x=>x.click())'); settle()
for frame,name,theme in [('HYltX','activity-desktop-light','light'),('r7humJ','activity-desktop-dark','dark'),('zwIL4','activity-mobile-light','light'),('es88m','activity-mobile-dark','dark')]:capture(frame,name,theme,'tasks/fixture-activity',expand)
for theme in ['light','dark']:
 for mobile in [False,True]:
  frame=('ogTQi' if theme=='light' else 'myX8Q') if mobile else ('ZhHkR' if theme=='light' else 'ef75D'); suffix=('mobile' if mobile else 'desktop')+'-'+theme
  capture(frame,'actions-'+suffix,theme,'tasks/fixture-review',menu)
  capture(frame,'notes-'+suffix,theme,'tasks/fixture-review',lambda:menuitem('Notes / handoff'))
  capture(frame,'chooser-'+suffix,theme,'tasks/fixture-review',lambda:menuitem('Open in…'))
  for action in ['Finish','Archive','Delete']:
   capture(frame if mobile else ('rEzlh' if theme=='light' else 'c6ANji'),'confirm-'+action.lower()+'-'+suffix,theme,'tasks/fixture-review',lambda action=action:menuitem({'Archive':'Archive task','Delete':'Delete task…'}.get(action,action)))
for theme in ['light','dark']:
 for density in ['comfortable','compact','ultra']:
  for width in ['narrow','wide']:capture('OeHGM','reading-'+theme+'-'+density+'-'+width,theme,'tasks/fixture-session',density=density,width=width)
for theme in ['light','dark']:
 for mobile in [False,True]:
  frame=('x4dva' if theme=='light' else 'yhesD') if mobile else ('mZMB8' if theme=='light' else 'Pusy6')
  for label in ['Model','Runner','Effort','Parallel variants','Base branch','Choose a skill or workflow','Insert a prompt template']:
   capture(frame,'picker-'+label.lower().replace(' ','-').replace('/','-')+'-'+('mobile' if mobile else 'desktop')+'-'+theme,theme,'new',lambda label=label:click(label))
