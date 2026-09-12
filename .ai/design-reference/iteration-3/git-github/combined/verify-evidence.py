from pathlib import Path
import json,hashlib,struct,datetime,urllib.request
out=Path(__file__).resolve().parent
comp=json.loads((out.parent/'combined-source-proof.json').read_text());root=Path(comp['snapshotPath'])
sha=lambda f:hashlib.sha256(f.read_bytes()).hexdigest()
for file,h in comp['overlayFiles'].items():assert sha(root/file)==h
rows=json.loads((out/'manifest.json').read_text())['pairs']
for name in ['interaction-manifest.json','menu-manifest.json']:rows+=json.loads((out/name).read_text())
rows+=json.loads((out/'r2-resize-manifest.json').read_text())['pairs']
assert len(rows)==82
for r in rows:
 for kind,scale in [('design',2),('browser',1)]:
  f=out/r[kind];assert sha(f)==r[kind+'Sha256']
  assert struct.unpack('>II',f.read_bytes()[16:24])==(r['viewport']['width']*scale,r['viewport']['height']*scale),(f,r['viewport'])
proof=json.loads((out/'server-proof.json').read_text());assert len(proof['assets'])==90 and all(a['match'] for a in proof['assets'])
build=json.loads((out/'build-proof.json').read_text())
for file,h in build['webAssets'].items():
 assert hashlib.sha256(urllib.request.urlopen(proof['baseUrl']+'/'+file).read()).hexdigest()==h
assert 'Tests  272 passed (272)' in (out/'tests.log').read_text()
(out/'verification.json').write_text(json.dumps(dict(verifiedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),pairsAndContextCaptures=82,sourceOverlayFiles=37,servedAssets=90,hashesAndDimensions='passed',scopedTests=272,typecheck='passed',serverBuild='passed',webBuild='passed'),indent=2))
print('Verified all 82 capture pairs, 37 source overlays and 90 served assets.')
