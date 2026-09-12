from PIL import Image,ImageDraw
from pathlib import Path
import json
out=Path(__file__).parent
refs=Path('.ai/design-reference/iteration-3/design')
(out/'comparisons').mkdir(exist_ok=True)
pairs=json.loads((out/'pairs.json').read_text())
pairs += [{'name':'reference-statuses-'+t,'reference':r} for t,r in [('light','T2fE7'),('dark','L61J13')]]
for p in pairs:
 if not p.get('reference'):continue
 a=Image.open(out/(p['name']+'.png'));r=Image.open(refs/(p['reference']+'.png'));r=r.resize((a.width,round(r.height*a.width/r.width)))
 im=Image.new('RGB',(a.width*2,max(a.height,r.height)+24),'white');im.paste(r,(0,24));im.paste(a,(a.width,24));d=ImageDraw.Draw(im);d.text((4,4),'DESIGN',fill='black');d.text((a.width+4,4),'BUILT - shared shell only',fill='black');im.save(out/'comparisons'/(p['name']+'.png'))
