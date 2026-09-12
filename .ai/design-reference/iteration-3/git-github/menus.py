import json,pathlib,subprocess,time
out=pathlib.Path(__file__).parent.resolve()
def b(*args):return subprocess.run([str(out/'browser.sh'),*args],check=True,stdout=subprocess.PIPE,text=True).stdout
rows=[]
for theme in ['light','dark']:
 for width,height in [(1440,1120),(402,1146)]:
  b('set','viewport',str(width),str(height));b('eval',f"localStorage.setItem('cez-theme','{theme}')")
  b('open','http://127.0.0.1:44659/tasks/fixture-session/changes');b('wait','[data-slot="git-toolbar"]')
  for state,selector,wait in [('git-menu','button[aria-label="More git actions"]','[data-slot="git-toolbar-menu"]'),('commit-dialog','[data-action="commit"]','[data-slot="commit-dialog"]')]:
   b('click',selector);b('wait',wait);time.sleep(.2)
   name=f'{state}-{theme}-{width}.png';b('screenshot',str(out/name));b('press','Escape')
   rows.append(dict(state=state,theme=theme,viewport=dict(width=width,height=height),browser=name,design=(('QifUP' if theme=='light' else 'X79RX') if width==1440 else ('M8dqPj' if theme=='light' else 'rxmtI'))+'-design.png',verdict='pending visual review'))
json.dump(rows,open(out/'menu-manifest.json','w'),indent=2)
