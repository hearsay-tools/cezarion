# Shared shell — current193 evidence

Authoritative source SHA256 `56a71a27c7795137cab1c0a40a5839edecbacab4014d2d39ddc90f89343275f8`. Only the approved 193-frame export was used.

[Side-by-side shell comparison](comparison.html) · [Exact frame/hash matrix](pairs.json) · [Built runtime proof](server-proof.json) · [Browser geometry/theme proof](browser-environment.json)

| Built state | Exact source | Evidence |
|---|---|---|
| desktop-light-264 | [t5OS8c: R1. Sidebar minimum / default · 264px · Desktop light](/home/agent/projects/cezar/.ai/cezar/worktrees/9ae05dcc-cc09-405c-9934-ab364076aa21/.ai/design-reference/iteration-3/design/t5OS8c.png) | [desktop-light-264.png](desktop-light-264.png) |
| desktop-dark-264 | [wDyFh: R1. Sidebar minimum / default · 264px · Desktop dark](/home/agent/projects/cezar/.ai/cezar/worktrees/9ae05dcc-cc09-405c-9934-ab364076aa21/.ai/design-reference/iteration-3/design/wDyFh.png) | [desktop-dark-264.png](desktop-dark-264.png) |
| desktop-light-420 | [IbsZT: R1. Sidebar maximum · 420px · Desktop light](/home/agent/projects/cezar/.ai/cezar/worktrees/9ae05dcc-cc09-405c-9934-ab364076aa21/.ai/design-reference/iteration-3/design/IbsZT.png) | [desktop-light-420.png](desktop-light-420.png) |
| desktop-dark-420 | [IFqhi: R1. Sidebar maximum · 420px · Desktop dark](/home/agent/projects/cezar/.ai/cezar/worktrees/9ae05dcc-cc09-405c-9934-ab364076aa21/.ai/design-reference/iteration-3/design/IFqhi.png) | [desktop-dark-420.png](desktop-dark-420.png) |
| mobile-light-drawer | [h690uO: 2E. Session navigation open · Mobile light](/home/agent/projects/cezar/.ai/cezar/worktrees/9ae05dcc-cc09-405c-9934-ab364076aa21/.ai/design-reference/iteration-3/design/h690uO.png) | [mobile-light-drawer.png](mobile-light-drawer.png) |
| mobile-dark-drawer | [L0VfI: 2F. Session navigation open · Mobile dark](/home/agent/projects/cezar/.ai/cezar/worktrees/9ae05dcc-cc09-405c-9934-ab364076aa21/.ai/design-reference/iteration-3/design/L0VfI.png) | [mobile-dark-drawer.png](mobile-dark-drawer.png) |

Additional real-browser states: [Tools](tools-light.png), [command palette](palette-light.png). The source has no standalone command-palette or Tools-popup frame; these use the shared primitives and glyphs, and are behavior-tested.

Implementation commit: `15ef08fc871034fb709bf864b4ce1169bbf309ee`. Icon adapter: `af44561b`.

## Verified implementation

- All 76 exact filled source glyphs are centralized; accessible currentColor API, original viewBoxes and path geometry, upstream license retained. Source `align-left` resolves to a question-circle fallback and is documented rather than silently substituted.
- Sidebar min/default 264px, maximum 420px; mouse/keyboard resize and stored preference preserved. The R1 captures hover the real resize handle.
- Shared project cards, project switching, collapse persistence, selected project destinations, Pinned/Recent sections, worker indentation, both tracker badges and independent task/unread state. Independently pinned workers stay in Pinned.
- Five-icon footer, capability-gated project controls, Tools diagnostics and archive filter, three-way theme preference, search palette, mobile focus trapping and close behavior. Version is accessible and also available in the Tools tooltip; no invented tagline.
- Exact glyph adapter applied to shared navigation, tracker states, pin, palette and UI primitives. IBM Plex Mono branch font is locally bundled with its OFL license.

## Comparison limits and visible differences

- These are shell comparisons, not whole-route parity claims. The GitHub/task route content comes from the real built application and remains assigned to the other workers.
- Fixture titles and branch names are analogous to R1; mobile uses the same fixture titles instead of the differently worded 2E/F examples. Reference API responses are explicitly mocked and contract-validated in `reference-status-mocks.json`; the rest is real isolated persisted run/project state.
- R1 shows blue open-issue examples and purple review-PR examples, while the source status legend (T2fE7/L61J13) specifies open issues green and review-required PRs blue. The application retains that semantic legend and reports the actual status, rather than changing it to match an illustrative R1 color.
- The Tasks destination remains selected while viewing a task, preserving the existing navigation contract; the source mobile example highlights only the selected session. Real route content remains visible through the specified translucent scrim.
- Wide-sidebar diff counts remain visible when real records contain them; R1 sample records do not show diff totals. No-hover touch devices retain directly reachable pin controls; pointer captures use the source’s hover/focus reveal treatment.
- Exact image equality is not claimed: dynamic data, platform shortcut text (Ctrl+K here), independent selected/unread states and browser font rasterization differ. PNG dimensions, CSS viewport, theme, default density and sidebar geometry are explicitly checked.

## Validation

- `npm run typecheck`: passed.
- `npm test -- packages/web/src/components packages/web/src/lib/sidebar-width.test.ts`: 43 files, 754 tests passed.
- `npm run build`: passed, including `check:pack` (582 files, 110 web files).
- `verify.mjs`: built CLI identity, all 96 served JS/CSS/font assets, four contract-valid runs and two worker families verified.
- Logs: [typecheck](validation/typecheck.log), [scoped tests](validation/scoped-tests.log), [build](validation/build.log).

## Reproduce

Build from this checkout, then run `node .ai/qa/shell-current193/serve-shell.mjs "$PWD" 44740`. It seeds only `/tmp/cezar-shell-a439` and its own ignored QA home. Start an isolated headed agent-browser session named `shell-a439-headed` under Xvfb (the headless renderer reports no-hover and therefore legitimately shows larger touch pin controls). Run `capture.mjs`, then `verify.mjs`. Captures use Chrome DevTools directly for genuine 2× PNGs; the agent-browser screenshot helper normalizes to CSS pixels. No real agents, remote writes, merges, or credential inheritance are involved.

## Specialized shared states and mobile clipping follow-up

Source inventory reviewed: parent `iteration-3/runtime-verified/inventory.json`, same approved SHA256 above. Its generic route baselines are not used as evidence of an open menu or resized state.

| State | Trigger and evidence | Result |
| --- | --- | --- |
| Base branch menu, mobile402 | Actual Base branch trigger; `mobile-base-branch-before.png` and `mobile-base-branch-after.png` | Reproduced402.84375px width before fix;402px after, full description wraps. Shared dropdown/popover width is capped by Radix available width. |
| Tools, light/dark desktop/mobile | Footer Tools button; `tools-{light,dark}-{open,mobile}.png` | Open menu confirmed,240px; archive controls and installed/missing tools visible. |
| Add project, light/dark desktop/mobile | Footer Add project button; `add-project-{light,dark}-{desktop,mobile}.png` | Open224px menu; local folder and clone destinations visible. |
| Palette, light/dark desktop/mobile | Search button; `palette-{light,dark}-{open,mobile}.png` | Actual dialog and input visible; desktop896px, mobile370px inside402px viewport. |
| R1 minimum/default `t5OS8c`, `wDyFh` | Focus separator then Home; `resize-264-{light,dark}.png` |264px rendered and persisted. Matched source-size visual pairs remain `desktop-{light,dark}-264.png` in pairs.json. |
| R1 maximum `IbsZT`, `IFqhi` | Focus separator then End; `resize-420-{light,dark}.png` |420px rendered and persisted. Matched source-size visual pairs remain `desktop-{light,dark}-420.png` in pairs.json. |

`shared-states.json` records selectors' actual rectangles, visible text, theme, viewport, and resize persistence for17 states; `shared-states.mjs` reproduces the interactions against the real isolated built CLI. New captures use2× Chromium output. The before-overflow PNG is the browser helper's1× output, so compare CSS geometry rather than raw image dimensions for that regression. The follow-up state captures supplement the matched reference matrix; they do not turn the component specification board `C9o2u` or appearance board `OeHGM` into routes. Parent baseline screenshots bearing old “Parent · …” rows predate this shell and must not be presented as acceptance of current implementation.

Validation after the width constraint change: full build including check:pack, repository typecheck, and100 scoped picker/shell/resize behavior tests passed. Logs are `validation/clipping-*.log`. No route or composer source was edited.
