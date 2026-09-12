from PIL import Image,ImageDraw
from pathlib import Path
import json
out=Path('.ai/qa/final-integrated/pairs');x=json.loads(Path('.ai/qa/settings/pairs.json').read_text())
for r in x['pairs']:
 a=Image.open(r['designPng']).convert('RGB');b=Image.open(r['browserPng']).convert('RGB');w=min(r['viewport']['width'],1000);h=round(a.height*w/a.width);a=a.resize((w,h));b=b.resize((w,round(b.height*w/b.width)));im=Image.new('RGB',(w*2,max(a.height,b.height)+28),'#ddd');im.paste(a,(0,28));im.paste(b,(w,28));ImageDraw.Draw(im).text((8,8),r['id']+' DESIGN | CURRENT SEEDED SETTINGS',fill='black');im.save(out/(r['id']+'.jpg'))
