import json,pathlib,subprocess,datetime,shutil,hashlib
out=pathlib.Path(__file__).resolve().parent
base='http://127.0.0.1:44635'
primary=json.load(open(out/'capture-inventory.json'))
proof=json.load(open(out/'source-proof.json'))
def b(*args):
 p=subprocess.run([str(out/'browser.sh'),*args],text=True,capture_output=True,timeout=40)
 if p.returncode:raise RuntimeError(p.stdout+p.stderr)
 return p.stdout.strip()
def js(s):return b('eval',s)
def click(text):js('Array.from(document.querySelectorAll("button")).find(e=>e.textContent.trim()==='+json.dumps(text)+')?.click()')
rows=[]
for theme,frame_id in [('light','M5SWe'),('dark','ofMmL')]:
 frame=next(r for r in primary if r['id']==frame_id)
 b('set','viewport',str(frame['width']),str(frame['height']));js('localStorage.setItem("cez-theme",'+json.dumps(theme)+')');b('open',base+'/p/default/');b('wait','[data-slot=task-summary-row]')
 js('document.querySelector("[data-slot=task-columns-trigger]").click()');click('Resource columns');b('wait','[data-slot=tasks-table] table')
 # The column choice is a reversible write to the isolated fixture CEZ_HOME only.
 js('Array.from(document.querySelectorAll("[data-column-toggle]")).filter(e=>!e.checked).forEach(e=>e.click())');b('wait','600')
 for state in ['all-resource-columns','inline-rename']:
  if state=='inline-rename':
   b('press','Escape');js('document.querySelector("[data-slot=task-table-row] [data-slot=row-rename]").click()');b('wait','[data-slot=table-title-editor]')
  b('wait','400');name=frame_id+'-'+state;dest=out/'pairs'/(name+'-browser.png');b('screenshot',str(dest));shutil.copy2(out/frame['design'],out/'pairs'/(name+'-design.png'))
  observed=json.loads(json.loads(js('JSON.stringify({text:document.querySelector("[data-route=tasks]").innerText,width:innerWidth,height:innerHeight,theme:document.documentElement.classList.contains("light")?"light":"dark"})')))
  rows.append({'state':state,'theme':theme,'width':frame['width'],'height':frame['height'],'designBoard':frame_id,'browser':'pairs/'+dest.name,'design':'pairs/'+name+'-design.png','observed':observed,'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()})
(out/'list-detail-inventory.json').write_text(json.dumps(rows,indent=2))
for file,sha in proof['sourceFiles'].items():assert hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest()==sha
(out/'list-detail-proof.json').write_text(json.dumps({'sourceProof':proof,'builtIndexSha256':hashlib.sha256(pathlib.Path('packages/cezar/web/dist/index.html').read_bytes()).hexdigest(),'baseUrl':base,'captureCount':len(rows)},indent=2))
