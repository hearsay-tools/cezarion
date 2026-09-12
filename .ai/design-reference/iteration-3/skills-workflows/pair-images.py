"""Pair original design PNGs with built screenshots without anisotropic scaling."""
from pathlib import Path
from PIL import Image, ImageDraw
import json
out=Path(__file__).parent
pairs=json.loads((out/'pairs.json').read_text())
main=[p for p in pairs if p['name']==p['reference']]
(out/'comparisons').mkdir(exist_ok=True)
for p in main:
    actual=Image.open(out/p['actual']).convert('RGB')
    reference=Image.open(out/'reference'/f"{p['reference']}.png").convert('RGB')
    scale=actual.width/reference.width
    reference=reference.resize((actual.width,round(reference.height*scale)),Image.Resampling.LANCZOS)
    pair=Image.new('RGB',(actual.width*2,max(actual.height,reference.height)+24),'white')
    pair.paste(reference,(0,24));pair.paste(actual,(actual.width,24))
    draw=ImageDraw.Draw(pair);draw.text((8,5),'CONFIRMED DESIGN',fill='black');draw.text((actual.width+8,5),'BUILT BROWSER',fill='black')
    pair.save(out/'comparisons'/f"{p['name']}.png")
# Overview sheets are navigation aids; the full-size pairs above are the review evidence.
for start in range(0,len(main),4):
    tiles=[]
    for p in main[start:start+4]:
        im=Image.open(out/'comparisons'/f"{p['name']}.png")
        im.thumbnail((680,950),Image.Resampling.LANCZOS)
        tiles.append((p['name'],im))
    sheet=Image.new('RGB',(1360,2*980),'white');draw=ImageDraw.Draw(sheet)
    for i,(name,im) in enumerate(tiles):
        x=(i%2)*680;y=(i//2)*980;draw.text((x+8,y+4),name,fill='black');sheet.paste(im,(x,y+24))
    sheet.save(out/'comparisons'/f'overview-{start//4+1}.png')
