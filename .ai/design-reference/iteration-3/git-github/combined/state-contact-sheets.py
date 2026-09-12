from PIL import Image,ImageDraw
from pathlib import Path
import json
out=Path(__file__).parent;groups={}
for name in ['interaction-manifest.json','menu-manifest.json']:
 for r in json.loads((out/name).read_text()):
  group=r['state'].split('-light')[0].split('-dark')[0];groups.setdefault(group,[]).append(r)
for key,rows in groups.items():
 sheet=Image.new('RGB',(1400,len(rows)*500),'#ddd');draw=ImageDraw.Draw(sheet)
 for i,r in enumerate(rows):
  for j,kind in enumerate(['design','browser']):
   im=Image.open(out/r[kind]).convert('RGB');im.thumbnail((690,470));sheet.paste(im,(700*j,500*i+25));draw.text((700*j+5,500*i+5),r['state']+' '+r['theme']+' '+str(r['viewport']['width'])+' '+kind,fill='black')
 sheet.save(out/('review-state-'+key+'.jpg'),quality=92)
