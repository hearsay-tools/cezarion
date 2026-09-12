import os,subprocess,json,time,pathlib,hashlib
root=pathlib.Path(__file__).resolve().parent
env={k:v for k,v in os.environ.items() if not k.startswith('CEZ_')}
env.update(CEZ_HOME='/tmp/cezar-final-86a5-home',TMPDIR='/tmp',TMP='/tmp',TEMP='/tmp')
results=[]
def run(name,cmd,runenv=env):
 start=time.time()
 with (root/('final-serial-'+name+'.log')).open('w') as f:code=subprocess.call(cmd,env=runenv,stdout=f,stderr=subprocess.STDOUT)
 result=dict(name=name,command=' '.join(cmd),exitCode=code,seconds=round(time.time()-start,1));results.append(result)
 (root/'final-serial-results.json').write_text(json.dumps(results,indent=2)+'\n');print(result,flush=True)
 return code
for name,cmd in [('typecheck',['npm','run','typecheck']),('test',['npm','test','--','--maxWorkers=4']),('test-unit',['npm','run','test:unit']),('build',['npm','run','build']),('test-package',['npm','run','test:package'])]:
 if run(name,cmd):raise SystemExit(1)
browserenv=env.copy();browserenv.update(CEZ_HOME='/tmp/cezar-e2e-86',AGENT_BROWSER_ARGS='--no-sandbox')
code=run('browser',['npm','test','--','--config','packages/web/e2e/vitest.config.ts'],browserenv)
(root/'final-serial-complete.json').write_text(json.dumps(dict(results=results,completedAt=time.time(),exitCode=code),indent=2)+'\n')
raise SystemExit(code)
