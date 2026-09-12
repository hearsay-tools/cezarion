import json,pathlib
from PIL import Image, ImageDraw
out=pathlib.Path(__file__).resolve().parent
(out/'review').mkdir(exist_ok=True)
for row in json.load(open(out/'capture-inventory.json')):
 d=Image.open(out/row['design']).convert('RGB').resize((row['width'],row['height']))
 b=Image.open(out/row['browser']).convert('RGB')
 if row['width']>=768:
  d=d.crop((264,64,d.width,d.height));b=b.crop((264,64,b.width,b.height))
 pad=12
 im=Image.new('RGB',(d.width+b.width+pad,max(d.height,b.height)+28),'#dddddd')
 im.paste(d,(0,28));im.paste(b,(d.width+pad,28))
 ImageDraw.Draw(im).text((8,8),row['name']+' | DESIGN / BROWSER',fill='black')
 im.save(out/'review'/(row['id']+'.png'))
