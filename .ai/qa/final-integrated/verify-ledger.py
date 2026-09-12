from pathlib import Path
from PIL import Image
import json,hashlib
root=Path(__file__).resolve().parent
rows=json.loads((root/'coverage-193.json').read_text())
assert len(rows)==193 and len({r['id'] for r in rows})==193
results=[]
for r in rows:
 item={'id':r['id'],'referenceExists':Path(r['design']).is_file(),'pairInspected':r['independentReview']['pairInspected'],'historicalAccepted':r['historicalEvidenceAccepted']}
 assert item['referenceExists'] and not item['historicalAccepted']
 if r.get('currentBrowser'):
  path=Path(r['currentBrowser']);assert path.is_file()
  digest=hashlib.sha256(path.read_bytes()).hexdigest()
  item.update(browserExists=True,sha256=digest,hashMatchesLedger=digest==r['currentBrowserSha256'],pixels=Image.open(path).size,cssViewport=[r['width'],r['height']])
  assert item['hashMatchesLedger']
 results.append(item)
report={'frames':len(rows),'uniqueFrames':len({r['id'] for r in rows}),'owned':sum(r['independentReview']['scope'].startswith('owned') for r in rows),'delegated':sum(r['independentReview']['scope'].startswith('delegated') for r in rows),'currentImages':sum(bool(r.get('currentBrowser')) for r in rows),'directlyInspectedPairs':sum(r['independentReview']['pairInspected'] for r in rows),'acceptance':'Inventory integrity only; never a pixel-parity or all-state acceptance claim.','rows':results}
(root/'ledger-proof.json').write_text(json.dumps(report,indent=2)+'\n')
print({k:v for k,v in report.items() if k!='rows'})
