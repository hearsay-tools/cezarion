# Drawer pointer-coordinate regression evidence

The sidebar migration in #619 exposed a race in `checkNavSelection`: it measured
pointer coordinates as soon as the tab existed, while the mobile drawer was still
sliding. A hover sent to that position missed the tab after it moved.

Local reproduction on 2026-09-29:

```sh
npm run test:e2e -- selection-states.e2e.ts -t 'mobile-dark-ultra: view tabs'
```

Run against the migrated tab test without the drawer-frame `waitForStable` in
`open()`. The failure bundle was captured at `2026-09-29T15:38:37.675Z` in
`.ai/qa/failures/selection-states/mobile-dark-ultra-view-tabs-share-the-task-row-s-selection-and-badges-follow-the-2/`.
Its `probe.json` records the existing 44×44 Skills tab with a transparent
background and `rgb(137, 146, 166)` icon/label, instead of the hovered foreground
`rgb(248, 250, 252)`. The viewport was 360×640; the page was ready and the drawer
was open. The light ultra case reproduced the same missing hover.

Waiting for the drawer frame's left edge to remain at zero before sampling pointer
coordinates fixed the reproduction. This is a geometry condition, not a sleep or
a relaxed hover assertion. The subsequent full local gate passed all four browser
lanes (490 passing tests), including the mobile theme/density matrix.
