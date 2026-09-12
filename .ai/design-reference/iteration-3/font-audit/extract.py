"""Read-only audit of pen.dev HTML export; never writes a .pen file."""
from html.parser import HTMLParser
from pathlib import Path
import json,hashlib,re,collections
ROOT=Path(__file__).resolve().parent
class Audit(HTMLParser):
 def __init__(self):super().__init__(convert_charrefs=True);self.stack=[];self.svgs=[];self.texts=[];self.active=None
 def handle_starttag(self,t,a):
  a=dict(a); parent=self.stack[-1] if self.stack else {}; item={'tag':t,'attrs':a,'frame':parent.get('frame'),'text':''}
  if a.get('data-pencil-id') in frameids:item['frame']=a['data-pencil-id']
  if t=='svg':self.active={'frame':item['frame'],'nodeId':a.get('data-pencil-id'),'name':a.get('data-pencil-name'),'family':a.get('data-icon-set'),'icon':a.get('data-icon-name'),'viewBox':a.get('viewbox'),'style':a.get('style'),'paths':[]};self.svgs.append(self.active)
  if t=='path' and self.active:self.active['paths'].append(a)
  if t not in {'meta','link','br','img','input','hr'}:self.stack.append(item)
 def handle_startendtag(self,t,a):self.handle_starttag(t,a);self.handle_endtag(t)
 def handle_data(self,d):
  if self.stack:self.stack[-1]['text']+=d
 def handle_endtag(self,t):
  if t=='svg':self.active=None
  if self.stack and self.stack[-1]['tag']==t:
   x=self.stack.pop();a=x['attrs'];text=x['text'].strip()
   if text and a.get('data-pencil-id'):self.texts.append({'frame':x['frame'],'nodeId':a['data-pencil-id'],'name':a.get('data-pencil-name'),'text':text,'style':a.get('style')})
p=json.loads(Path('/home/agent/projects/cezar/.ai/cezar/worktrees/e2fa39fa-a879-4b7a-8034-14c41d2cb83a/.ai/qa/iteration-3/confirmed-source.pen').read_text());frameids={n['id'] for n in p['children']};parser=Audit();parser.feed((ROOT/'all-frames.html').read_text())
icons={};instances=[];(ROOT/'icons').mkdir(exist_ok=True)
for s in parser.svgs:
 if not s['family']:continue
 geom={'viewBox':s['viewBox'],'paths':[{k:v for k,v in x.items() if k not in ['fill','style']} for x in s['paths']]};h=hashlib.sha256(json.dumps(geom,sort_keys=True).encode()).hexdigest();key=s['family']+'/'+s['icon']+'/'+h[:12]
 if key not in icons:
  slug=re.sub('[^a-z0-9-]+','-',(s['family']+'-'+s['icon']).lower())+'-'+h[:12];svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="'+s['viewBox']+'" fill="currentColor">'+''.join('<path '+ ' '.join(k+'="'+v+'"' for k,v in x.items())+'/>' for x in geom['paths'])+'</svg>\n';(ROOT/'icons'/f'{slug}.svg').write_text(svg);icons[key]={'family':s['family'],'icon':s['icon'],'geometrySha256':h,**geom,'svg':'icons/'+slug+'.svg','rendering':'font glyph outline; filled paths, no SVG stroke'}
 instances.append({k:v for k,v in s.items() if k!='paths'}|{'geometryKey':key,'fills':[x.get('fill') for x in s['paths']]})
(ROOT/'icon-map.json').write_text('{\n\"provenance\": \"pen.dev 0.3.7 Export html-css of all 193 exact-source frames SHA256 56a71a27c7795137cab1c0a40a5839edecbacab4014d2d39ddc90f89343275f8; expands component refs\",\n\"definitions\": '+json.dumps(icons,indent=2)+',\n\"instances\": [\n'+',\n'.join(json.dumps(i,ensure_ascii=False) for i in instances)+'\n]}\n')
(ROOT/'text-instances.json').write_text('[\n'+',\n'.join(json.dumps(t,ensure_ascii=False) for t in parser.texts)+'\n]\n')
print('Icons:',len(instances),'instances;',len(icons),'geometry variants;',len({(s['family'],s['icon']) for s in instances}),'family/name pairs');print(collections.Counter(s['family'] for s in instances));print('U+2304',sum('⌄' in s['text'] for s in parser.texts),'text instances')
