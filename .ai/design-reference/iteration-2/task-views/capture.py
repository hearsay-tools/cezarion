#!/usr/bin/env python3
"""Capture owned routes against the confirmed current design using browser-only fixtures.
Run from this worktree after building, starting the isolated fixture and applying populated-mocks.
The source design directory and base URL are arguments; no external writes are performed.
"""
import json, pathlib, subprocess, sys, hashlib, datetime, re, shutil
out=pathlib.Path(__file__).resolve().parent
source=pathlib.Path.cwd()
design=pathlib.Path(sys.argv[1])
base=sys.argv[2] if len(sys.argv)>2 else 'http://127.0.0.1:44635'
manifest=json.load(open(design/'manifest.json'))
assert manifest['penFileSha256']=='56a71a27c7795137cab1c0a40a5839edecbacab4014d2d39ddc90f89343275f8'
def browser(*args):
 r=subprocess.run([str(out/'browser.sh'),*args],text=True,capture_output=True,timeout=40)
 if r.returncode: raise RuntimeError(r.stdout+r.stderr)
 return r.stdout.strip()
def js(s):return browser('eval',s)
def click_text(s):js('Array.from(document.querySelectorAll("button")).find(e=>e.textContent.trim()==='+json.dumps(s)+')?.click()')
def route_for(name):
 if name.startswith(('4','25')):return '/p/default/'
 if name.startswith(('5','26')):return '/tasks'+('?group=project' if name.startswith('26') else '')
 if name.startswith('19'):return '/p/default/inbox'
 if name.startswith('20B'):return '/p/default/automations/fixture-auto'
 if name.startswith('20A'):return '/p/default/automations'
 if name.startswith('21'):return '/p/default/compare/fixture-group'
 if name.startswith('22'):return '/p/default/new'
 return None
source_proof=json.load(open(out/'source-proof.json'))
for file,sha in source_proof['sourceFiles'].items():
 assert hashlib.sha256((source/file).read_bytes()).hexdigest()==sha, f'Source changed before capture: {file}'
rows=[]
(out/'pairs').mkdir(exist_ok=True)
for frame in manifest['frames']:
 name=frame['name'];route=route_for(name)
 if not route:continue
 # Some mobile exports include content beyond the declared frame height. Match
 # the actual 2x PNG canvas, retaining declared bounds for reproducibility.
 if frame.get('pngWidth') == frame['width'] * 2 and frame.get('pngHeight') != frame['height'] * 2:
  frame={**frame,'declaredWidth':frame['width'],'declaredHeight':frame['height'],'height':round(frame['pngHeight']/2),'viewportBasis':'actual PNG canvas at verified 2x horizontal scale; exported vertical overflow included'}
 theme='dark' if 'dark' in name.lower() else 'light'
 browser('set','viewport',str(frame['width']),str(frame['height']))
 js('localStorage.setItem("cez-theme",'+json.dumps(theme)+')')
 todos=next(x['body'] for x in json.load(open(out/'populated-mocks.json')) if x['path']=='/todos')
 browser('network','unroute','**/api/v1/todos')
 browser('network','unroute','**/api/v1/p/*/todos')
 browser('network','route','**/api/v1/todos','--body',json.dumps([] if name.startswith('19B') else todos))
 browser('open',base+route)
 browser('wait','500')
 if name.startswith(('4','25')): browser('wait','[data-slot=task-card]' if frame['width']<768 else '[data-slot=task-summary-row]')
 if name.startswith(('5','26')): browser('wait','[data-slot=global-task-row]')
 if name.startswith('19A'): browser('wait','[data-slot=todo-card]')
 if name.startswith('19B'): browser('wait','--text','You’re all caught up')
 if name.startswith('20A'): browser('wait','[data-route=automations] article')
 if name.startswith('20B'): browser('wait','#automation-name')
 if name.startswith('21'): browser('wait','[data-slot=variant-pick]')
 if name.startswith('22'): browser('wait','[aria-label="Describe a task for the agent"]')
 if name.startswith('19A'):
  js('document.querySelector("[data-slot=todo-instructions-toggle]")?.click()')
  browser('fill','[data-slot="todo-instructions-input"]','Use the existing integration fixtures. Keep the test isolated from GitHub.')
  js('document.activeElement.blur()')
 if name.startswith('25A'):
  js('document.querySelector("[data-slot=task-columns-trigger]")?.click()');click_text('Resource columns')
 if name.startswith('22'):
  browser('fill','[aria-label="Describe a task for the agent"]','Plan a multi-step implementation for a new issue')
  js('Array.from(document.querySelectorAll("[role=radio]")).find(e=>e.textContent.includes("Plan first"))?.click()')
  click_text('Plan task');browser('wait','500')
 browser('wait','400')
 dest=out/'pairs'/f'{frame["id"]}-browser.png';browser('screenshot',str(dest))
 shutil.copy2(design/frame['screenshot'],out/'pairs'/f'{frame["id"]}-design.png')
 observed=js('JSON.stringify({url:location.href,width:innerWidth,height:innerHeight,font:getComputedStyle(document.body).fontFamily,theme:document.documentElement.classList.contains("light")?"light":"dark",density:document.documentElement.dataset.density??"comfortable",text:(document.querySelector("[data-route]")??document.body).innerText,dialog:document.querySelector("[data-slot=plan-review]")?.innerText})')
 observed_data=json.loads(json.loads(observed))
 assert observed_data['width']==frame['width'] and observed_data['height']==frame['height']
 assert observed_data['theme']==theme
 assert 'Loading…' != observed_data['text'], name
 if name.startswith(('4','25')): assert '213: fixing finalization failure' in observed_data['text'], name
 if name.startswith('19B'): assert 'You’re all caught up' in observed_data['text'], name
 row={**frame,'route':route,'theme':theme,'browser':str(dest.relative_to(out)),'design':f'pairs/{frame["id"]}-design.png','capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'observed':json.loads(json.loads(observed)),'verdict':'Integrated shell capture; requires individual visual inspection.'}
 rows.append(row);(out/'capture-inventory.json').write_text(json.dumps(rows,indent=2))
 print(frame['id'],name,flush=True)
for file,sha in source_proof['sourceFiles'].items():
 assert hashlib.sha256((source/file).read_bytes()).hexdigest()==sha, f'Source changed during capture: {file}'
proof={'sourceProofSha256':hashlib.sha256((out/'source-proof.json').read_bytes()).hexdigest(),'designSha256':manifest['penFileSha256'],'sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'sourceDiffSha256':hashlib.sha256(subprocess.check_output(['git','diff','--','packages/web/src/routes'])).hexdigest(),'builtIndexSha256':hashlib.sha256((source/'packages/cezar/web/dist/index.html').read_bytes()).hexdigest(),'baseUrl':base,'captureCount':len(rows),'limitations':'Owned source and parent shell/glyph commits are integrated. Capture integrity alone does not certify whole-frame fidelity.'}
(out/'capture-proof.json').write_text(json.dumps(proof,indent=2))
