import os,subprocess,json,time,pathlib,hashlib
root=pathlib.Path(__file__).resolve().parent
env=os.environ.copy()
# Worker ownership/task variables must never enter mock runner tests.
for key in list(env):
 if key.startswith('CEZ_'):env.pop(key,None)
env.update(CEZ_HOME='/tmp/cezar-final-86a5-home',TMPDIR='/tmp',TMP='/tmp',TEMP='/tmp')
results=[]
def record(name,cmd,code,start):
 r=dict(command=' '.join(cmd),exitCode=code,seconds=round(time.time()-start,1));results.append(r);(root/'isolated-final-gate-results.json').write_text(json.dumps(results,indent=2)+'\n');print(name,r,flush=True)
def run(name,cmd):
 start=time.time()
 with (root/('isolated-final-'+name+'.log')).open('w') as f:code=subprocess.call(cmd,env=env,stdout=f,stderr=subprocess.STDOUT)
 record(name,cmd,code,start);return code
if run('typecheck',['npm','run','typecheck']):raise SystemExit(1)
# Only reads/tests overlap. No build changes a served asset while Chromium is running.
browserEnv=env.copy();browserEnv.update(CEZ_HOME='/tmp/cezar-e2e-86',AGENT_BROWSER_ARGS='--no-sandbox')
browserCmd=['npm','test','--','--config','packages/web/e2e/vitest.config.ts']
browserLog=(root/'isolated-final-browser.log').open('w');browserStart=time.time()
browser=subprocess.Popen(browserCmd,env=browserEnv,stdout=browserLog,stderr=subprocess.STDOUT)
run('test',['npm','test','--','--maxWorkers=4'])
run('test-unit',['npm','run','test:unit'])
browserCode=browser.wait();browserLog.close();(root/'isolated-final-browser-result.json').write_text(json.dumps(dict(command=' '.join(browserCmd),exitCode=browserCode,seconds=round(time.time()-browserStart,1)),indent=2)+'\n');print('browser',browserCode,flush=True)
run('build',['npm','run','build'])
run('test-package',['npm','run','test:package'])

(root/'isolated-final-complete.json').write_text(json.dumps(dict(gates=results,browserExitCode=browserCode,completedAt=time.time()),indent=2)+'\n')
