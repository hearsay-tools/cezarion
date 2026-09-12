import json,subprocess,os,pathlib,hashlib,time,sys,re
root=pathlib.Path.cwd();out=root/'.ai/qa/final-integrated';b=str(root/'.ai/qa/runtime-verified/browser.sh');env=os.environ.copy();env['RUNTIME_BROWSER_SESSION']='final-86a5'
rows=json.loads((out/'coverage-193.json').read_text()); captures=json.loads((out/"captures.json").read_text()) if len(sys.argv)>1 else []
def cmd(*a):
 p=subprocess.run([b,*map(str,a)],env=env,text=True,capture_output=True,timeout=45)
 if p.returncode: raise Exception(p.stdout+p.stderr)
 return p.stdout
def js(code):return cmd('eval',code)
(out/'browser').mkdir(exist_ok=True)
for r in rows:
 if len(sys.argv)>1 and not re.search(sys.argv[1],r['id']):continue
 if r['auditStatus'].startswith('delegated') or not r.get('route'):continue
 try:
  cmd('set','viewport',r['width'],r['height']);js('localStorage.setItem("cez-theme",'+json.dumps(r['theme'])+')');cmd('open','http://127.0.0.1:44786'+r['route']);cmd('wait','400')
  js('document.documentElement.classList.toggle("light",'+str(r['theme']=='light').lower()+');document.documentElement.classList.toggle("dark",'+str(r['theme']=='dark').lower()+');document.fonts.ready')
  if r['route'].endswith('/new'):cmd('fill','textarea','Add a dark mode toggle to the settings page. Remember the user’s preference between visits.');js('document.activeElement.blur()')
  for attempt in range(30):
   if not re.search(r'Loading(?: changes| commits| files| branches|…)',js('document.body.innerText')):break
   cmd('wait','250')
  observed=json.loads(json.loads(js('JSON.stringify({url:location.href,width:innerWidth,height:innerHeight,theme:document.documentElement.className,font:getComputedStyle(document.body).fontFamily,loadedFonts:[...document.fonts].filter(f=>f.status==="loaded").map(f=>f.family),overflow:document.documentElement.scrollWidth>innerWidth,text:document.body.innerText})')))
  js('document.querySelector("[data-slot=main]")?.scrollTo({top:0,behavior:"instant"});window.scrollTo(0,0)');cmd('wait','100')
  dest=out/'browser'/str(r['id']+'.png');cmd('screenshot',dest)
  rec=dict(id=r['id'],name=r['name'],browser=str(dest),sha256=hashlib.sha256(dest.read_bytes()).hexdigest(),observed=observed)
  r['currentBrowser']=str(dest);r['auditStatus']='current route captured; visual/state review pending';captures=[c for c in captures if c["id"]!=r["id"]];captures.append(rec)
 except Exception as e:r['auditStatus']='capture failed: '+str(e)
 (out/'captures.json').write_text(json.dumps(captures,indent=2));(out/'coverage-193.json').write_text(json.dumps(rows,indent=2));print(r['id'],r['auditStatus'],flush=True)
