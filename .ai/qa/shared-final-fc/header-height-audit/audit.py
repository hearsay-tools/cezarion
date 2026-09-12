import json,hashlib
from pathlib import Path
p=Path('cezarion.pen');doc=json.loads(p.read_text());out=Path('.ai/qa/runtime-verified/header-height-audit')
rows=[]
def walk(n,f):
 if n.get('height') in [64,72] and n.get('type') in ['frame','ref'] and any(t in n.get('name','').lower() for t in ['header','breadcrumb']):rows.append({'frame':f['id'],'frameName':f.get('name'),'node':n['id'],'name':n.get('name'),'height':n['height']})
 for c in n.get('children',[]):walk(c,f)
for f in doc['children']:walk(f,f)
(out/'source-heights.json').write_text(json.dumps({'penSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'headers':rows},indent=2)+'\n')
print('Explicit desktop heights:',{h:sum(r['height']==h for r in rows) for h in [64,72]})
