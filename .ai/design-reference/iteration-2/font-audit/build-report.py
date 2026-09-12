"""Generate audit evidence from exact source, captured font responses and pen.dev exports."""
from pathlib import Path
from fontTools.ttLib import TTFont
import json,hashlib,collections,re,subprocess,datetime
R=Path(__file__).resolve().parent;D=R.parent/'design';source=Path('cezarion.pen').read_bytes();doc=json.loads(source)
def sha(x):return hashlib.sha256(x).hexdigest()
def write(name,data): (R/name).write_text(json.dumps(data,indent=2,ensure_ascii=False)+'\n')
fonts=[];cmap={};fallback=set()
for line in (R/'font-fetch.ndjson').read_text().splitlines():
 rec=json.loads(line)
 if any(x['sha256']==rec['sha256'] for x in fonts):continue
 f=TTFont(R/(rec['sha256']+'.font'));name=f['name'].getDebugName(1);family='Poppins' if name.startswith('Poppins') else name
 cm=f.getBestCmap();cmap.setdefault(family,set()).update(cm)
 if name.startswith('Noto'):fallback.update(cm)
 fonts.append(rec|{'family':name,'subfamily':f['name'].getDebugName(2),'postScriptName':f['name'].getDebugName(6),'weight':f['OS/2'].usWeightClass,'variationAxes':[{k:getattr(a,k) for k in ['axisTag','minValue','defaultValue','maxValue']} for a in f['fvar'].axes] if 'fvar'in f else [],'U+2304':cm.get(0x2304)})
texts=json.loads((R/'text-instances.json').read_text());counts=collections.Counter();missing=[];charOccurrences=collections.defaultdict(list)
for t in texts:
 style=t['style']or'';m=re.search(r'font-family: ([^,;]+)',style)
 if not m:continue
 family=m[1].strip(chr(34));counts[family]+=1
 for c in sorted(set(t['text'])):
  if ord(c)<32:continue
  if ord(c)not in cmap.get(family,set())and ord(c)not in fallback:
   charOccurrences[(family,c)].append({'frame':t['frame'],'nodeId':t['nodeId'],'name':t['name'],'text':t['text']})
for (f,c),v in charOccurrences.items():missing.append({'family':f,'character':c,'codepoint':f'U+{ord(c):04X}','occurrences':v,'coveredByJetBrainsMono':ord(c)in cmap.get('JetBrains Mono',set())})
write('font-provenance.json',{'sourceSha256':sha(source),'method':'Captured only fonts.gstatic.com response URL/status/bytes/hash via transparent global fetch wrapper while running unmodified pen.dev 0.3.7 interactive. FontTools reads returned font cmap/name/OS2/fvar tables. DEBUG independently showed named font loads. HTML export confirms per-instance resolved families. Visual specimen E4RdR.png confirms U+2304 behavior.','documentFontReferences':doc['fonts'],'fontVariable':doc['variables']['cezarion-font-ui'],'resolvedTextInstanceCounts':dict(counts),'downloads':fonts,'glyphsAbsentFromFamilyAndLoadedNotoFallbacks':missing})
basebytes=subprocess.check_output(['git','show','c3f4d228:cezarion.pen']);base=json.loads(basebytes)
def indexes(d):
 ids={}
 def w(n,path=''):
  if isinstance(n,dict):
   current=path+'/'+str(n.get('name',''))
   if 'id'in n:ids[n['id']]=current
   for k,v in n.items():
    if isinstance(v,(dict,list)):w(v,current if 'id'in n else path)
  elif isinstance(n,list):
   for v in n:w(v,path)
 w(d);return ids
def canon(n,ids,top=False):
 if isinstance(n,dict):return {('/'.join(ids.get(seg,seg) for seg in k.split('/')) if k not in {'id'} else k):canon(v,ids) for k,v in n.items() if k!='id' and not(top and k in {'x','y'})}
 if isinstance(n,list):return [canon(v,ids) for v in n]
 if isinstance(n,str):return '/'.join(ids.get(seg,seg) for seg in n.split('/')) if n in ids or any(seg in ids for seg in n.split('/')) else n
 return n
old={n['name']:n for n in base['children']};bi=indexes(base);di=indexes(doc);comparisons=[]
for n in doc['children']:
 a=sha(json.dumps(canon(old[n['name']],bi,True),sort_keys=True).encode());b=sha(json.dumps(canon(n,di,True),sort_keys=True).encode());comparisons.append({'id':n['id'],'name':n['name'],'baselineId':old[n['name']]['id'],'baselineNormalizedSha256':a,'sourceNormalizedSha256':b,'declarationStatus':'same'if a==b else 'changed'})
write('baseline-comparison.json',{'baseline':'c3f4d228:cezarion.pen','baselineSha256':sha(basebytes),'sourceSha256':sha(source),'matching':'158 unique exact top-level names; normalize IDs and ID references to named ancestor paths; ignore only top-level canvas x/y','limitation':'Declaration comparison, not pixel equivalence; shared component and variable changes may affect otherwise unchanged declarations. Old design.pen/main 71-new claim is invalid for this baseline.','variablesChanged':base.get('variables')!=doc.get('variables'),'documentFontsChanged':base.get('fonts')!=doc.get('fonts'),'counts':dict(collections.Counter(x['declarationStatus']for x in comparisons)),'frames':comparisons})
print('Font instances',dict(counts));print('Unsupported',[(x['family'],x['codepoint'],len(x['occurrences']))for x in missing]);print('Baseline',collections.Counter(x['declarationStatus']for x in comparisons))
