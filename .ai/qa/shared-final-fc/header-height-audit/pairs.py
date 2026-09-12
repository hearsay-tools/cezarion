from pathlib import Path
from PIL import Image,ImageDraw
import json
out=Path('.ai/qa/runtime-verified/header-height-audit');proof=json.loads((out/'proof.json').read_text());tiles=[]
for f in proof['frames']:
 source=Image.open(Path('.ai/design-reference/iteration-3/design')/(f['id']+'.png')).convert('RGB')
 source=source.resize((1440,round(source.height*1440/source.width)),Image.Resampling.LANCZOS).crop((264,0,1440,96))
 actual=Image.open(out/(f['id']+'.png')).convert('RGB');tile=Image.new('RGB',(1176,232),'white');d=ImageDraw.Draw(tile);d.text((8,3),f['id']+' SOURCE '+str(f['expectedHeight'])+'px',fill='black');tile.paste(source,(0,20));d.text((8,119),'BUILT '+str(f['header']['height'])+'px; main y='+str(f['main']['y']),fill='black');tile.paste(actual,(0,136));tile.save(out/(f['id']+'-pair.png'));tiles.append(tile)
canvas=Image.new('RGB',(1176,232*len(tiles)),'white')
for i,t in enumerate(tiles):canvas.paste(t,(0,i*232))
canvas.save(out/'all-header-pairs.png')
