import json, pathlib, subprocess, urllib.request, copy
out=pathlib.Path(__file__).parent
base='http://127.0.0.1:44659'
m=json.load(open(out/'mock-api.json'))['mocks']
listing=next(x['body'] for x in m if x['path']=='/github?*')
seed=listing['issues'][0]
titles=['Investigate finalization failure','Add bounded loop steps to workflows','Fix mobile skill picker scrolling','Add workers sharing their parent workspace','Add scoped communication between workers','Add bounded recursive worker delegation']
listing['issues']=[dict(copy.deepcopy(seed),number=219+i,title=title,url=f'https://github.com/example/fixture/issues/{219+i}',labels=['area-ci','github-actions'] if i==0 else ['bug','area-web'] if i==2 else ['enhancement','area-cezar'],checks=None) for i,title in enumerate(titles)]
listing['repo']='hearsay-tools/cezarion'
listing['prs']=listing['prs'][:1]
listing['issues'][0]['body']='A finalization failure interrupted a Release or Nightly run.\n\n## What needs to be done\nDiagnose the failure using the occurrence evidence and check related occurrences before treating it as flaky.\n\n## Acceptance criteria\n- [ ] Identify the cause using the linked run evidence\n- [ ] Ship a fix with regression coverage or documented verification\n- [ ] Verify the affected workflow succeeds after the fix'
repo=json.load(urllib.request.urlopen(base+'/api/v1/repo'))
repo['info'].update(root='/fixture/cezar',remote='hearsay-tools/cezarion')
repo['branches']=['main','bench/156-combined-shards','bench/156-rebalance-optimized','ci/automated-pr-review','feat/complete-worker-delegation','feat/detect-recurring-ci-failures']
repo['log']=[dict(hash=f'a{i}193ab',subject=s,author='wjarka',when='2 hours ago') for i,s in enumerate(['fix(web): keep mobile Enter in the composer','fix(release): make finalization safe to retry','feat(web): expose mobile task search and archive controls','fix(web): clarify workflow editor actions','feat(web): clarify New Task composer hierarchy','feat(web): improve task title layout'])]
m += [dict(path='/repo',body=repo),dict(path='/repo/pull',body={'branches':repo['branches']})]
files=[]
for path,content in [('.opencode/apptension.json',['{','  "plugins": ["apptension-sdlc", "apptension-review"]','}']),('.opencode/plugins/apptension-dev.js',["import fs from 'node:fs';","import os from 'node:os';","import path from 'node:path';"]),('.pencil/design.pen',['{}'])]:
 files.append(dict(path=path,status='added',adds=len(content),dels=0,binary=False,patch=f'diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{len(content)} @@\n'+'\n'.join('+'+x for x in content)+'\n'))
changes=dict(files=files,stat=dict(adds=sum(f['adds'] for f in files),dels=0,files=len(files)))
m += [dict(path='/repo/changes*',body=changes),dict(path='/runs/fixture-session/changes*',body=changes),dict(path='/runs/fixture-session/commits',body={'commits':[dict(sha=x['hash'],subject=x['subject'],author=x['author'],when=x['when']) for x in repo['log'][:1]]})]
entries=[dict(name=x,type='dir') for x in ['.ai','.claude','.github','alias-cezarion','docs','node_modules','packages','scripts']]+[dict(name=x,type='file') for x in ['.env.example','.gitignore','AGENTS.md','CHANGELOG.md','CODE_REVIEW.md','package.json','README.md','SDLC.md','vitest.config.ts']]
m += [dict(path='/runs/fixture-session/files?path=',body=dict(type='dir',path='',entries=entries))]
# GitHub payload structure comes from the parent fixture; analogous reference content is schema-validated.
json.dump({'mocks':m},open(out/'populated-mocks.json','w'),indent=2)
for mock in m:
 for prefix in ['**/api/v1','**/api/v1/p/*']:
  subprocess.run([str(out/'browser.sh'),'network','unroute',prefix+mock['path']],check=True,stdout=subprocess.DEVNULL)
 subprocess.run([str(out/'browser.sh'),'network','route','**/api/v1'+mock['path'],'--body',json.dumps(mock['body'])],check=True,stdout=subprocess.DEVNULL)
 subprocess.run([str(out/'browser.sh'),'network','route','**/api/v1/p/*'+mock['path'],'--body',json.dumps(mock['body'])],check=True,stdout=subprocess.DEVNULL)
print(f'Installed {len(m)} populated fixture responses')
