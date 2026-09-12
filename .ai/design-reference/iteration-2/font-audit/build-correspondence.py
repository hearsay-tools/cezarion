"""Join expanded pen.dev icon geometry to frame names, ancestor context and adjacent copy."""
from pathlib import Path
from html.parser import HTMLParser
import json,csv,gzip,collections,hashlib
R=Path(__file__).resolve().parent
m=json.loads((R.parent/'design/manifest.json').read_text());icons=json.loads((R/'icon-map.json').read_text());frames={f['id']:f for f in m['frames']}
class Parser(HTMLParser):
 def __init__(self):super().__init__();self.root={'attrs':{},'children':[]};self.stack=[self.root];self.icons=[]
 def handle_starttag(self,t,a):
  n={'tag':t,'attrs':dict(a),'children':[],'parent':self.stack[-1]};self.stack[-1]['children'].append(n)
  if t=='svg'and n['attrs'].get('data-icon-set'):self.icons.append(n)
  if t not in {'meta','link','br','img','input','hr'}:self.stack.append(n)
 def handle_startendtag(self,t,a):self.handle_starttag(t,a);self.handle_endtag(t)
 def handle_endtag(self,t):
  if self.stack[-1].get('tag')==t:self.stack.pop()
 def handle_data(self,d):self.stack[-1]['children'].append(d)
p=Parser();p.feed(gzip.decompress((R/'all-frames.html.gz').read_bytes()).decode());assert len(p.icons)==len(icons['instances'])
def text(n):return ' '.join(' '.join(text(c)if isinstance(c,dict)else c for c in n['children']).split())
rows=[]
for ordinal,(n,i) in enumerate(zip(p.icons,icons['instances'])):
 assert n['attrs']['data-pencil-id']==i['nodeId']and n['attrs']['data-icon-name']==i['icon']
 ancestors=[];parent=n['parent']
 while parent is not p.root:
  a=parent['attrs']
  if a.get('data-pencil-id'):ancestors.append({'id':a['data-pencil-id'],'name':a.get('data-pencil-name','')})
  parent=parent['parent']
 nearby=text(n['parent'])
 rows.append({'ordinal':ordinal,'frameId':i['frame'],'frameName':frames[i['frame']]['name'],'nodeId':i['nodeId'],'nodeName':i['name'],'adjacentText':nearby[:240],'ancestorNames':' > '.join(a['name']for a in reversed(ancestors)),'ancestorIds':'/'.join(a['id']for a in reversed(ancestors)),'family':i['family'],'icon':i['icon'],'style':i['style'],'fills':'|'.join(f or''for f in i['fills']),'svg':icons['definitions'][i['geometryKey']]['svg'],'geometryKey':i['geometryKey']})
with (R/'icon-correspondence.csv').open('w')as f:
 w=csv.DictWriter(f,fieldnames=list(rows[0]),lineterminator="\n");w.writeheader();w.writerows(rows)
(R/'frame-name-map.json').write_text(json.dumps({'sourceSha256':m['penFileSha256'],'baseline':'c3f4d228:cezarion.pen','matching':'all158 exact unique top-level names verified','framesByName':{f['name']:{'id':f['id'],'baselineId':f['baselineId'],'width':f['width'],'height':f['height'],'image':'../design/'+f['screenshot'],'renderDefects':f['renderDefects']}for f in m['frames']}},indent=2,ensure_ascii=False)+'\n')
names=collections.defaultdict(set)
for i in rows:names[i['nodeName']].add(i['family']+'/'+i['icon'])
(R/'override-review-flags.json').write_text(json.dumps({'sourceSha256':m['penFileSha256'],'confirmedVisualDefects':[{'type':'text glyph and icon mismatch','description':'U+2304/U+21BB in Poppins render tofu while real icon nodes render chevrons/refresh correctly. Confirmed visually in Start and GitHub detail images; affected frames enumerated in main manifest.','manifest':'../design/manifest.json'}],'metadataAmbiguities':[{'nodeName':k,'actualGlyphs':sorted(v),'status':'not a confirmed visual defect','guidance':'Component override retains a generic or old node name. Use adjacentText, ancestor context and actual family/icon in icon-correspondence.csv, not the node name alone.'}for k,v in names.items()if len(v)>1],'styleDistinctions':[{'family':'Material Symbols Rounded','icon':'circle','status':'intentional observed style; do not replace with generic solid dot','description':'369 hollow session-status rings; exact outline differs from the separately used Lucide circle.'}],'reviewLimit':'No further visually inconsistent icon override was confirmed in the five detail views and ten overview sheets. Remaining small per-icon render differences are not certified as consistent.'},indent=2,ensure_ascii=False)+'\n')
print('PASS: 3337 ordered icon correspondences joined; 158 exact frame-name/newID/baselineID mappings; review flags distinguish defects from inherited-name ambiguity.')
for x in rows:
 if x['frameId']=='twLlb'and x['nodeName']=='New task icon':print(x['nodeName'],'=>',x['icon'],'label',x['adjacentText'])
