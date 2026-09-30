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

## Cold-navigation appearance hydration regression evidence

The footer branch in `checkNavBody` navigates to `/settings/global`. It used to
apply the QA appearance override immediately after `goto`, before the React
appearance provider had hydrated stored preferences. The provider could then
replace ultra density with the default density. This is separate from the mobile
drawer pointer-coordinate race above.

The unmodified footer branch failed during the full local gate on 2026-09-30:

```sh
npm run test:e2e:local
```

Lane 4 failed only this case:
`desktop-light-ultra: view tabs share the task row's selection, and badges follow their meaning (#617 01c)`.
The retained bundle is
`.ai/qa/local-runs/1790747184249-2665700/lane-4-failures/selection-states/desktop-light-ultra-view-tabs-share-the-task-row-s-selection-and-badges-follow-t-1/`.
Its `probe.json` records `capturedAt: 2026-09-30T05:49:28.331Z`, viewport
1440×900, `/settings/global`, `readyState: complete`, and no open dialogs.
The screenshot and accessibility snapshot show the mounted Settings page. The
lane log records the unchanged footer assertion at `checkNavBody`:

```text
Expected: { height: 27, width: 27, icon: "rgb(15, 23, 42)" }
Received: { height: 36, width: 36, icon: "rgb(15, 23, 42)" }
```

The icon color already satisfied the selected-state wait; the dimensions were
those of default density. `AppearanceProvider` hydrates fetched UI state in an
effect and stamps the document appearance in a layout effect. Unlike `open()`,
this cold-navigation branch did not wait for application readiness before the QA
override. Waiting for the active global-settings control and `window.__cezIdle`
to remain ready before applying the override removes that ordering race. The
size and color assertions remain unchanged.

After the wait was added, the focused case passed:

```sh
E2E_PREBUILT_ASSETS=1 npm run test:e2e -- selection-states.e2e.ts -t 'desktop-light-ultra: view tabs share'
```

The subsequent `npm run test:e2e:local` passed all four lanes: 494 tests passed,
with six existing skipped cases. Logs remain under
`.ai/qa/local-runs/1790747722985-2901872/`. The wait-discipline guard passed all
24 checks without a baseline change. This records an observed failure and the
passing runs; it does not claim that every unmodified focused run reproduces the
race.
