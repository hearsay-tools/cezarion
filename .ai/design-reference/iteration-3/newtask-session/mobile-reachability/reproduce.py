import subprocess,json,hashlib,time
from pathlib import Path
P=Path(__file__).resolve().parent;B=str(P.parent/'browser.sh')
def cmd(*a):return subprocess.run([B,'--session','newtask-reachability-06',*a],check=True,text=True,capture_output=True).stdout
def js(s):
 x=json.loads(cmd('eval','JSON.stringify('+s+')'));return json.loads(x) if isinstance(x,str) else x
results=[]
for width,height in [(360,640),(390,844)]:
 for density in ['comfortable','compact','ultra']:
  for theme in ['light','dark']:
   cmd('set','viewport',str(width),str(height));cmd('open','http://127.0.0.1:44636/p/default/new');cmd('wait','textarea')
   cmd('fill','textarea','Verify that every execution control remains reachable.')
   cmd('eval',f'document.documentElement.dataset.density="{density}";document.documentElement.classList.toggle("light",{str(theme=="light").lower()});document.documentElement.classList.toggle("dark",{str(theme=="dark").lower()});document.querySelector("[data-slot=main]").scrollTop=0')
   time.sleep(.5)
   record=dict(viewport=[width,height],density=density,theme=theme,controls=[])
   if width==360 and density=='comfortable' and theme=='light':cmd('screenshot',str(P/'before-scroll.png'))
   for slot in ['variants-pill','base-pill']:
    selector=f'[data-slot="{slot}"]'
    before=js(f'(()=>{{const e=document.querySelector({json.dumps(selector)}),r=e.getBoundingClientRect();return {{top:r.top,bottom:r.bottom,width:r.width,height:r.height,visible:e.checkVisibility(),viewportHeight:innerHeight}}}})()')
    cmd('eval',f'document.querySelector({json.dumps(selector)}).scrollIntoView({{block:"center",inline:"nearest",behavior:"instant"}})');time.sleep(.5)
    after=js(f'(()=>{{const e=document.querySelector({json.dumps(selector)}),r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {{top:r.top,bottom:r.bottom,width:r.width,height:r.height,hit:e===hit||e.contains(hit),scrollTop:document.querySelector("[data-slot=main]").scrollTop}}}})()')
    assert after['width']>=43.9 and after['height']>=43.9 and after['top']>=0 and after['bottom']<=height and after['hit'],after
    cmd('click',selector)
    opened=js('Boolean(document.querySelector("[role=menu], [role=listbox], [data-slot=command]"))')
    assert opened,(slot,'no popup')
    if slot=='base-pill' and width==360 and density=='comfortable' and theme=='light':cmd('screenshot',str(P/'after-scroll-click.png'))
    cmd('press','Escape');time.sleep(.4);record['controls'].append(dict(slot=slot,before=before,after=after,realClickOpenedMenu=opened))
   selector='[aria-label="Start task"]';cmd('eval',f'document.querySelector({json.dumps(selector)}).scrollIntoView({{block:"center",behavior:"instant"}})');time.sleep(.5)
   record['start']=js('(()=>{const e=document.querySelector("[aria-label=\\"Start task\\"]"),r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {top:r.top,bottom:r.bottom,height:r.height,width:r.width,hit:e===hit||e.contains(hit),enabled:!e.disabled}})()')
   assert record['start']['hit'] and record['start']['enabled'] and record['start']['height']>=44
   results.append(record)
(P/'proof.json').write_text(json.dumps({'codeCommit':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'buildIndexSha256':hashlib.sha256(Path('packages/cezar/web/dist/index.html').read_bytes()).hexdigest(),'states':results},indent=2)+'\n')
print('12 states: real variant/base menu clicks and enabled44px submit hit targets pass')
