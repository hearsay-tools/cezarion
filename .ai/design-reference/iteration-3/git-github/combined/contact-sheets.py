import json,pathlib
from PIL import Image,ImageDraw
out=pathlib.Path(__file__).parent
m=json.load(open(out/'manifest.json'))
groups={}
for row in m['pairs']:
 group=row['frame'].split('.')[0]
 if not group.startswith('27'):group=group[:-1]
 groups.setdefault(group,[]).append(row)
for key,rows in groups.items():
 sheet=Image.new('RGB',(1400,500*len(rows)), '#ddd');draw=ImageDraw.Draw(sheet)
 for i,row in enumerate(rows):
  for j,kind in enumerate(['design','browser']):
   im=Image.open(out/row[kind]).convert('RGB');im.thumbnail((690,470))
   sheet.paste(im,(j*700,i*500+25));draw.text((j*700+5,i*500+5),row['frame']+' '+kind,fill='black')
 sheet.save(out/('review-'+key+'.jpg'),quality=94)
