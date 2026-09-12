# Adapter ready: c807ff6e

Cherry-pick **c807ff6e** independently, before Tools577299ab. This commit only creates `packages/web/src/components/exact-icon/` (5files); no shell/style/route edits.

```tsx
import { ExactIcon, type ExactIconName } from '@/components/exact-icon'
<ExactIcon name="cpu" size={16} className="text-muted-foreground" />
<ExactIcon name="pin" title="Pinned task" />
```

76typednames;16pxdefault;explicitwidth/height andCSSclasses supported; currentColor, filledpaths, originalviewBox. React19refs passthrough. Decorativebydefault;aria-label/aria-labelledby/title givesimage semantics;titleIDs unique. Source license included. `ADAPTER-CONTRACT.md` has full API/provenance; `adapter-sheet.png` is the actual rendered adapter; `adapter-proof.json` records validations. All76definitions compared exactly against current193map.4tests,typecheck,webbuild pass.

Source caveat: the currentexport’s `align-left` entry is a circledquestion-markoutline. It is preserved exactly and documented, not silently replaced with upstream geometry.

Parent worker messaging failed with capacity_limit. This durable handoff and the final message deliver the commit/contract. Replacementa439 should consume thisadapter, notcreateanotherone.
