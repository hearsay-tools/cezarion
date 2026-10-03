# Cockpit rendered / settled sampling audit — #795

Audited baseline: `35a519de` (includes #758, `35a519de`, and #794, `af1383f9`).
Scope: every one of the **63** current `*.e2e.ts` specs. The original audit covers
**13** helper/setup files (11 direct TypeScript files plus `fetch-setup.mjs` and
`fixtures/make-large-thread.ts`); review round 1 adds `transcript-measurements.ts` and
`session-layout.ts`; the loaded-rail correction adds `project-rail-ready.ts`, bringing
the helper/setup inventory to **16**. The settings follow-up adds one standalone
native proof driver, bringing the current infrastructure inventory to **17** (16
shared/setup files plus the proof driver).
The initial readiness audit and review corrections stay in test infrastructure. After
repeated full-suite restoration failures, the human approved the bounded product cache
remedy described below on 2026-10-03. Only `thread-scroll.ts` and `thread-scroller.tsx`
change product behavior. No dependencies, assertion tolerances, timeouts, holds or skips
change; the original transcript fixture remains intact and a separate held-replay fixture
adds regression coverage.

## Diagnosis and provenance

- **R — rendered before geometry.** #758's observed −847px code-line gap came from
  skipped `content-visibility:auto` layout. A box read can itself materialize skipped
  content and corrupt the following readiness check. `visualSampleExpression` now checks
  native `checkVisibility({ contentVisibilityAuto: true })` before the target box and
  before every descendant/ancestor box. Skipped descendants remain outside the readiness
  signature; measured transcript targets independently scroll and wait for native rendering.
  Product provenance: `thread-scroller.tsx:519`, `commit-list.tsx:117`,
  `diff-view.tsx:189,471`. These were read-only source references during the initial readiness phase; the later
  approved cache correction changes only the thread-scroll lifecycle described below.
- **S — settled sample rather than first mounted / first truth.** #794 documents a
  viewport action returning before its rendered frame; that fix is retained verbatim.
  Its one frame does not finish font loading, finite transitions or ResizeObserver work.
  The audit found raw / first-value geometry reads after route, density, theme, disclosure,
  and width changes. `waitForSettledSample` composes the existing #764 visual signature
  and #415 `waitForStable` (200ms), including focus identity and the measured value.
  It returns that accepted value, avoiding a separate racing read. A settled `false` or
  `0` is valid and fails an incompatible assertion immediately. Held loading fixtures
  omit global idle; infinite spinner ink remains excluded from stable layout.
- **A — assertions independent of readiness.** Existing geometry/paint/coverage matchers
  could wait until the test's expected answer happened to appear. Coverage, 44px/47px
  floors, exact widths/offsets, fill/opacity, token/cost and overflow checks now remain
  assertions on the accepted sample where affected. State predicates such as disclosure
  `aria-expanded`, mounted data and focus arrival remain explicit event readiness.
- **K — existing safe waits retained.** #409 focus arrival and Escape focus restoration,
  #736 hit-test + finite-animation readiness, #764 settled overflow/screenshots, #758
  fence rendering, and #794 viewport frames are retained. Frame observers, deliberate
  action-and-measurement experiments and failure diagnostics are not repeated or delayed.
  Merely finding a DOM read was not grounds for a conversion: redundant contrast,
  focus and visibility conversions were removed after review.

These are structural audit findings, not claims that every affected spec independently
flaked in CI. The deterministic helper reproductions below establish the shared failure
mechanisms; targeted browser runs establish integration. Existing source comments retain
issue-specific reproduction history (notably #548, #736, #369 and #758).

**Counts:** 462 baseline sampling calls; 45 affected spec rows; 18 `NONE` affected
rows (10 have no sampling calls). At `31597045`, there were **208 actual** accepted-sample
calls; the initial 209-entry list incorrectly included the helper declaration. After review
round 1 and the loaded-rail correction there were **209 actual calls**. The new held-replay
regression adds three, bringing the current total to **212 actual calls**, excluding
declarations; current locations follow. Baseline sampling counts and `NONE` rows remain
unchanged.

## Exhaustive spec inventory

A sampling site is a browser call containing geometry, visibility, focus, contrast or a
named expression that computes them. Multiple box reads inside one call count once.
Locations below are **baseline** call-start lines so review can use `git show 35a519de:<path>`;
accepted-sample locations are **current** source lines. `NONE` means no affected site,
not an omitted file. Counts include calls inside local sampling helpers, not their callers.
The existing-waits column names baseline explicit waits/action helpers; plain DOM/data
waits still need S when followed by a changed geometry sample.

| Spec | Sampling sites (baseline lines) | Affected sites (baseline lines) / fix | Existing waits (baseline lines) |
| --- | --- | --- | --- |
| [agents-dock.e2e.ts](agents-dock.e2e.ts) | 5: 153, 160, 222, 241, 247 | 153, 247. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 143, 147, 160, 175, 177, 204, 208, 222, 229, 237, 239, 241, 245, 270, 279, 282 |
| [application-update.e2e.ts](application-update.e2e.ts) | 13: 55, 74, 102, 115, 130, 139, 146, 147, 158, 178, 180, 193, 211 | 55, 74, 102, 115, 147, 158, 211. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 50, 53, 55, 74, 97, 100, 101, 102, 105, 108, 111, 114, 115, 124, 127, 128, 130, 133, 135, 137, 139, 144, 146, 147, 156, 158, 178, 180, 190, 193, 201, 202, 204, 208, 211, 217, 219 |
| [assistant-line-breaks.e2e.ts](assistant-line-breaks.e2e.ts) | 1: 122 | 122. #758 skipped Streamdown content: native rendering guard before scrolling/geometry and hold complete measurement; line-break and overflow expectations unchanged. | 101, 122 |
| [automations.e2e.ts](automations.e2e.ts) | 0: NONE | NONE. K: existing waits / direct data, focus or visibility checks retained. | 41, 46, 65, 73, 88, 92 |
| [chat-code-fence.e2e.ts](chat-code-fence.e2e.ts) | 2: 126, 170 | NONE. K: existing waits / direct data, focus or visibility checks retained. | 90, 114, 125, 126, 189, 194 |
| [command-palette.e2e.ts](command-palette.e2e.ts) | 2: 43, 65 | NONE. K: existing waits / direct data, focus or visibility checks retained. | 37, 41, 43, 49, 55, 56, 62, 64, 68 |
| [commit-list.e2e.ts](commit-list.e2e.ts) | 1: 199 | 199. #751 virtualizer top-gap: retain the 2px assertion; hold finite geometry, not acceptable coverage. | 105, 106, 184, 199, 222, 235, 238 |
| [composer-defaults.e2e.ts](composer-defaults.e2e.ts) | 0: NONE | NONE. K: existing waits / direct data, focus or visibility checks retained. | 98, 112, 113, 122, 142, 146, 150, 171, 175, 177, 179, 185, 186, 202 |
| [composer.e2e.ts](composer.e2e.ts) | 6: 115, 193, 195, 197, 211, 236 | 193, 195, 197. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 94, 122, 139, 143, 150, 153, 164, 179, 188, 207, 229, 249 |
| [diff-scroll.e2e.ts](diff-scroll.e2e.ts) | 4: 186, 216, 239, 276 | 186, 216, 239, 276. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 105, 108, 181, 210 |
| [empty-states.e2e.ts](empty-states.e2e.ts) | 0: NONE | NONE. K: existing waits / direct data, focus or visibility checks retained. | 75, 113, 127 |
| [git-sidebar.e2e.ts](git-sidebar.e2e.ts) | 6: 236, 336, 339, 348, 381, 413 | 236, 348, 413. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 158, 163, 190, 219, 235, 249, 250, 251, 252, 265, 277, 278, 283, 284, 298, 300, 309, 316, 319, 324, 326, 328, 329, 336, 357, 361, 363, 370, 381, 391, 401, 420, 421, 426, 427, 430, 431 |
| [github-core.e2e.ts](github-core.e2e.ts) | 7: 155, 157, 164, 238, 241, 246, 257 | 241, 257. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 48, 51, 54, 66, 75, 82, 95, 100, 110, 117, 121, 126, 141, 150, 155, 168, 171, 180, 184, 195, 201, 206, 216, 222, 236, 238, 244, 246, 269, 270, 272 |
| [github-layout.e2e.ts](github-layout.e2e.ts) | 31: 39, 88, 94, 116, 119, 122, 125, 127, 134, 161, 162, 171, 220, 232, 251, 337, 362, 435, 583, 622, 640, 694, 721, 733, 735, 759, 796, 821, 846, 862, 867 | 39, 88, 94, 116, 119, 122, 125, 127, 134, 161, 220, 232, 251, 337, 362, 435, 583, 622. #754 panes / #724 engine row: first-value measurements now hold layout; expected widths, breakpoints, row order, coverage and overflow are assertions. #721 frame/observer capture remains single-shot. | 39, 88, 94, 116, 119, 122, 125, 127, 134, 150, 161, 162, 169, 171, 205, 217, 218, 220, 232, 240, 251, 337, 345, 354, 360, 361, 362, 407, 423, 431, 576, 583, 618, 622, 654, 656, 657, 679, 691, 712, 721, 722, 723, 728, 730, 733, 734, 759, 782, 794, 812, 813, 815, 817, 820, 845, 857, 859, 862, 864, 866, 867 |
| [github-pr-review.e2e.ts](github-pr-review.e2e.ts) | 2: 62, 82 | NONE. K: existing waits / direct data, focus or visibility checks retained. | 37, 59, 61, 71, 82 |
| [github-sidebar.e2e.ts](github-sidebar.e2e.ts) | 11: 311, 356, 387, 399, 519, 531, 594, 604, 630, 648, 680 | 311, 356, 387, 399, 531, 594, 604, 648, 680. #621 mobile filter viewport/hit coverage and desktop focus-visible remain assertions on accepted samples, rather than readiness predicates. | 205, 206, 210, 211, 219, 228, 229, 230, 238, 246, 247, 248, 252, 253, 260, 261, 263, 264, 267, 268, 276, 279, 280, 281, 282, 285, 286, 287, 296, 297, 298, 299, 307, 310, 311, 356, 386, 410, 414, 415, 418, 421, 434, 452, 453, 469, 470, 477, 491, 492, 493, 499, 508, 515, 517, 518, 519, 520, 528, 530, 531, 558, 559, 562, 570, 571, 573, 574, 578, 579, 580, 587, 588, 592, 593, 594, 595, 597, 598, 603, 604, 623, 628, 629, 630, 639, 640, 646, 647, 648, 651, 652, 660, 661, 662, 678, 680, 696, 700 |
| [github-states.e2e.ts](github-states.e2e.ts) | 1: 57 | NONE. K: existing waits / direct data, focus or visibility checks retained. | 39, 54, 56 |
| [inbox.e2e.ts](inbox.e2e.ts) | 1: 151 | 151. #724 engine row: DOM order, arrangement, overflow and 44px checks moved intact from matcher to assertions. | 67, 88, 115, 151, 197 |
| [ios-sweep.e2e.ts](ios-sweep.e2e.ts) | 3: 117, 122, 126 | 126. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 110 |
| [mobile-projects.e2e.ts](mobile-projects.e2e.ts) | 8: 95, 117, 138, 139, 188, 223, 228, 230 | 95, 117, 139, 230. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 93, 138, 194, 220, 223, 225, 228, 255 |
| [mobile-tab-bar.e2e.ts](mobile-tab-bar.e2e.ts) | 8: 110, 119, 195, 201, 214, 224, 267, 300 | 119, 195, 201, 224. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 104, 110, 119, 140, 144, 145, 157, 160, 165, 168, 169, 170, 178, 186, 188, 195, 201, 204, 208, 214, 222, 224, 249, 253, 254, 258, 260, 267, 268, 284, 287, 291, 297, 322, 324, 329, 331, 333 |
| [mobile-task-controls.e2e.ts](mobile-task-controls.e2e.ts) | 9: 74, 75, 76, 83, 124, 144, 152, 153, 168 | 124, 153. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 57, 69, 97, 113, 143, 147, 150, 155, 164, 167, 179 |
| [new-task-hierarchy.e2e.ts](new-task-hierarchy.e2e.ts) | 11: 79, 102, 103, 104, 122, 123, 139, 142, 161, 179, 185 | 79, 161, 179, 185. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 95, 151, 174, 181, 193, 203, 205, 207, 221, 223, 226 |
| [new-task-picker-layout.e2e.ts](new-task-picker-layout.e2e.ts) | 9: 55, 73, 116, 186, 192, 201, 204, 239, 247 | 73, 247. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 55, 116, 120, 124, 126, 130, 131, 186, 201, 239, 241, 245, 246, 263 |
| [new-task.e2e.ts](new-task.e2e.ts) | 10: 120, 123, 129, 150, 156, 158, 161, 184, 186, 249 | 129. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 120, 123, 125, 127, 129, 146, 148, 150, 151, 153, 156, 158, 161, 163, 177, 181, 196, 209, 223, 248, 277, 280, 286, 296, 305, 309, 315, 323, 327, 349, 358, 369, 378, 385, 395, 412, 431, 449, 453, 456, 461, 470 |
| [page-headings.e2e.ts](page-headings.e2e.ts) | 1: 62 | 62. QA appearance/font changes: settle layout; painted predicate observes native rendering before boxes. Keep exactly-one landmark and painted-label checks. | 56, 59 |
| [plan-mode.e2e.ts](plan-mode.e2e.ts) | 5: 117, 174, 217, 223, 256 | 217, 223. #383 mobile reflow: replace y=57 / width>380 readiness predicate with stable geometry; preserve exact x=0, y=57, w=390 assertions. Existing settleVisual overflow path retained. | 95, 97, 104, 106, 111, 134, 156, 160, 173, 184, 187, 198, 201, 203, 217, 234, 256, 271, 285, 290 |
| [progressive-history.e2e.ts](progressive-history.e2e.ts) | 14: 147, 175, 193, 197, 199, 230, 264, 443, 453, 459, 499, 509, 528, 532 | 197, 528, 532. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 166, 175, 197, 212, 255, 306, 310, 319, 321, 340, 352, 353, 372, 376, 403, 407, 431, 440, 443, 446, 459, 493, 522 |
| [project-groups.e2e.ts](project-groups.e2e.ts) | 3: 192, 193, 216 | 192. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 133, 135, 137, 144, 147, 160, 163, 174, 177, 192, 205, 210, 220, 221, 227, 231 |
| [project-rail.e2e.ts](project-rail.e2e.ts) | 11: 209, 210, 212, 216, 226, 278, 283, 317, 329, 350, 386 | 209, 210, 212, 226, 278, 283, 386. S: hold geometry after route/width changes. Loaded trace also proves stable body before expanded rail mounting; observe expanded commit, measured-target native rendering and existing finite animations, then hold actual width/opacity. Exact 232px, opacity 1 and AA 4.5 expectations remain assertions. | 107, 132, 133, 134, 153, 157, 174, 175, 183, 196, 201, 216, 267, 283, 292, 317, 329, 361, 362, 367, 382, 386 |
| [queued-stack.e2e.ts](queued-stack.e2e.ts) | 0: NONE | NONE. K: existing waits / direct data, focus or visibility checks retained. | 114, 143, 164, 172, 177, 201, 213 |
| [quick-list.e2e.ts](quick-list.e2e.ts) | 50: 248, 255, 366, 370, 372, 378, 394, 398, 406, 409, 478, 486, 598, 654, 657, 660, 670, 722, 732, 734, 836, 843, 889, 940, 1087, 1093, 1117, 1132, 1168, 1181, 1200, 1303, 1373, 1434, 1444, 1451, 1507, 1526, 1539, 1557, 1574, 1585, 1648, 1657, 1812, 1817, 1820, 1869, 2006, 2011 | 366, 370, 372, 378, 732, 734, 889, 940, 1093, 1117, 1132, 1168, 1181, 1200, 1303, 1373, 1451, 1526, 1539, 1557, 1574, 1585, 1648, 1869. #617/#621/#166 group expansion, density, width contention and ResizeObserver token/cost decisions: observe stable boxes; preserve 47px, 44px, pixel and token/cost expectations. Swipe fixture retains real finite-animation completion. | 219, 244, 265, 275, 339, 352, 366, 370, 372, 378, 406, 409, 428, 436, 437, 447, 448, 453, 461, 481, 485, 486, 496, 517, 537, 606, 609, 627, 629, 634, 637, 642, 659, 688, 698, 718, 838, 842, 843, 863, 877, 889, 935, 1083, 1087, 1123, 1126, 1130, 1181, 1188, 1195, 1276, 1365, 1398, 1408, 1434, 1440, 1446, 1499, 1507, 1526, 1539, 1557, 1574, 1577, 1585, 1601, 1631, 1646, 1653, 1657, 1660, 1666, 1738, 1751, 1753, 1764, 1766, 1769, 1777, 1779, 1787, 1788, 1794, 1799, 1800, 1802, 1811, 1820, 1869, 1910, 1923, 1931, 1932, 1935, 1944, 1945, 1948, 1963, 1970, 2001, 2003, 2006, 2014, 2024, 2026 |
| [repo-git-diff.e2e.ts](repo-git-diff.e2e.ts) | 0: NONE | NONE. K: existing waits / direct data, focus or visibility checks retained. | 150, 194 |
| [repo-git.e2e.ts](repo-git.e2e.ts) | 2: 179, 197 | 179, 197. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 65, 73, 88, 117, 120, 142, 148, 171, 174, 184 |
| [review-gate.e2e.ts](review-gate.e2e.ts) | 5: 116, 118, 119, 129, 175 | NONE. K: existing waits / direct data, focus or visibility checks retained. | 91, 107, 128, 142, 148, 157, 158, 181, 185, 186 |
| [run-header-ci-wait.e2e.ts](run-header-ci-wait.e2e.ts) | 6: 86, 87, 99, 101, 102, 136 | 87, 101, 136. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 70, 86, 98, 99, 113, 116, 124, 134 |
| [selection-states.e2e.ts](selection-states.e2e.ts) | 36: 100, 107, 109, 144, 146, 149, 214, 230, 239, 245, 258, 263, 276, 289, 316, 338, 370, 375, 401, 405, 410, 415, 419, 438, 445, 460, 470, 476, 488, 492, 498, 505, 509, 538, 540, 546 | 214, 230, 239, 245, 263, 276, 289, 370, 375, 401, 460, 509. #369/#617 hover and selected state: expected fill and pin opacity moved to assertions; geometry, focus and finite animation completion determine readiness. Contrast thresholds and focus-visible assertions retained. | 106, 136, 144, 146, 194, 214, 221, 230, 239, 245, 251, 258, 263, 274, 276, 289, 298, 307, 313, 316, 319, 329, 334, 341, 343, 352, 370, 372, 375, 436, 438, 442, 443, 447, 455, 479, 495, 503, 534, 538, 540, 546 |
| [settings-agent-config.e2e.ts](settings-agent-config.e2e.ts) | 3: 52, 56, 99 | 52. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 48, 69, 98 |
| [settings-agents.e2e.ts](settings-agents.e2e.ts) | 0: NONE | NONE. K: existing waits / direct data, focus or visibility checks retained. | 81, 87, 100, 106, 117, 118 |
| [settings-appearance.e2e.ts](settings-appearance.e2e.ts) | 2: 116, 121 | 116, 121. S: density geometry returns the held measurement. Loaded follow-up: baseline Dark action at80 (current84) follows semantic readiness while its target later shifts60px; current83 adds existing target settle before the same click. Original expectations/timeouts remain unchanged. | 52, 72, 76, 81, 93, 108, 120, 129 |
| [settings-bookmarklets.e2e.ts](settings-bookmarklets.e2e.ts) | 0: NONE | NONE. K: existing waits / direct data, focus or visibility checks retained. | 48, 95, 123, 129, 137, 141, 152, 165, 196, 201, 206, 210, 216, 217 |
| [settings-monitoring.e2e.ts](settings-monitoring.e2e.ts) | 0: NONE | NONE. K: existing waits / direct data, focus or visibility checks retained. | 147, 161, 218, 220, 221 |
| [settings-resources.e2e.ts](settings-resources.e2e.ts) | 0: NONE | NONE. K: existing waits / direct data, focus or visibility checks retained. | 50, 60, 66, 68, 74, 76, 84, 86, 88, 99, 101 |
| [settings-sidebar.e2e.ts](settings-sidebar.e2e.ts) | 3: 25, 79, 93 | 25, 79. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 23, 25, 36, 53, 54, 56, 59, 60, 64, 66, 68, 75, 78, 79, 89, 92 |
| [settings-skills.e2e.ts](settings-skills.e2e.ts) | 4: 111, 116, 120, 130 | NONE. K: existing waits / direct data, focus or visibility checks retained. | 76, 93, 97, 106, 119, 145, 158, 159, 180, 182, 195 |
| [sidebar-project-header.e2e.ts](sidebar-project-header.e2e.ts) | 4: 75, 103, 116, 118 | 103, 118. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 53, 67, 69, 71, 75, 76, 78, 86, 87, 89, 103, 109, 112, 116, 118, 123 |
| [sidebar-reference-status.e2e.ts](sidebar-reference-status.e2e.ts) | 6: 85, 131, 132, 184, 197, 205 | 85, 184, 205. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 63, 85, 111, 117, 120, 131, 132, 136, 143, 144, 145, 160, 163, 181, 184, 194, 197, 202, 205 |
| [skill-search-ranking.e2e.ts](skill-search-ranking.e2e.ts) | 6: 179, 182, 189, 196, 200, 202 | 202. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 111, 114, 122, 124, 148, 154, 172, 178, 184, 196, 220 |
| [skills-update.e2e.ts](skills-update.e2e.ts) | 1: 72 | NONE. K: existing waits / direct data, focus or visibility checks retained. | 70, 89, 91, 104, 122, 135 |
| [smoke.e2e.ts](smoke.e2e.ts) | 23: 113, 175, 176, 199, 200, 219, 236, 238, 252, 300, 396, 446, 447, 450, 479, 509, 510, 512, 552, 639, 641, 653, 745 | 113, 200, 219, 300, 396, 450, 479, 512, 552, 653. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 113, 177, 182, 200, 216, 219, 233, 236, 238, 241, 245, 252, 254, 255, 257, 274, 300, 327, 346, 370, 500, 552, 576, 577, 593, 605, 608, 609, 619, 630, 707, 720, 722, 733, 740, 755, 769, 781, 783, 793 |
| [task-changes.e2e.ts](task-changes.e2e.ts) | 2: 261, 268 | 261, 268. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 120, 130, 146, 154, 162, 185, 197, 206, 216, 217, 222, 236, 249 |
| [task-files.e2e.ts](task-files.e2e.ts) | 5: 120, 143, 248, 270, 276 | 120, 248, 270, 276. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 120, 134, 143, 158, 179, 182, 190, 203, 208, 213, 216, 223, 228, 231, 246, 248, 252, 254, 256, 266 |
| [task-github-items.e2e.ts](task-github-items.e2e.ts) | 3: 115, 146, 166 | 115, 146, 166. PR panel mount/phone chip tab: stable geometry; viewport left/right coverage is asserted, not polled. | 101, 115, 128, 142, 146, 166 |
| [task-handoff.e2e.ts](task-handoff.e2e.ts) | 6: 76, 143, 154, 181, 204, 228 | 76, 154, 204. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 67, 72, 76, 88, 89, 91, 98, 99, 116, 117, 124, 127, 143, 154, 176, 181, 192, 194, 204, 224, 228 |
| [task-thread.e2e.ts](task-thread.e2e.ts) | 57: 141, 179, 181, 185, 190, 200, 441, 443, 451, 454, 495, 579, 621, 624, 653, 704, 707, 709, 715, 724, 725, 747, 748, 749, 756, 757, 758, 760, 764, 775, 776, 780, 792, 793, 801, 802, 803, 815, 816, 818, 819, 822, 823, 947, 957, 977, 1025, 1040, 1072, 1073, 1080, 1083, 1097, 1113, 1132, 1163, 1216 | 141, 443, 621, 624, 653, 709, 715, 725, 747, 749, 758, 760, 764, 792, 793, 803, 818, 819, 822, 823, 947, 957, 977, 1072, 1073, 1083, 1132, 1163, 1216. #758 lazy transcript and #794 mobile Copy branch: guard native rendering before boxes; scroll transcript targets. Session control coverage and menu 44px thresholds are assertions. Keep #415 title-edit focus/geometry stability. Review round 1 additionally restores editor viewport bottom on every caller and replaces immediate disclosure/visibility reads; see precise review sites below. | 115, 128, 171, 180, 184, 212, 218, 311, 323, 333, 358, 375, 380, 388, 393, 434, 440, 441, 443, 453, 459, 461, 468, 479, 485, 492, 494, 504, 531, 556, 562, 564, 565, 571, 574, 576, 579, 586, 595, 609, 618, 619, 643, 653, 686, 691, 694, 703, 713, 715, 719, 721, 723, 737, 746, 787, 799, 809, 814, 828, 945, 947, 955, 957, 975, 977, 1053, 1055, 1060, 1062, 1071, 1073, 1080, 1083, 1097, 1104, 1113, 1125, 1132, 1162, 1215, 1230 |
| [task-views-layout.e2e.ts](task-views-layout.e2e.ts) | 2: 67, 68 | NONE. K: existing waits / direct data, focus or visibility checks retained. | 50, 62, 66, 74, 84, 88, 90, 94, 96, 101, 131, 135, 139, 142 |
| [thread-scroll.e2e.ts](thread-scroll.e2e.ts) | 16: 79, 132, 144, 252, 260, 271, 299, 301, 322, 324, 347, 384, 425, 439, 456, 472 | 79, 271, 299, 301, 384, 425, 472. R/S: review round 1 fixes assistant width to choose an already-rendered assistant at the live tail, without scrolling the reader. Other held measurements retain assertions. The approved separate held-replay regression adds actual partial/native-container readiness and pixel plus visible-row identity assertions; see the product correction below. | 92, 108, 125, 126, 227, 235, 243, 248, 249, 252, 268, 276, 280, 283, 299, 322, 420, 452, 457, 458 |
| [tools-menu.e2e.ts](tools-menu.e2e.ts) | 0: NONE | NONE. K: existing waits / direct data, focus or visibility checks retained. | 67, 91, 135, 136 |
| [touch-targets.e2e.ts](touch-targets.e2e.ts) | 16: 88, 99, 127, 157, 178, 182, 193, 221, 241, 279, 302, 307, 359, 380, 381, 414 | 88, 99, 127, 221, 241, 307, 359, 380, 381, 414. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 122, 170, 178, 180, 201, 203, 211, 231, 233, 239, 254, 266, 270, 279, 283, 287, 292, 297, 311, 316, 321, 344, 358, 363, 366, 370, 394, 414, 438, 450 |
| [variants-compare.e2e.ts](variants-compare.e2e.ts) | 1: 153 | 153. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 119, 129, 151, 164, 166, 179, 183, 184 |
| [worker-conversation.e2e.ts](worker-conversation.e2e.ts) | 10: 91, 108, 122, 156, 186, 203, 209, 228, 231, 258 | 108, 122, 156, 186, 203, 231, 258. #548 sticky-header evidence retained. Review round 1 scrolls/measures cards individually with native guards on card/clock/heading. Preserve all inset, heading, viewport, click coverage and scroll assertions. | 91, 108, 118, 120, 122, 141, 143, 146, 156, 177, 181, 185, 186, 199, 203, 209, 212, 218, 220, 225, 228, 231, 237, 241, 246, 253, 255, 258, 260 |
| [worker-relationships.e2e.ts](worker-relationships.e2e.ts) | 2: 139, 273 | 139, 273. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 88, 108, 117, 128, 131, 135, 156, 158, 166, 171, 179, 184, 188, 212, 217, 225, 230, 236, 241, 244, 265, 269, 281, 287 |
| [workflows.e2e.ts](workflows.e2e.ts) | 6: 102, 159, 211, 240, 273, 342 | 159, 273, 342. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 74, 78, 82, 102, 104, 120, 133, 142, 143, 158, 239, 334, 357, 360 |

## Precise accepted-sample sites (current)

The helper's provenance comment applies to these direct calls. Declarations are excluded.
Measurements keep their spec's selectors and assertions. The baseline inventory above
remains anchored at `35a519de`; review corrections and their current sites follow below.

- `agents-dock.e2e.ts`: 154, 248.
- `application-update.e2e.ts`: 56, 75, 103, 116, 148, 159, 212.
- `assistant-line-breaks.e2e.ts`: 123.
- `composer.e2e.ts`: 194, 196, 198.
- `diff-scroll.e2e.ts`: 187, 217, 240, 277.
- `git-sidebar.e2e.ts`: 237, 349, 414.
- `github-core.e2e.ts`: 242, 258.
- `github-layout.e2e.ts`: 39, 88, 95, 115, 119, 123, 127, 130, 137, 165, 225, 237, 256, 330, 355, 429, 577.
- `github-sidebar.e2e.ts`: 312, 357, 388, 400, 532, 595, 605, 649, 681.
- `ios-sweep.e2e.ts`: 127.
- `mobile-projects.e2e.ts`: 96, 118, 140, 231.
- `mobile-tab-bar.e2e.ts`: 120, 196, 202, 225.
- `mobile-task-controls.e2e.ts`: 125, 154.
- `new-task-hierarchy.e2e.ts`: 80, 162, 180, 186.
- `new-task-picker-layout.e2e.ts`: 74, 248.
- `new-task.e2e.ts`: 130.
- `page-headings.e2e.ts`: 63.
- `plan-mode.e2e.ts`: 219.
- `progressive-history.e2e.ts`: 197, 528, 532.
- `project-groups.e2e.ts`: 193.
- `project-rail.e2e.ts`: 211, 212, 214, 228, 280, 286, 390.
- `quick-list.e2e.ts`: 367, 371, 373, 379, 733, 735, 890, 941, 1094, 1118, 1133, 1169, 1182, 1201, 1304, 1374, 1452, 1561, 1578, 1589, 1652, 1873.
- `repo-git.e2e.ts`: 180, 198.
- `row-height.ts`: 62.
- `run-header-ci-wait.e2e.ts`: 88, 102, 137.
- `selection-states.e2e.ts`: 215, 231, 241, 248, 267, 281, 295, 376, 382, 409, 468, 517.
- `settings-agent-config.e2e.ts`: 53.
- `settings-appearance.e2e.ts`: 120, 125; target action readiness at83 uses existing `settleVisual`.
- `settings-sidebar.e2e.ts`: 26, 80.
- `sidebar-project-header.e2e.ts`: 104, 119.
- `sidebar-reference-status.e2e.ts`: 86, 185, 206.
- `skill-search-ranking.e2e.ts`: 203.
- `smoke.e2e.ts`: 114, 201, 220, 301, 397, 451, 480, 513, 553, 654.
- `task-changes.e2e.ts`: 262, 269.
- `task-files.e2e.ts`: 121, 249, 271, 277.
- `task-github-items.e2e.ts`: 117, 148, 168.
- `task-handoff.e2e.ts`: 77, 155, 206.
- `task-thread.e2e.ts`: 135, 136, 150, 456, 634, 637, 666, 722, 728, 738, 760, 762, 771, 773, 777, 805, 806, 816, 831, 832, 835, 836, 961, 972, 993, 1089, 1090, 1100, 1150, 1184, 1237.
- `thread-scroll.e2e.ts`: 90, 284, 307, 343, 354, 382, 465, 506, 553. The three new
  regression samples at 307/343/354 hold the original visible anchor, native prefix-container
  extent, and restored visible anchor. Native rendering precedes target box reads.
- `touch-targets.e2e.ts`: 89, 100, 128, 222, 242, 308, 360, 381, 382, 415.
- `variants-compare.e2e.ts`: 154.
- `worker-conversation.e2e.ts`: 115, 201, 229, 256.
- `worker-relationships.e2e.ts`: 140, 274.
- `workflows.e2e.ts`: 160, 274, 343.

## Shared helpers and infrastructure

| File | Audit / exact sites | Result |
| --- | --- | --- |
| `visual-ready.ts` | `visualSampleExpression` target / descendant geometry; `settleVisual`; `settledSampleExpression` / `waitForSettledSample`; `visibilitySampleExpression` / `disclosureVisibilityExpression` | R/S: guard native rendering before boxes; retain fonts, finite/infinite animation distinctions, appearance and optional idle; hold focus identity and return accepted value. Disclosure `aria-expanded` observes the commit; visibility remains an independent boolean, preserving non-empty box semantics. |
| `contrast.ts` | `focusWithKeyboard` predecessor/focus at baseline 113–149; `dismissWithEscape` at 164–171; `hoverVisiblePoint` at 187–211 | Focus and Escape readiness retained (#409). Hover now checks native rendering **before** scrolling/rect reads (#758/#795); it moves the pointer once using the accepted hit-tested point. Do not filter skipped controls out of keyboard tab order. Contrast expression reads computed paint, not geometry; AA thresholds stay assertions. |
| `row-height.ts` | `heights` at baseline 40–56, sample at 59 | R/S: native visibility before all four measured elements; hold geometry across density/expand rendering. Preserve task-height equality, exact 47px and overlap/toggle expectations. |
| `transcript-measurements.ts` | `assistantWidthExpression`; `messageClockExpression` | R: select an already-rendered tail assistant without scrolling; scroll each worker card separately and reject until card/clock/optional heading were natively rendered before all their box reads. Body readiness alone is insufficient. |
| `session-layout.ts` | `expectEditorFitsViewport`; all four session samples in `task-thread.e2e.ts` | A: retain the old editor viewport-bottom bound as `editor.bottom <= viewportHeight + 1`; viewport height belongs to the accepted sample, never a second browser read or an expected-answer waiter. |
| `project-rail-ready.ts` | `expandedRailSampleExpression`; `project-rail.e2e.ts` expansion samples | R/S: wait on mounted names plus expanded `data-expanded` / toggle `aria-expanded` commit; check native rail/name/ink rendering before box/style reads. Return actual width/opacity; inherited finite-animation wait and unchanged 232px/opacity 1 assertions finish the contract. |
| `agent-browser.ts` | failure probe rects at 190, active focus at 216; `waitForStable`/`waitForValue`; `setViewport` (#794) | K: failure probe intentionally records the failing frame. Monotonic deadlines, diagnostics reserve and returned accepted sample retained. Viewport rendered-frame fix unchanged. |
| `github-fixture.ts` | route/data readiness, keyboard and surface helpers | K: no direct geometry sampling; existing named route/data/focus waits retained. |
| `repo-diff-coverage.ts` | virtualizer mounting/data checks and last-tree selection | K: no geometry sampling. Do not replace file-count/data completion with visual settlement. |
| `failure-setup.ts` | test-failure bundle hook | K: immediate diagnostics, no readiness changes. |
| `fixture-server.ts` | subprocess teardown | NONE: no browser geometry/focus/visibility. |
| `poll.ts` | server condition / deadline polling | NONE: no browser geometry/focus/visibility. |
| `workspace-registry.ts` | server registry fixture setup | NONE: no browser geometry/focus/visibility. |
| `vitest.config.ts` | spec selection, browser lane configuration | NONE: no browser geometry/focus/visibility. |
| `fetch-setup.mjs` | fetch environment setup | NONE: no browser geometry/focus/visibility. |
| `fixtures/make-large-thread.ts` | deterministic server fixture generation | NONE: no browser geometry/focus/visibility. |
| `fixtures/theme-layout-proof.ts` | standalone native blank-document render-phase regression; initial and held geometry signatures, original selector action | R/S: native checks from existing visual expression before boxes. One fixture-owned RAF commits the observed60px shift; first-truth comparison is red, existing200ms target settle returns the actual committed sample. No product DOM writes or expected-theme readiness. This is a manual provider proof, not an additional full-suite spec. |

## Red / green evidence and verification

Logs are local, gitignored `.ai/qa/issue-795/` evidence. The regression source and this
report are durable repository artifacts.

- `npm ci`: exit 0 in this worktree; `/tmp/795-npm-ci.log`.
- `npm test -- visual-ready`: baseline reproduction failed 3 tests;
  `visual-ready-red.log`. A stronger **guard-only rollback** kept the new wrapper API,
  removed only the target/descendant native guards, and failed exactly 2 tests (5 passed):
  `native-guards-red-proof.log`. It reproduced forced skipped layout and premature target
  acceptance. The source was restored immediately after the run.
- Hover regression before its native guard: `npm test -- visual-ready`, exit 1,
  **1 failed / 6 passed**, `hover-native-red.log`. Failure is `forced skipped hover layout`.
  The fixture models scroll requesting rendering on the next frame; no expected geometry
  threshold or fake delay controls readiness.
- Ratchet wrapper regression before scanner recognition: exit 1,
  `ratchet-wrapper-red.log`; new helper calls cannot hide hover waits or product DOM writes.
- Focused unit green: `npm test -- visual-ready agent-browser-wait-value e2e-wait-discipline`,
  **62 passed / 3 files**, `helpers-next.log`. The accepted-sample tests include false/zero
  and changing layout/focus resetting the hold. #794 viewport-frame tests remain green.
- `E2E_WAIT_DISCIPLINE_UPDATE=1 npm test -- e2e-wait-discipline`: exit 0,
  **33 passed**, `ratchet-final.log`. The baseline only shrinks removed legacy sites;
  no entries or exceptions were added.
- `npm run typecheck:web`: exit 0, `typecheck-web-final.log`.
- `npm run test:e2e -- chat-code-fence.e2e.ts task-thread.e2e.ts`: **55 passed**, exit 0,
  `thread-browser-green.log`. First exploratory run failed a changed tab predecessor
  filter (54 passed / 1 failed, `thread-browser.log`); that change was reverted and never
  shipped. Native skipped controls still participate in keyboard Tab order.
- `npm run test:e2e -- chat-code-fence.e2e.ts task-thread.e2e.ts assistant-line-breaks.e2e.ts page-headings.e2e.ts`:
  **67 passed / 4 files**, exit 0, `transcript-final.log`.
- `npm run test:e2e -- github-layout.e2e.ts quick-list.e2e.ts -t 'pane boundaries|reflows when|engine|264px|420px|group row'`:
  **10 selected tests passed / 2 files**, exit 0, `layout-final.log`. Other tests are
  excluded by the name filter; no test skip or assertion was changed.

- `npm run test:e2e -- github-sidebar.e2e.ts task-github-items.e2e.ts worker-conversation.e2e.ts plan-mode.e2e.ts selection-states.e2e.ts -t 'keyboard operable|chip lands|actionable delivery|unmounted request|iPhone|selection|neutral'`:
  **35 passed / 4 files**, with 33 excluded by the name filter; `interaction-final.log`.
  The isolated plan-mode phone test failed because the same-spec earlier test that creates
  its overlay was excluded. This was a selection/setup error, not readiness evidence.
- `npm run test:e2e -- plan-mode.e2e.ts`: **6 passed / 1 file**, exit 0,
  `plan-final.log`, including the phone reflow case with its required preceding setup.

- `npm run test:e2e -- task-github-items.e2e.ts`: **3 passed / 1 file**, exit 0,
  `task-github-final.log`, including the latest accepted tab geometry sample.

## Review round 1 — corrections and proof

Independent review of `31597045` requested three corrections. Its unchanged-body fixture
accepted a stable zero assistant width and four all-zero insets whose original assertions
passed; its accepted editor sample ended at 1000px in an 844px viewport yet passed normal
padding checks. The original Enter disclosure visibility read also had no commit wait.
The verified pre-fix output is `review-round-1/reviewer-proof.log`.

- R1: `thread-scroll.e2e.ts:80` now calls `assistantWidthExpression`, selecting the latest
  natively rendered assistant before its box read. No scroll changes the live-tail state.
  `worker-conversation.e2e.ts:111` samples each of the four cards independently through
  `messageClockExpression`; card, clock and the optional request heading must be rendered
  at sample entry. Scrolling cannot authorize geometry in that same skipped task. All
  four inset assertions and the phone heading-height assertion remain unchanged.
- R2: `task-thread.e2e.ts` records viewport height in each accepted session sample and
  calls `expectEditorFitsViewport` at all four callers (current lines 962, 973, 994, 1101).
  The old exact one-pixel viewport allowance is preserved as an assertion; readiness does
  not wait until this expected geometry becomes correct.
- R3: disclosure visibility now observes `aria-expanded` before its held visibility
  measurement (`task-thread.e2e.ts:720`). Both a settled false and an already-rendered
  zero measurement remain accepted results for assertions to reject. Visibility retains
  the old non-empty box semantics, with native visibility checked before those boxes.
  The other legacy `run-details` / `follow-up-engine` visibility exemptions in this file
  are also replaced. The Space disclosure attribute assertion now waits for its commit.
  Remaining baseline visibility sites in `mobile-task-controls` concern search after
  route/query changes; `smoke` concerns route/viewport shell visibility, not the same
  keyboard disclosure trigger. No baseline exemption is taken as proof of readiness.
  This round removes four stale legacy entries; no allowances or exceptions are added.
- Optional review cleanup: inbox facts explicitly narrow null; accepted-sample counts
  exclude the function declaration.

Review evidence is under `.ai/qa/issue-795/review-round-1/` in the implementation worktree:

| Command / reproduction | Outcome | Evidence |
| --- | --- | --- |
| `npm ci` | exit 0 | `npm-ci.log` |
| `npm test -- transcript-measurements` with pre-review measurement expressions | exit 1; 3 failed | `lazy-target-red.log` |
| Same command after native target fixes | exit 0; 3 passed | `lazy-target-green.log` |
| `npm test -- session-layout` with no viewport assertion | exit 1; 2 failed | `editor-bound-red.log` |
| Same command after restoring the one-pixel assertion | exit 0; 2 passed | `editor-bound-green.log` |
| `npm test -- visual-ready` before disclosure commit guard | exit 1; 1 failed / 7 passed | `disclosure-red.log` |
| Same command after commit guard | exit 0; 8 passed | `disclosure-green.log` |
| Same command before preserving non-empty visibility boxes | exit 1; 2 failed / 9 passed | `visibility-box-red.log` |
| Behavior-only rollback: `npm test -- transcript-measurements session-layout visual-ready` | exit 1; 6 failed / 10 passed. Helper APIs retained; only the reviewed behaviors removed, then restored immediately | `behavior-only-rollback-red.log` |
| `npm test -- transcript-measurements session-layout visual-ready agent-browser-wait-value e2e-wait-discipline` | exit 0; 72 passed / 5 files | `helpers-green.log` |
| `E2E_WAIT_DISCIPLINE_UPDATE=1 npm test -- e2e-wait-discipline` | exit 0; 33 passed; baseline only shrinks | `ratchet-green.log` |
| `npm run typecheck:web` | exit 0 | `typecheck-web.log` |
| `npm run test:e2e -- thread-scroll.e2e.ts worker-conversation.e2e.ts task-thread.e2e.ts` | exit 0; all 74 tests / 3 complete files passed, 158.95s; no test-name filter or skips | `browser-green.log` |

The lazy fixture holds body readiness true while the measured target remains skipped;
first-task geometry is forbidden, not merely filtered by a width/inset expectation. The
rendered-zero test returns zero and lets the unchanged `>200` assertion reject it. The
composer regressions reject 1000px/844px even with valid padding, accept 845px exactly,
and reject 845.001px. The disclosure regression holds the body ready while the commit is
delayed, then accepts false after the control commits: it never polls visibility until true.

## Loaded-rail follow-up — reload commit before measurement

The parent's first integrated AFTER-loaded run at `923becf3` failed exactly two
`project-rail` tests: expansion after reload (`settledExpanded` caller at then-line 316)
and dark AA setup after reload (then-line 357), both at then-line 286 with
`expected false to be true`. The failures precede the downstream AA assertions.
Both accessibility snapshots contain expanded names / `Collapse projects` with
`aria-expanded=true`; both screenshots show a widened rail with name ink still absent.
Capture happens after the accepted boolean, so these later images alone do not identify
the earlier sample's width, opacity or animation state.

Native diagnostic runs preserved the old returned boolean / held signature and recorded
measurements from that same browser task. Both complete targeted runs passed (they did
not reproduce the assertion failure), but the second trace records **seven false samples
with no rail, toggle, name or animations mounted yet**, while body readiness was already
passing. Its mounted samples have width 232, opacity 1 and finished animations. The
deterministic fixture then pins a stable body through that missing-commit interval: the
old helper accepts false instead of returning null. No separate animation-start defect
was established, so the generic finite-animation mechanism remains unchanged.

`project-rail-ready.ts:2` now gates on the mounted name and the independent expanded
`data-expanded` / toggle `aria-expanded` commit, then native rendering of the rail, name
and ink **before** their geometry/style measurement. `project-rail.e2e.ts:286` holds the
actual `{width, opacity}` sample. Exact **232px**, **opacity 1** and **AA 4.5** checks remain
assertions; settled wrong width / zero opacity are accepted measurements that those
assertions reject. The existing finite-animation gate still waits out #711's width and
delayed text fade, including the reduced-motion path. Hold and timeout values are unchanged.

Worker evidence: `.ai/qa/issue-795/loaded-rail-fix/`. Original parent bundles are preserved
at `.ai/qa/issue-795/loaded-fixed-failures/project-rail/` and copied into the worker evidence
under `loaded-fixed-failures/project-rail/`; `loaded-fixed-lane-1.log` retains the failures.
Temporary diagnostics were removed before the fix; `native-trace.ndjson` and
`native-trace-summary.json` retain the measured states.

| Command / reproduction | Outcome | Worker evidence |
| --- | --- | --- |
| `npm ci` | exit 0 | `npm-ci.log` |
| `npm test -- project-rail-ready` with the original boolean expression | exit 1; all 3 commit/native regressions failed | `commit-native-red.log` |
| Same command with semantic/native guards | exit 0; initial 3 passed | `commit-native-green.log` |
| Same command, behavior-only guard rollback with sample API retained | exit 1; 4 failed / 2 guards passed, then source restored | `behavior-only-rollback-red.log` |
| `npm test -- project-rail-ready visual-ready transcript-measurements session-layout agent-browser-wait-value e2e-wait-discipline` | exit 0; 78 passed / 6 files, including all 6 rail regressions | `helpers-green.log`, `helpers-restored-green.log` |
| `npm run typecheck:web` | exit 0 | `typecheck-web.log` |
| Complete `npm run test:e2e -- project-rail.e2e.ts`, diagnostics before fix, under full CPU saturation | exit 0; 12 passed, 36.62s; CPU mean 99.996%, min 99.875%, 32 samples; all 24 burners cleaned | `diagnostic-before/{suite.log,status.json,cpu-load.ndjson}` |
| Same unchanged-behavior diagnostic command, with native trace retained | exit 0; 12 passed, 35.34s; CPU mean 99.998%, min 99.896%, 51 samples; all 24 burners cleaned | `diagnostic-before-2/{suite.log,status.json,cpu-load.ndjson}` |
| Complete `npm run test:e2e -- project-rail.e2e.ts` after fix, under full CPU saturation | exit 0; all 12 passed, 34.79s; CPU mean 99.997%, min 99.834%, 50 samples; all 24 burners cleaned | `fixed-after/{suite.log,status.json,cpu-load.ndjson}` |
| `git diff --check` | exit 0 | focused diff validation |

The supervised load uses one default-priority busy Python process pinned to each available
CPU (0–23), samples `/proc/stat` every two seconds, and terminates/reaps every burner in
`finally`. No browser test names were filtered or skipped. These are complete focused-file
results, not a replacement for the parent's four-lane acceptance run.

## Loaded suites and parent acceptance

The **BEFORE-fix full four-lane loaded suite PASSED** at baseline `35a519de`, before
integration, as reported by the parent: all four lanes green; CPU mean **100%**, minimum
**99.97%**, **156** utilization samples, **24** pinned default-priority CPU burners
cleaned up; **612 passed / 7 existing skips**. Both result sets are retained. Parent evidence:
`.ai/qa/issue-795/loaded-baseline` and `.ai/qa/local-runs/1791011166587-1662221`.

Acceptance also requires the **entire four-lane suite under sustained full CPU load
both before and after these fixes**, retaining both result sets. The before-fix loaded
run must come first using baseline `35a519de` in an isolated worktree (equivalent to
stashing and restoring the fixes), followed by the integrated after-fix loaded run,
with the current timeouts/assertions and supervised stress-process cleanup. The parent
owns that additional loaded run, the normal six-command gate and complete four-lane
cockpit suite after integration, plus independent governed review.

Historical parent results are retained against their tested revision:

- At `923becf3`, **all six normal commands passed**, including the complete four-lane
  suite: `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`,
  `npm run test:package`, `npm run test:e2e:local`, each exit 0. Evidence:
  `.ai/qa/issue-795/normal-gate/{status.json,*.log}`.
- The first AFTER-loaded run at that same revision **failed**: **610 passed, two rail
  failures, seven existing skips**, exit 1; CPU mean **100%**, minimum **99.89%**, **156**
  samples; all **24** burners cleaned (`loadWorkersRemaining=0`). Evidence:
  `.ai/qa/issue-795/loaded-fixed/{status.json,suite.log,cpu-load.ndjson}` and
  `.ai/qa/local-runs/1791015302559-2473880/`. The archived
  `.ai/qa/issue-795/loaded-fixed-attempt-1-evidence.zip` preserves this failing result.

These historical passes do not claim success for the later rail correction. The final
normal gate, loaded-after full-suite retry and independent review of the latest integrated
revision remain parent-owned and pending. No previous result was overwritten.

## Final normal attempt: thread restoration diagnosis

The parent normal gate at `42a76bec` (integrating worker `053b5791`) passed its first
five commands, including **531 unit files / 11,470 tests**, but the full four-lane
browser command **failed**: **611 passed, one thread-scroll restoration failure,
seven existing skips**, exit 1, completed **2026-10-03 09:05:42 UTC**. The loaded-after
watcher exited without starting CPU burners. This result is retained separately from
both the earlier normal pass and the failing loaded rail run. Parent evidence:
`.ai/qa/issue-795/final-normal-attempt-1-failures/` and
`.ai/qa/local-runs/1791017821817-2777308/`.

The actual parked capture has ten consecutive frames at `scrollTop=67430`,
`scrollHeight=135696`, `clientHeight=836`, with the jump pill visible. At the timeout,
the returned thread was at its tail: `scrollTop=50010`, `scrollHeight=50846`,
`clientHeight=836`, pill absent, fallback replay active and loading false. The saved
67430px offset was **17420px beyond the returned maximum of 50010px**. This is an
observed failure of the unchanged restoration expectation, not evidence that a
readiness wait should accept a different offset. Its **200px** tolerance and timeout
remain unchanged.

A bounded, read-only native trace compared the complete current thread-scroll file
with a variant reverting **only** the restoration block's maxTop measurement from
`waitForSettledSample` to baseline `browser.evaluate`. Both parked at the same
67430px offset and 135696px total height before and after that measurement. Both
returned with a freshly estimated virtualizer cache: 1253 rows, default size 40,
zero measured rows, total DOM height 50672px. Subsequent native measurements changed
the default estimate to 57.5 and increased the total height enough to restore the
saved pixel offset. Final heights differed (72633px current, 72849px baseline-block
variant), but both restored 67430px. Thus the estimate reset also occurred with the
baseline maxTop read; this comparison does **not** establish that #795 caused the
cache reset or provide a causal test-only fix for the full-suite timeout.

Source provenance: `routes/task-thread/thread-scroll.ts` accepts a stored measurement
cache only for an exact row-count match; `thread-scroller.tsx` reads it once when the
virtualized session mounts. `api/run-events.ts` and `api/run-history.ts` replay a fresh
SSE stream on return. These product files are unchanged from `35a519de`. Their mount
and replay interaction is a possible explanation for the missing stored cache,
not a proven root cause: frame snapshots can miss intermediate React commits. The
comparison isolates the maxTop conversion, **not** the entire original baseline
file. No product/cache patch or speculative readiness wait was added.

Worker evidence is preserved at `.ai/qa/issue-795/thread-restore-diagnosis/`, including
the copied parent failure bundles, both exact instrumented spec variants, the
baseline-block diff, both native traces and `comparison-summary.json`.

| Command / bounded comparison | Outcome | Evidence |
| --- | --- | --- |
| `npm ci` | exit 0 | `npm-ci.log` |
| Complete `npm run test:e2e -- thread-scroll.e2e.ts`, current `053b5791` behavior plus read-only native trace | exit 0; all 14 passed, 45.65s | `diagnostic-current.log`, `diagnostic-current.ts`, `native-restore-trace.json` (146 samples) |
| Same complete command, only restoration maxTop read reverted to baseline behavior plus the same trace | exit 0; all 14 passed, 45.38s | `diagnostic-baseline-block.log`, `diagnostic-baseline-block.ts`, `baseline-restoration-block.diff`, `native-restore-baseline-block.json` (135 samples) |

Neither focused run reproduced the timeout; they are diagnostic comparisons, not
red/green regression proof and not a claim that the restoration failure was eliminated.
All temporary instrumentation was removed and the committed thread-scroll spec
restored verbatim. Audit counts and readiness fixes are unchanged. The parent owns
one unchanged full normal retry and the subsequent full CPU-loaded acceptance run;
the failed attempt and this limitation must remain visible alongside those results.

## Repeated restoration failure: concurrent diagnosis and scope boundary

The parent unchanged full normal retry at `74495525` also failed the same restoration
wait for 67430px. Its first five commands passed; the browser result was **611 passed,
one restoration failure, seven existing skips**, completed **2026-10-03 09:35:46 UTC**.
No loaded-after burners were started. The second actual probe independently confirms
the target and timeout, but the retained second bundle does not contain a detailed
scroll-height capture: do not infer its final height from attempt 1. Parent evidence:
`.ai/qa/issue-795/final-normal-attempt-2-evidence.zip` and
`.ai/qa/local-runs/1791019627753-3022091/lane-4-failures/thread-scroll/`.

A stronger bounded comparison ran the actual four-lane allocator/sequencer. Its tracer
starts inside the **existing** wheel call, performs passive in-page frame observations,
and is retrieved **only after** the original restoration wait succeeds or times out.
There are no added browser CLI calls before park, departure or return. Observing frames
still adds work and may affect timing; these runs are not deterministic red/green proof.

In current `c91c6172` behavior, the departed virtualizer had 1253 rows, default estimate
110 and 53 measured entries; park was 67430px at height 135696px. On return, a native
frame shows a **456-row virtual mount**, default estimate **40**, zero measured entries
and no saved mount cache, height 18792px. Growing that same session to 1253 rows retained
a fresh cache. It later estimated 57.5, height 72621px, and reached 67430px. The first
rendered overscan key changed from `turn-seq-1234:item_msg_124` before departure to
`turn-seq-2324:toolu_233` after return. These are overscan-window observations, not exact
first-visible anchors, but they demonstrate that passing pixel arithmetic alone does
not establish the same reader content after re-estimation.

The comparison variant restored the **complete baseline `35a519de` thread-scroll spec
behavior**, with the same passive tracer; all other specs/product files remained at
current #795 input. It parked 35889px at height 72614px/default estimate 57.5. Return
showed 154 flat rows, then a 1253-row virtual session whose native mount state contained
the saved 1253-row cache/default 57.5/58 measured entries. It restored 35889px. This
pair observes different initial estimates and replay batch boundaries; it does not
isolate which #795 change, scheduling difference or other input caused those differences.
It is **not** a full baseline checkout acceptance run.

The native partial mount now demonstrates the source gap described above:
`thread-scroll.ts:124` rejects the incompatible count, `thread-scroller.tsx:570` reads
once at mount, and `:630` supplies that immutable cache value to the virtualizer.
Reaching the compatible full count later does not retry the saved snapshot. A rendering
wait cannot restore missing measurements or make an unreachable pixel offset valid.
The uninstrumented failed attempts do not capture their initial virtual mount, so this
is not a proven explanation for every recorded timeout.

Worker evidence: `.ai/qa/issue-795/thread-restore-context/`. Both exact instrumented
spec variants, baseline original, diff, native traces/summaries, all lane logs and every
failure bundle are retained. `before.ts` is the verbatim committed spec restored after
these two runs. No instrumentation or product changes remain.

| Command / bounded contextual comparison | Outcome | Evidence |
| --- | --- | --- |
| `npm ci` | exit 0 | `npm-ci.log` |
| `npm run test:e2e:local`, current behavior plus passive trace | exit 1; **609 passed, 3 selection-states failures, 7 existing skips**; all 14 thread-scroll tests passed | `passive-current-four-lane.log`, `passive-current-local-run/`, `passive-current-summary.json`; original local run `1791020432896-3110311` |
| Same complete four-lane command, complete baseline thread-scroll spec behavior plus the same trace | exit 1; **611 passed, 1 worker-conversation navigation failure, 7 existing skips**; lane 4 passed all 192 tests / 1 existing skip, including thread-scroll 14 and selection-states 27 | `passive-complete-baseline-four-lane.log`, `passive-complete-baseline-local-run/`, `passive-complete-baseline-summary.json`; original local run `1791021033493-3200243` |

The three current-run selection failures were settled-sample `wait-value` timeouts with
`lastValue: null`: sidebar row/title/pin geometry, the Skills nav-update marker sample,
and model-pill geometry, all desktop dark comfortable. Captures show complete pages,
1440×900 and no dialogs; they do not identify fonts, native rendering, finite animation
or another rejected guard. Their captures (09:44:11/09:44:37/09:45:03 UTC) precede the
2.59-second thread trace retrieved at 09:45:54 UTC, so that tracer was not running
during their waits. Overall concurrency/environment differences remain possible.
The baseline-context run did not reproduce them; an external native-wait observer
captured zero matching probes, so no null-guard cause was established or fixed.

The baseline-context failure was the worker-conversation clock test's **navigation**
at `worker-conversation.e2e.ts:109`, before clock readiness or geometry: agent-browser
`open` failed with `spawnSync ETIMEDOUT` after its existing 90-second command budget.
The failure capture has the intended flat-thread URL and a complete document. That
bundle does not prove why the CLI open failed; no budget or test change was made.

Independent read-only review recommends retaining the original run/view cache candidate
through the incompatible prefix, adopting it once at an exact compatible count while
the original arrival still owns restoration, and protecting it from detach overwrites.
This leaves #795's approved test-only surface. A bounded product design and regressions
are prepared in worker evidence `product-remedy-design.md`; **no implementation is
approved or made here**. Preserve exact-count compatibility, reader cancellation, tail
pinning, append/prepend behavior and the original 200px assertion. Do not substitute a
larger height wait, lower parked offset or atomic replay fixture. Parent owns the design
gate, subsequent red/green proof, independent review and final normal/full-load gates.
Audit inventories/counts remain unchanged; these failed runs are not acceptance passes.


## Approved compatible-cache correction — partial replay restoration

The human answered **Continue** to the parent’s bounded product design; parent request
`571cf980-8c01-4081-a8b0-2ee8663d71b0` explicitly records that approval. This supersedes
the preceding historical “no implementation approved” status. The design is retained at
worker `.ai/qa/issue-795/thread-restore-context/product-remedy-design.md`. The previous
failed full runs remain failed results; this correction does not retroactively turn them
into acceptance passes or establish that #795 caused the original cache lifecycle gap.

The old mechanism was load-bearing for exact item-count compatibility of virtua’s opaque
snapshot, independent run/view caches, away-from-tail restoration, live-tail following,
intent cancellation and preserving cached heights on append/prepend/eviction. A snapshot
accepted at the initial mount restored measured heights, but a snapshot rejected during
partial SSE replay was never reconsidered. Waiting until fresh estimates reach the old
pixel can show a different message, so a taller-layout wait would not preserve content.

The correction retains the original per-run/view candidate in the virtual-row session.
Saved snapshots now also carry copied ordered row identities; no opaque cache internals
are changed. A partial compatible prefix uses native estimates until the **exact original
count and ordered identities** return. Only the original away-from-tail arrival can then
consume its restoration ownership and remount the virtua child once with the saved native
cache. The route’s controls stay mounted and keep the original offset. Reader wheel,
touch, scroll keys, scrollbar pointer, Jump, correlated-row jump or history intent cancels
that ownership. Merely reaching the pixel through a fresh estimate does not cancel it.
An owned partial detach retains the original complete snapshot and scroll memory,
even if fresh estimates temporarily reach the saved pixel at their tail. Immediate
compatible arrivals release that postponed ownership, so normal native scroll corrections
continue to update memory; incompatible history,
append beyond the saved count or replacement abandons deferred adoption. Immediate
compatible caches, missing/other-view caches, live-tail following and ordinary repeated
commits/append/prepend/eviction retain their existing behavior. No timer, configuration,
dependency, persistent state or HTTP/wire shape is added.

Source provenance and affected sites:

- `src/routes/task-thread/thread-scroll.ts`: `ThreadMeasurements`,
  `saveThreadMeasurements`, `readThreadMeasurementCandidate`, `readThreadMeasurements`;
  retain the exact-count guard and add immutable identity compatibility.
- `src/routes/task-thread/thread-scroller.tsx`: `useThreadScroll` original arrival,
  intent cancellation and one-use measurement restoration ownership; `VirtualRowsSession`
  candidate capture, exact compatible-prefix adoption and protected detach. The supported
  `Virtualizer cache` mount prop performs one controlled child hydration.
- `src/routes/task-thread/thread-scroller.test.tsx`: real virtua public handles seed and
  verify cached item geometry, plus cancellation/identity/ownership and old-behavior guards.
  All 33 pre-existing tests remain alongside 26 new real-native-cache guard cases,
  including the reviewed reused-route departure correction below. `thread-scroll.test.ts` adds copied-key compatibility;
  the two pre-existing mocked-virtualizer route/shift tests remain.
- `thread-scroll.e2e.ts`: a **separate** replay run holds real ordered EventSource frames
  after sequence 642 (`turn_64`), while the original run/file stays unchanged. Release
  readiness requires a committed virtual prefix and stable native container extent,
  independent of the desired restore result. Before sampling a row, the browser checks
  `checkVisibility({contentVisibilityAuto:true})`. The new regression keeps the original
  `<200px` restoration coverage/budget and also asserts the same first visible row with
  `<2px` offset difference. The original restoration test/assertions are unchanged.
- `README.md`: explain compatible replay restoration and reader/history ownership.

Worker evidence: `.ai/qa/issue-795/cache-hydration/` (all logs and immutable failure/sample
copies retained; no CPU burners were launched during this worker phase).

| Command / proof | Outcome | Evidence |
| --- | --- | --- |
| `npm ci` in this worktree | exit 0 before component/browser tests | `npm-ci.log` |
| `npm test -- thread-scroller.test.tsx`, new real-virtua regression before product edits | exit 1; one regression failed / 33 existing tests passed, cached item 123 expected 180px but native fresh estimate was 40px | `component-native-red.log` |
| `npm run test:e2e -- thread-scroll.e2e.ts -t 'same reader row'`, before product edits | exit 1; original pixel restoration timed out: saved 53818px was above returned max 50010px; 14 tests filtered, not skips added | `browser-red.log`, `browser-red-artifacts/`, `browser-red-failures/` |
| First expanded guard matrix | exit 1; partial owned detach overwrote the complete candidate (native item 40px versus saved 180px), 51 other tests passed; then fixed | `guard-matrix-first.log` |
| Earlier-revision behavior-only rollback, **before the final two memory guards and navigation correction**: omit only `setHydration`, retaining then-current APIs, metadata and ownership guards; `npm test -- thread-scroll thread-scroller` | exit 1; 3 regressions failed / 75 guards passed | `thread-scroller-behavior-rollback.tsx`, `behavior-rollback-units.log` |
| Same **earlier-revision** behavior-only rollback; selected held-replay browser regression with `--force-rebuild` | exit 1; pixel coverage passed but visible row changed from `turn-seq-1864:user` to `turn-seq-2384:item_msg_239`; 14 tests filtered | `behavior-rollback-browser.log`, `behavior-rollback-artifacts/` |
| Initial restored fix; `npm test -- thread-scroll thread-scroller session-transcript visual-ready transcript-measurements session-layout agent-browser-wait-value e2e-wait-discipline project-rail-ready` | exit 0; all 180 tests / 10 files passed, 8.34s | `units-final-green.log` |
| Final guard expansion, same relevant unit command | exit 0; all 182 tests / 10 files passed, 8.20s | `units-final-ownership-green.log` |
| Fresh prefix reaches saved pixel then leaves; new memory guard before its fix | exit 1; one regression failed / 54 tests passed: saved memory incorrectly changed to atBottom true without intent | `owned-scroll-memory-red.log` |
| Immediate compatible arrival, normal native pixel correction; first memory guard before narrowing | exit 1; one regression failed / 55 tests passed: normal 9600px correction was incorrectly suppressed to 9000px | `immediate-memory-guard-red.log` |
| `npm run typecheck:web`, final ownership guards | exit 0, including required service prebuild | `typecheck-final-ownership.log` |
| First complete cache fix, `npm run test:e2e -- thread-scroll.e2e.ts --force-rebuild` | exit 0; all 15 tests passed, 53.46s; no test filter/skips. Saved/restored `turn-seq-1854:turn-time`, offset exactly -0.3125px both times | `browser-file-final-green.log`, `browser-final-artifacts/` |
| `npm run test:e2e -- --shard=4/4`, same cache-fix build before the final two memory guards | exit 0; all 16 files / 193 tests passed, 1 existing skip, 410.82s. This is one shard context, not concurrent four-lane acceptance | `browser-shard4-context.log` |
| Final ownership guards, `npm run test:e2e -- thread-scroll.e2e.ts --force-rebuild` | exit 0; all 15 tests passed, 54.08s, no filters/skips. Saved/restored `turn-seq-1864:user` at exactly -73.109375px both times | `browser-final-ownership-green.log`, `browser-final-ownership-artifacts/` |

The initial pre-fix held prefix had **zero rendered row children**: its native container
extent was observed, not native row measurement readiness. The rollback prefix had nine
mounted rows. Neither proof claims skipped/unmounted rows were measured. Both actual
result sets and geometry/anchor samples are retained without substituting another fixture
or relaxing coverage. The original full-loaded baseline (612 passed), failed loaded-after
rail attempt (610 passed / 2 failed), both normal restoration failures (611 passed / 1 failed)
and diagnostic contextual results above remain historical input-revision evidence.

Parent follow-up found the selection-state null guard held while the FontFaceSet reported
`loading`; its root cause is still unproven. Later focused font follow-up passed 10 tests
with 17 filtered. This does not erase the earlier three failures; no font readiness guard,
assertion or timeout was changed here. Parent retains its native font evidence, owns
independent review, and will run the complete six-command gate and another complete
24-core loaded suite after integration. The worker focused passes are not full-suite
acceptance claims.


## Independent review correction — reused-route partial departure

Independent review of immutable `fa5b32d71698f47f6883780575cb61ff46e010c2` requested
changes for one cache ownership blocker. Production reuses `useThreadScroll` on task
navigation (`task-thread.tsx:303`, `session-transcript.tsx:267`). In partial A → B → full A,
`viewKeyRef.current` already held destination B during the old A native ref detach.
`ownsMeasurementRestore(A)` therefore returned false, overwriting A’s complete 400-row
cache with a 350-row estimate. The real virtua reviewer proof observed saved count 350
and returned item 123 at 40px instead of 180px. Reviewer evidence is retained under
sibling `.ai/qa/issue-795-review/{cache-hydration-review.md,cache-navigation-proof.test.tsx,
cache-navigation-proof.log}` and copied into worker evidence below.

The bounded correction distinguishes the departing **committed arrival owner** from
eligibility to **adopt into the active view**. `ownsMeasurementRestore` checks the saved
owner key for detach retention; `restoreMeasurements` additionally checks the current
view key before consuming that owner. Destination render cannot destroy A’s candidate,
and a stale A cannot adopt into B. No broader restoration/geometry, font, threshold,
timeout or hold change is made. The new same-hook native regression seeds independent
A=180px and B=260px caches, visits both partial views, then returns to each complete view.
Wheel and Jump cancellation before departure still save the new estimate normally.

Worker evidence root: `.ai/qa/issue-795/cache-navigation-review/`. The previous rollback
artifacts above are explicitly historical: they preceded the final two memory guards.
The regenerated rollback below starts from the **final navigation-corrected source and
final component tests**, retaining candidate-gated owner creation, original scroll-memory
protection, immediate/incompatible ownership release, and the navigation correction.
`diff -u final-fixed-thread-scroller.tsx final-adoption-only-rollback.tsx` shows exactly one
behavior change: removing `setHydration({cache:candidate.cache,generation:1})`. Fixed
source and final test snapshots are retained, together with `final-fixed.patch` against
`fa5b32d7`. No earlier proof is relabelled as final proof.

| Command / proof | Outcome | Evidence |
| --- | --- | --- |
| `npm ci` in this worktree | exit 0 before review regression tests | `npm-ci.log` |
| New same-hook A/B roundtrip regression, `npm test -- thread-scroller.test.tsx`, before ownership correction | exit 1; one regression failed / 58 tests passed, returned native item 40px versus saved 180px; strengthened independent A/B cache version also red | `navigation-before-fix-red.log`, `navigation-two-candidates-before-fix-red.log` |
| Paired ownership correction, `npm test -- thread-scroll thread-scroller` | exit 0; all 83 tests / 3 files passed, 1.67s | `navigation-green.log` |
| Exact-final adoption-only rollback, same unit command | exit 1; three regressions failed / 80 guards passed, 1.44s; final memory/navigation APIs and guards remain | `final-adoption-only-rollback-units.log`, `final-adoption-only-rollback.tsx` |
| Exact-final adoption-only rollback, `npm run test:e2e -- thread-scroll.e2e.ts -t 'same reader row' --force-rebuild` | exit 1; original 25s / <200px waiter timed out, saved 53818px versus actual top/max 50010px (height 50846, viewport 836); one failed / 14 filtered, 35.53s | `final-adoption-only-rollback-browser.log`, `exact-final-rollback-artifacts/` |
| Restored final fixed source, `npm test -- thread-scroll thread-scroller session-transcript visual-ready transcript-measurements session-layout agent-browser-wait-value e2e-wait-discipline project-rail-ready` | exit 0; all 185 tests / 10 files passed, 8.29s | `final-green-units.log` |
| `npm run typecheck:web` | exit 0, including service prebuild | `final-green-typecheck.log` |
| Restored final fixed source, `npm run test:e2e -- thread-scroll.e2e.ts --force-rebuild` | exit 0; all 15 tests passed, 50.42s, no filters/skips; same visible row and viewport offset preserved | `final-green-browser.log`, `final-green-artifacts/` |

The exact-final rollback prefix again had **zero mounted row children** and observed
native container extent 12880px, not rendered row geometry. Source restoration is
byte-identical to `final-fixed-thread-scroller.tsx`. All earlier full normal/loaded failures
and passes remain attached to their actual input revisions; parent owns independent
re-review and the final full normal / full CPU-load gates after collecting this correction.
The 63-spec / 16-helper audit and 212 actual accepted-sample call inventory are unchanged.


## Loaded settings theme follow-up — qualified evidence, cause still bounded

Parent runtime `190ceb02` (identical to worker `b9e993c2`) passed the complete normal
six-command gate, including **613 browser passes / seven existing skips**. Its subsequent
full 24-core loaded suite recorded **612 passes / one settings-appearance theme failure /
seven existing skips**, mean CPU 100%, minimum 99.95%, all burners cleaned. The original
Light/Dark theme block at `settings-appearance.e2e.ts:70-82` was unchanged from
`35a519de` at that failing input; initial #795 conversions affected only later density measurements.

Actual parent capture shows root Light, Light checked and active, document complete,
no dialogs after the original Dark click. It has no trusted pointer history. Worker
evidence is retained under `.ai/qa/issue-795/settings-theme-loaded/`, including copied
actual parent failure/logs, three fresh diagnostic variant directories, setup comparison,
raw qualified native trace and `diagnosis.md`. Complete four-test loaded diagnostics all
passed: first 12.93s (CPU mean 99.984/min 99.854%,9 samples), second 12.62s
(mean 99.977/min 99.813%,8 samples), qualified third 5.45s
(mean 99.988/min 99.792%,17 samples). Each cleaned all 24 default-priority pinned burners.
The first two reload traces were absent: detached preload session, then missing Page.enable.
They are setup failures, not evidence that no pointer events or movement occurred.

A nonloaded setup comparison proves Page.enable is required for preload survival. The
third capture holds that session through navigation and compares native/CDP URL, time
origin and first trace entry to qualify the actual active page. Its original action sequence
is preserved; diagnostic geometry observations themselves may affect timing. The trace
shows document-complete/root-Light/checked-Light/native-rendered controls at 236.5ms,
fonts loaded at 267.9ms, then a **60px rightward geometry change at 301.7ms**. Dark's old
center 515.34375 lies inside Light's later 468.921875..533.578125 box. Semantic state and
visibility therefore precede stable action geometry. The trusted Dark click at 369.7-375.2ms
uses the new center and succeeds. This is evidence of a readiness gap, **not proof that
the original failure was a wrong hit**, nor proof of the source of the shift.

Parent reply `f12ebd26-4ac1-4420-8e56-b7b239d32362` authorizes a controlled native
render-phase regression for this observed readiness class while retaining the causal limit.
`fixtures/theme-layout-proof.ts` owns a blank document with semantic-Light/checked-Light/
complete/native-visible controls at the observed initial sizes. Its next native animation
frame commits the measured 60px shift; it adds no timer or pointer-triggered mutation.
The first-truth variant accepts x 483.578125 while committed x 543.578125 differs and fails
its geometry assertion. Existing `settleVisual` returns a held actual signature matching
the committed sample and passes. **The same native selector Dark click succeeds in both
variants**; this is a geometry-readiness proof, not reproduction of the original wrong hit.

The smallest spec correction adds existing `settleVisual(browser, darkSelector)` at current 83
before the same original Dark click at 84. It uses the unchanged 200ms target geometry
hold, native checks, fonts and finite-animation readiness; no appearance expectation
matcher is supplied. All original theme/density assertions, actions, timeout budgets, shared
helpers, product and font behavior remain unchanged. Diagnostic instrumentation is restored.
Inventory is 63  specs / 16 shared-setup files plus 1 native proof driver / 212 accepted-sample
calls; the original 462 baseline calls, 45 affected spec rows and 18 NONE rows are unchanged.
The failed parent loaded result is retained and is not converted into acceptance by focused
passing diagnostics. Parent owns final acceptance.

| Command / proof | Outcome | Evidence under settings-theme-loaded/ |
| --- | --- | --- |
| `node --import tsx packages/web/e2e/fixtures/theme-layout-proof.ts --first-truth`, before adding the local wait | exit 1, accepted geometry x 483.578125 differs from committed 543.578125; native selector action succeeds | `native-geometry-first-truth-red.log` |
| Same native proof without `--first-truth`, existing target settle | exit 0, actual held geometry equals committed signature; selector action succeeds | `native-geometry-settled-green.log` |
| `npm test -- visual-ready e2e-wait-discipline agent-browser-interact` | exit 0, 49 tests/3 files, 1.25s; unchanged ratchet baseline | `units-green.log` |
| `npm run typecheck:web` | exit 0 including service prebuild; fixture driver included | `typecheck-green.log` |
| `python3 .ai/qa/issue-795/settings-theme-loaded/run-loaded.py fixed-final-loaded npm run test:e2e -- settings-appearance.e2e.ts` | exit 0, all 4 original tests passed 13.10s; CPU mean 99.993%/min 99.854%,21 samples, all 24 burners cleaned 0 | `fixed-final-loaded/{suite.log,status.json,cpu-load.ndjson}` |

`tested-inputs.json` identifies the tested base plus SHA256/snapshots of the final local
spec correction, unchanged shared readiness and native proof driver. Only documentation
changes follow the runtime verification. This targeted loaded pass is not a full loaded
acceptance result and does not erase the original parent failure.
