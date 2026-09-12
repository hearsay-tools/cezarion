#!/usr/bin/env python3
import json,pathlib,subprocess,urllib.request,datetime,copy,shutil,hashlib
out=pathlib.Path(__file__).resolve().parent
base='http://127.0.0.1:44635'
design=pathlib.Path('/home/agent/projects/cezar/.ai/cezar/worktrees/9ae05dcc-cc09-405c-9934-ab364076aa21/.ai/design-reference/iteration-3/design')
fixtures={m['path']:m['body'] for m in json.load(open(out/'populated-mocks.json'))}
health=json.load(urllib.request.urlopen(base+'/api/v1/health'))
source_proof=json.load(open(out/'source-proof.json'))
for file,sha in source_proof['sourceFiles'].items():assert hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest()==sha
build_sha=hashlib.sha256(pathlib.Path('packages/cezar/web/dist/index.html').read_bytes()).hexdigest()
def b(*args):
 p=subprocess.run([str(out/'browser.sh'),*args],text=True,capture_output=True,timeout=40)
 if p.returncode:raise RuntimeError(p.stdout+p.stderr)
 return p.stdout.strip()
def js(s):return b('eval',s)
def mock(path,body):
 b('network','unroute','**/api/v1'+path);b('network','unroute','**/api/v1/p/*'+path);b('network','route','**/api/v1'+path,'--body',json.dumps(body))
def open_route(path):b('open',base+path);b('wait','700')
def click(text):js('Array.from(document.querySelectorAll("button")).find(e=>e.textContent.trim()==='+json.dumps(text)+')?.click()')
rows=[]
def snap(state,theme,board):
 b('wait','400');observed=json.loads(json.loads(js('JSON.stringify({text:document.body.innerText,url:location.href})')))
 expected={'inbox-off':'Inbox is off','automations-off':'GitHub automations are off','inbox-empty':'You’re all caught up','automations-empty':'No automations yet','variants-waiting':'Variants are still running','variants-error':'Could not load variants','variant-confirm':'Pick','plan-save':'Chain name','plan-overwrite':'Overwrite chain'}[state]
 assert expected.lower() in observed['text'].lower(), (state,observed['text'])
 name=f'{board}-{state}-{theme}'
 b('screenshot',str(out/'pairs'/f'{name}-browser.png'))
 shutil.copy2(design/(board+'.png'),out/'pairs'/f'{name}-design.png')
 rows.append({'state':state,'theme':theme,'width':1440,'height':1320 if board in ['rEzlh','c6ANji'] else 1100,'designBoard':board,'design':f'pairs/{name}-design.png','browser':f'pairs/{name}-browser.png','observed':json.loads(json.loads(js('JSON.stringify({text:document.body.innerText,url:location.href,dialog:document.querySelector("[role=dialog], [role=alertdialog]")?.innerText})'))),'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'verdict':'Interim; composite source board shows several distinct dialogs/states, browser capture isolates the named state.'})
 (out/'state-capture-inventory.json').write_text(json.dumps(rows,indent=2));print(name,flush=True)
for theme,board,dialog in [('light','mpyjl','rEzlh'),('dark','NQePM','c6ANji')]:
 b('set','viewport','1440','1100');js('localStorage.setItem("cez-theme",'+json.dumps(theme)+')')
 off=copy.deepcopy(health);off['capabilities']['followups']=False;off['capabilities']['automations']=False;off['capabilities']['localHandoff']=False
 mock('/health',off);open_route('/p/default/inbox');snap('inbox-off',theme,board)
 open_route('/p/default/automations');snap('automations-off',theme,board)
 mock('/health',health);mock('/todos',[]);open_route('/p/default/inbox');snap('inbox-empty',theme,board)
 auto=copy.deepcopy(fixtures['/automations']);auto['automations']=[];mock('/automations',auto);open_route('/p/default/automations');snap('automations-empty',theme,board)
 group=copy.deepcopy(fixtures['/groups/fixture-group']);group['runs'][0]['status']='running';mock('/groups/fixture-group',group);open_route('/p/default/compare/fixture-group');snap('variants-waiting',theme,board)
 b('network','unroute','**/api/v1/groups/fixture-group');b('network','unroute','**/api/v1/p/*/groups/fixture-group');b('network','route','**/api/v1/groups/fixture-group','--abort');open_route('/p/default/compare/fixture-group');b('wait','--text','Could not load variants');snap('variants-error',theme,board)
 mock('/groups/fixture-group',fixtures['/groups/fixture-group']);b('set','viewport','1440','1320');open_route('/p/default/compare/fixture-group');js('document.querySelector("[data-slot=variant-pick]").click()');snap('variant-confirm',theme,dialog)
 open_route('/p/default/new');b('fill','[aria-label="Describe a task for the agent"]','Plan a multi-step implementation for a new issue');js('Array.from(document.querySelectorAll("[role=radio]")).find(e=>e.textContent.includes("Plan first"))?.click()');click('Plan task');b('wait','500');click('Save as chain');b('fill','#plan-chain-name','fix-and-verify-v2');js('document.activeElement.blur()');snap('plan-save',theme,dialog)
 js('window.originalTaskViewFetch=window.fetch; window.fetch=async(input,init)=>{const url=String(input instanceof Request?input.url:input);if(url.endsWith("/workflows")&&init?.method==="POST")return new Response(JSON.stringify({error:"A workflow with this name already exists",exists:true}),{status:409,headers:{"content-type":"application/json"}});return window.originalTaskViewFetch(input,init)}')
 click('Save chain');b('wait','500');snap('plan-overwrite',theme,dialog)
for path,body in fixtures.items():mock(path,body)
mock('/health',health)

for file,sha in source_proof["sourceFiles"].items():assert hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest()==sha
assert hashlib.sha256(pathlib.Path("packages/cezar/web/dist/index.html").read_bytes()).hexdigest()==build_sha
(out/"state-capture-proof.json").write_text(json.dumps({"sourceProof":source_proof,"builtIndexSha256":build_sha,"captureCount":len(rows),"designSha256":source_proof["sourceDesignSha256"],"baseUrl":base},indent=2))
