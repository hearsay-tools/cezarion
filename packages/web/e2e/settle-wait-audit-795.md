# Cockpit rendered / settled sampling audit — #795

Audited baseline: `35a519de` (includes #758, `35a519de`, and #794, `af1383f9`).
Scope: every one of the **63** current `*.e2e.ts` specs. The original audit covers
**13** helper/setup files (11 direct TypeScript files plus `fetch-setup.mjs` and
`fixtures/make-large-thread.ts`); review round 1 adds `transcript-measurements.ts` and
`session-layout.ts`, bringing the current helper/setup inventory to **15**.
No product, dependency, assertion tolerance, skip or fixture baseline changes.

## Diagnosis and provenance

- **R — rendered before geometry.** #758's observed −847px code-line gap came from
  skipped `content-visibility:auto` layout. A box read can itself materialize skipped
  content and corrupt the following readiness check. `visualSampleExpression` now checks
  native `checkVisibility({ contentVisibilityAuto: true })` before the target box and
  before every descendant/ancestor box. Skipped descendants remain outside the readiness
  signature; measured transcript targets independently scroll and wait for native rendering.
  Product provenance: `thread-scroller.tsx:519`, `commit-list.tsx:117`,
  `diff-view.tsx:189,471`. These are read-only source references, not changed files.
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
round 1 there are **209 actual calls**, excluding declarations; current locations follow.

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
| [project-rail.e2e.ts](project-rail.e2e.ts) | 11: 209, 210, 212, 216, 226, 278, 283, 317, 329, 350, 386 | 209, 210, 212, 226, 278, 283, 386. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 107, 132, 133, 134, 153, 157, 174, 175, 183, 196, 201, 216, 267, 283, 292, 317, 329, 361, 362, 367, 382, 386 |
| [queued-stack.e2e.ts](queued-stack.e2e.ts) | 0: NONE | NONE. K: existing waits / direct data, focus or visibility checks retained. | 114, 143, 164, 172, 177, 201, 213 |
| [quick-list.e2e.ts](quick-list.e2e.ts) | 50: 248, 255, 366, 370, 372, 378, 394, 398, 406, 409, 478, 486, 598, 654, 657, 660, 670, 722, 732, 734, 836, 843, 889, 940, 1087, 1093, 1117, 1132, 1168, 1181, 1200, 1303, 1373, 1434, 1444, 1451, 1507, 1526, 1539, 1557, 1574, 1585, 1648, 1657, 1812, 1817, 1820, 1869, 2006, 2011 | 366, 370, 372, 378, 732, 734, 889, 940, 1093, 1117, 1132, 1168, 1181, 1200, 1303, 1373, 1451, 1526, 1539, 1557, 1574, 1585, 1648, 1869. #617/#621/#166 group expansion, density, width contention and ResizeObserver token/cost decisions: observe stable boxes; preserve 47px, 44px, pixel and token/cost expectations. Swipe fixture retains real finite-animation completion. | 219, 244, 265, 275, 339, 352, 366, 370, 372, 378, 406, 409, 428, 436, 437, 447, 448, 453, 461, 481, 485, 486, 496, 517, 537, 606, 609, 627, 629, 634, 637, 642, 659, 688, 698, 718, 838, 842, 843, 863, 877, 889, 935, 1083, 1087, 1123, 1126, 1130, 1181, 1188, 1195, 1276, 1365, 1398, 1408, 1434, 1440, 1446, 1499, 1507, 1526, 1539, 1557, 1574, 1577, 1585, 1601, 1631, 1646, 1653, 1657, 1660, 1666, 1738, 1751, 1753, 1764, 1766, 1769, 1777, 1779, 1787, 1788, 1794, 1799, 1800, 1802, 1811, 1820, 1869, 1910, 1923, 1931, 1932, 1935, 1944, 1945, 1948, 1963, 1970, 2001, 2003, 2006, 2014, 2024, 2026 |
| [repo-git-diff.e2e.ts](repo-git-diff.e2e.ts) | 0: NONE | NONE. K: existing waits / direct data, focus or visibility checks retained. | 150, 194 |
| [repo-git.e2e.ts](repo-git.e2e.ts) | 2: 179, 197 | 179, 197. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 65, 73, 88, 117, 120, 142, 148, 171, 174, 184 |
| [review-gate.e2e.ts](review-gate.e2e.ts) | 5: 116, 118, 119, 129, 175 | NONE. K: existing waits / direct data, focus or visibility checks retained. | 91, 107, 128, 142, 148, 157, 158, 181, 185, 186 |
| [run-header-ci-wait.e2e.ts](run-header-ci-wait.e2e.ts) | 6: 86, 87, 99, 101, 102, 136 | 87, 101, 136. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 70, 86, 98, 99, 113, 116, 124, 134 |
| [selection-states.e2e.ts](selection-states.e2e.ts) | 36: 100, 107, 109, 144, 146, 149, 214, 230, 239, 245, 258, 263, 276, 289, 316, 338, 370, 375, 401, 405, 410, 415, 419, 438, 445, 460, 470, 476, 488, 492, 498, 505, 509, 538, 540, 546 | 214, 230, 239, 245, 263, 276, 289, 370, 375, 401, 460, 509. #369/#617 hover and selected state: expected fill and pin opacity moved to assertions; geometry, focus and finite animation completion determine readiness. Contrast thresholds and focus-visible assertions retained. | 106, 136, 144, 146, 194, 214, 221, 230, 239, 245, 251, 258, 263, 274, 276, 289, 298, 307, 313, 316, 319, 329, 334, 341, 343, 352, 370, 372, 375, 436, 438, 442, 443, 447, 455, 479, 495, 503, 534, 538, 540, 546 |
| [settings-agent-config.e2e.ts](settings-agent-config.e2e.ts) | 3: 52, 56, 99 | 52. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 48, 69, 98 |
| [settings-agents.e2e.ts](settings-agents.e2e.ts) | 0: NONE | NONE. K: existing waits / direct data, focus or visibility checks retained. | 81, 87, 100, 106, 117, 118 |
| [settings-appearance.e2e.ts](settings-appearance.e2e.ts) | 2: 116, 121 | 116, 121. S: raw / first-value geometry after route, viewport, theme, density or disclosure now returns the held measurement. Existing assertions remain unchanged. | 52, 72, 76, 81, 93, 108, 120, 129 |
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
| [thread-scroll.e2e.ts](thread-scroll.e2e.ts) | 16: 79, 132, 144, 252, 260, 271, 299, 301, 322, 324, 347, 384, 425, 439, 456, 472 | 79, 271, 299, 301, 384, 425, 472. R/S: review round 1 fixes assistant width to choose an already-rendered assistant at the live tail, without scrolling the reader. Other held measurements retain assertions. | 92, 108, 125, 126, 227, 235, 243, 248, 249, 252, 268, 276, 280, 283, 299, 322, 420, 452, 457, 458 |
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
- `project-rail.e2e.ts`: 210, 211, 213, 227, 279, 284, 387.
- `quick-list.e2e.ts`: 367, 371, 373, 379, 733, 735, 890, 941, 1094, 1118, 1133, 1169, 1182, 1201, 1304, 1374, 1452, 1561, 1578, 1589, 1652, 1873.
- `repo-git.e2e.ts`: 180, 198.
- `row-height.ts`: 62.
- `run-header-ci-wait.e2e.ts`: 88, 102, 137.
- `selection-states.e2e.ts`: 215, 231, 241, 248, 267, 281, 295, 376, 382, 409, 468, 517.
- `settings-agent-config.e2e.ts`: 53.
- `settings-appearance.e2e.ts`: 117, 122.
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
- `thread-scroll.e2e.ts`: 81, 273, 302, 385, 426, 473.
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

## Loaded suites and parent acceptance

The **BEFORE-fix full four-lane loaded suite PASSED** at baseline `35a519de`, before
integration, as reported by the parent: all four lanes green; CPU mean **100%**, minimum
**99.97%**, **156** utilization samples, **24** pinned default-priority CPU burners
cleaned up. Both result sets are to be retained. Parent evidence:
`.ai/qa/issue-795/loaded-baseline` and `.ai/qa/local-runs/1791011166587-1662221`.

Acceptance also requires the **entire four-lane suite under sustained full CPU load
both before and after these fixes**, retaining both result sets. The before-fix loaded
run must come first using baseline `35a519de` in an isolated worktree (equivalent to
stashing and restoring the fixes), followed by the integrated after-fix loaded run,
with the current timeouts/assertions and supervised stress-process cleanup. The parent
owns that additional loaded run, the normal six-command gate and complete four-lane
cockpit suite after integration, plus independent governed review. The before-fix
result is preserved above; the full normal gate, loaded-after result and
independent review remain parent-owned and pending. These focused results are not a
full-gate claim.
