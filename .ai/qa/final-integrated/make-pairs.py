from PIL import Image,ImageDraw
from pathlib import Path
import json
out=Path('.ai/qa/final-integrated'); rows=json.loads((out/'coverage-193.json').read_text());(out/'pairs').mkdir(exist_ok=True)
for r in rows:
 if not r['currentBrowser']:continue
 a=Image.open(r['design']).convert('RGB');b=Image.open(r['currentBrowser']).convert('RGB'); w=min(r['width'],1000);h=round(a.height*w/a.width);a=a.resize((w,h));b=b.resize((w,round(b.height*w/b.width)));im=Image.new('RGB',(w*2,max(a.height,b.height)+28),'#dddddd');im.paste(a,(0,28));im.paste(b,(w,28));ImageDraw.Draw(im).text((8,8),r['id']+' DESIGN | CURRENT BROWSER',fill='black');im.save(out/'pairs'/str(r['id']+'.jpg'))
