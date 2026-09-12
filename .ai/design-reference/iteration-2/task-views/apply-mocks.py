import json,pathlib,subprocess
out=pathlib.Path(__file__).resolve().parent
for m in json.load(open(out/'populated-mocks.json')):
 for prefix in ['**/api/v1','**/api/v1/p/*']:
  subprocess.run([str(out/'browser.sh'),'network','unroute',prefix+m['path']],check=True,stdout=subprocess.DEVNULL)
  subprocess.run([str(out/'browser.sh'),'network','route',prefix+m['path'],'--body',json.dumps(m['body'])],check=True,stdout=subprocess.DEVNULL)
print('Applied contract-validated local fixtures.')

subprocess.run([str(out/"browser.sh"),"network","unroute","**/api/v1/workspace/events*"],check=True,stdout=subprocess.DEVNULL)
subprocess.run([str(out/"browser.sh"),"network","route","**/api/v1/workspace/events*","--abort"],check=True,stdout=subprocess.DEVNULL)
