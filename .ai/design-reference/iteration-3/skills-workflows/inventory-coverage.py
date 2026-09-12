"""Audit assigned state coverage against the complete confirmed design inventory."""
from pathlib import Path
import json, hashlib, sys

out=Path(__file__).parent
design=Path(sys.argv[1])
manifest=json.loads((design/'manifest.json').read_text())
pairs=json.loads((out/'pairs.json').read_text())
selected=json.loads((out/'reference/manifest.json').read_text())
assigned={f['id'] for f in selected['frames']}
wrappers={'gqaUM','EsGpp','YS15Y','wLVhd'}
settings={'RysDF','tWnpG','aYBO5','kyWF8'}
frames=[]
for f in manifest['frames']:
    fid=f['id']
    scope=('skills-workflows' if fid in assigned-wrappers else
           'skills-wrapper-settings-inner' if fid in wrappers else
           'settings-owner' if fid in settings else 'outside-assigned-scope')
    captures=[p for p in pairs if p['reference']==fid]
    if fid in assigned:
        assert captures, f'Missing assigned frame {fid}'
        assert hashlib.sha256((out/'reference'/f'{fid}.png').read_bytes()).hexdigest()==f['pngSha256']
    frames.append({'id':fid,'name':f['name'],'scope':scope,
                   'referencePngSha256':f['pngSha256'],
                   'captures':[{'actual':p['actual'],'content':p.get('content'),
                                'viewport':p['viewport'],'theme':p['theme'],
                                'pairKind':'full-frame' if p['name']==fid else 'component-or-supplementary-state'}
                               for p in captures]})
assert len(frames)==193
assert len(assigned-wrappers)==22
assert len(pairs)==74
states={}
for prefix in ['selector-','import-','import-error-','add-step-','delete-','overwrite-',
               'yaml-','step-menu-','filter-empty-','manage-current-','manage-available-',
               'manage-updating-','manage-error-','manage-disabled-','manage-filter-empty-',
               'skills-error-']:
    states[prefix.rstrip('-')]=[p['actual'] for p in pairs if p['name'].startswith(prefix)]
    assert states[prefix.rstrip('-')], f'Missing state {prefix}'
report={'sourceSha256':manifest['penFileSha256'],'inventoryFrames':len(frames),
        'ownedFrames':22,'wrapperFrames':4,'explicitSettingsExclusions':4,
        'otherFrames':163,'captures':len(pairs),
        'builtIndexSha256':list({p['indexSha256'] for p in pairs}),
        'limits':['Frame32 is a component sheet; dialog crops correspond to its cards, not a whole-page overlay reference.',
                  'Native selector popup is platform-owned and not captured by page screenshots; idle selector and load behavior are verified.',
                  'Managed server-status/error states without dedicated frames refer to the enclosing Manage surface.',
                  'Settings Skills frames and bookmarklet inner panel remain assigned to the Settings worker.'],
        'stateCaptures':states,'frames':frames}
assert len(report['builtIndexSha256'])==1
(out/'inventory-coverage.json').write_text(json.dumps(report,indent=2)+'\n')
print('PASS: all193 classified, 22owned +4wrapper frames covered by74 state captures.')
