import os, subprocess, json, time, pathlib
root=pathlib.Path(__file__).resolve().parent
env=os.environ.copy()
for key in ['CEZ_AUTOMATIONS','CEZ_FOLLOWUPS']: env.pop(key,None)
env.update(CEZ_HOME='/tmp/cezar-final-86a5-home',TMPDIR='/tmp',TMP='/tmp',TEMP='/tmp')
results=[]
for name,cmd in [('typecheck',['npm','run','typecheck']),('test',['npm','test','--','--maxWorkers=4']),('test-unit',['npm','run','test:unit']),('build',['npm','run','build']),('test-package',['npm','run','test:package'])]:
 start=time.time()
 with (root/('final-bundle-'+name+'.log')).open('w') as f: code=subprocess.call(cmd,env=env,stdout=f,stderr=subprocess.STDOUT)
 results.append(dict(command=' '.join(cmd),exitCode=code,seconds=round(time.time()-start,1)))
 (root/'final-bundle-gate-results.json').write_text(json.dumps(results,indent=2)+'\n')
 print(results[-1],flush=True)
