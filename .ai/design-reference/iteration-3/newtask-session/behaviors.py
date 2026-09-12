"""Exercise reversible UI interactions against the isolated CEZ_DRY_RUN fixture."""
import subprocess,json,time,hashlib
from pathlib import Path
P=Path(__file__).resolve().parent; B=str(P/'browser.sh'); results=[]
def cmd(*a):
 r=subprocess.run([B,*a],capture_output=True,text=True,timeout=40)
 if r.returncode: raise RuntimeError(r.stdout+r.stderr)
 return r.stdout
def js(s):
 x=json.loads(cmd('eval','JSON.stringify('+s+')'))
 return json.loads(x) if isinstance(x,str) else x
def settle():time.sleep(.4)
def click(q):
 cmd('eval','document.querySelector('+json.dumps(q)+').scrollIntoView({block:"center",behavior:"instant"})');cmd('click',q);settle()
def menuitem(label):
 click('[aria-label="Run actions"]');cmd('eval','[...document.querySelectorAll("[role=menuitem]")].find(x=>x.textContent.trim()==='+json.dumps(label)+').click()');settle()
def check(name,proof):
 assert proof,name
 results.append({'name':name,'pass':True,'proof':proof})
route='http://127.0.0.1:44636/p/default/tasks/10000000-0000-4000-8000-000000000004'
cmd('set','viewport','402','874');cmd('open',route);cmd('wait','textarea');settle()
menuitem('Notes / handoff');check('Populated notes open',js('document.querySelector("[data-slot=notes-panel]")?.textContent.includes("retry guard")'))
click('[aria-label="Close notes"]');check('Notes close',js('!document.querySelector("[data-slot=notes-panel]")'))
menuitem('Delete task…');check('Deletion waits at confirmation',js('Boolean(document.querySelector("[role=alertdialog]"))'))
cmd('eval','[...document.querySelectorAll("[role=alertdialog] button")].find(x=>x.textContent.trim()==="Cancel").click()');settle();check('Cancel keeps task',js('!document.querySelector("[role=alertdialog]") && Boolean(document.querySelector("[data-slot=run-header]"))'))
cmd('open',route.replace('000004','000005'));cmd('wait','textarea');settle()
cmd('eval','document.querySelector("[data-slot=ctx-group] button")?.click()');settle()
cmd('eval','document.querySelectorAll("[data-slot=tool-card] > button[aria-expanded=false]").forEach(x=>x.click())');settle()
cmd('eval','(()=>{const e=document.querySelector("[data-slot=main]");e.scrollTop=e.scrollHeight;})()');settle()
cmd('eval','(()=>{const e=document.querySelector("[data-slot=main]");e.dispatchEvent(new WheelEvent("wheel",{deltaY:-300}));e.scrollTo({top:0,behavior:"instant"});})()');settle()
cmd('eval','[...document.querySelectorAll("button")].find(x=>x.textContent.includes("Jump to latest"))?.click()');time.sleep(.8)
check('Jump reaches document tail',js('(()=>{const e=document.querySelector("[data-slot=main]");return {distance:e.scrollHeight-e.clientHeight-e.scrollTop,atTail:e.scrollHeight-e.clientHeight-e.scrollTop<20}})()'))
assert results[-1]['proof']['atTail']
cmd('eval','fetch("/api/v1/workspace/ui-state",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({appearance:{density:"compact",width:"wide",accent:"cezarion"}})}).then(r=>r.status)')
cmd('open',route);cmd('wait','textarea');settle();check('Reading preference survives reload',js('document.documentElement.dataset.width==="wide" && document.documentElement.dataset.density==="compact"'))
cmd('fill','textarea','Verify this dry-run continuation preserves the actual message.');click('[aria-label="Send"]');time.sleep(2)
check('Continuation submitted actual text',js('document.body.textContent.includes("Verify this dry-run continuation preserves the actual message.")'))
(P/'behaviors.json').write_text(json.dumps({'fixture':'serve-fixture.mjs','buildIndexSha256':hashlib.sha256(Path('packages/cezar/web/dist/index.html').read_bytes()).hexdigest(),'checks':results},indent=2))
print(json.dumps(results,indent=2))
