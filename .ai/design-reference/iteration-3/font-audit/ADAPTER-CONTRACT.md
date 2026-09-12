# Exact design icons

```tsx
import { ExactIcon, type ExactIconName } from '@/components/exact-icon'

// Decorative: the button supplies its accessible name.
<ExactIcon name="cpu" size={16} className="text-muted-foreground" />

// Standalone meaningful image.
<ExactIcon name="git-pull-request" size={20} aria-label="Pull request" />
<ExactIcon name="pin" title="Pinned task" />
```

`name` is the union of all 76 approved glyph names; `exactIconNames` exports their list. `size` defaults to 16 CSS pixels. Standard SVG props, classes, styles, and React 19 refs pass through; explicit `width` and `height` override the corresponding size. CSS sizing classes retain normal precedence. Color inherits through `currentColor`. Use the per-instance size and color from the reference map.

Icons are non-focusable and decorative by default (`aria-hidden`). Supplying `aria-label`, `aria-labelledby`, or `title` gives the SVG image semantics. A title receives a unique associated ID. Geometry, filled rendering, and the viewBox are owned by the adapter, rather than caller props. No runtime fetching or font dependency is required. Existing routes are not migrated by this commit.

`geometry.ts` is generated from the approved 193-frame pen.dev 0.3.7 export:

- Source SHA256: `56a71a27c7795137cab1c0a40a5839edecbacab4014d2d39ddc90f89343275f8`.
- HTML SHA256: `da069d4a5a96f394e68098a4a262a10d517e2a03d29d59102ee7fcd02dacc757`.
- Audit: `.ai/design-reference/iteration-3/font-audit/icon-map.json`, `icon-correspondence.csv`, and `icons/*.svg` in the coordinator worktree.
- 76 unique filled Lucide geometries across 4,719 visible instances. Disabled legacy Material glyphs are excluded.

Every path and viewBox is preserved from that export. Each definition retains its independent source geometry checksum; the test recomputes all 76. These outlines are filled font-glyph geometry, not generic stroked Lucide React paths. Do not normalize their coordinates to a 24×24 viewBox or substitute similarly named glyphs.

See `LICENSE` for Lucide/Feather attribution and permission notices. Keep it with copied or redistributed geometry.

Export caveat: the source entry named `align-left` visibly contains a circled question-mark outline in the current exported SVG. The adapter preserves that verified source geometry. Treat it as an export/name discrepancy when choosing icons; do not assume the name guarantees the upstream Lucide shape.
