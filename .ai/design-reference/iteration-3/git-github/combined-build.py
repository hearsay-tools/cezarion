import json,pathlib,subprocess,tarfile,io,shutil,hashlib,os
root=pathlib.Path(__file__).resolve().parents[4]
qa=root/'.ai/qa/git-combined-source'
parent='4d7723df';worker='901f75af'
paths=['packages','scripts','package.json','package-lock.json','vitest.config.ts','README.md','LICENSE','AGENTS.md','.gitignore','cezarion.pen','.ai/qa/runtime-verified']
assert not qa.exists(), 'Choose a fresh disposable snapshot directory; do not overwrite an existing build.'
qa.mkdir(parents=True)
archive=subprocess.check_output(['git','archive',parent,'--',*paths],cwd=root)
with tarfile.open(fileobj=io.BytesIO(archive)) as tar:tar.extractall(qa,filter='data')
overlay=[]
for family in ['repo-git','task-git','github']:
 path='packages/web/src/routes/'+family
 archive=subprocess.check_output(['git','archive',worker,'--',path],cwd=root)
 with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
  overlay.extend(m.name for m in tar.getmembers() if m.isfile())
  tar.extractall(qa,filter='data')
for scope,pkgs in [('@open-mercato',['cezar-contract','cezar-api-client']),('@wjarka',['cezarion'])]:
 d=qa/'node_modules'/scope;d.mkdir(parents=True,exist_ok=True)
 for pkg in pkgs:
  target={'cezar-contract':'contract','cezar-api-client':'api-client','cezarion':'cezar'}[pkg]
  (d/pkg).symlink_to('../../packages/'+target)
env={'PATH':os.environ['PATH']}
def git(*args):return subprocess.check_output(['git',*args],cwd=qa,env=env,text=True).strip()
git('init','-q');git('config','user.name','Isolated QA');git('config','user.email','fixture@example.test');git('add','--',*paths[:-1]);git('add','-f','--','.ai/qa/runtime-verified');git('commit','-qm','Isolated QA snapshot: parent shell 4d7723df with Git routes 901f75af')
proof={'parentBaseline':subprocess.check_output(['git','rev-parse',parent],cwd=root,text=True).strip(),'workerAppCommit':subprocess.check_output(['git','rev-parse',worker],cwd=root,text=True).strip(),'snapshotCommit':git('rev-parse','HEAD'),'sourceSha256':hashlib.sha256((qa/'cezarion.pen').read_bytes()).hexdigest(),'overlayFiles':{p:hashlib.sha256((qa/p).read_bytes()).hexdigest() for p in overlay},'snapshotPath':str(qa),'purpose':'Disposable combined-build QA only; no merge or parent working-tree changes.'}
(root/'.ai/design-reference/iteration-3/git-github/combined-source-proof.json').write_text(json.dumps(proof,indent=2))
print(json.dumps({k:v for k,v in proof.items() if k!='overlayFiles'},indent=2))
