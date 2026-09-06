# Phone task reading — issue #92

Base: `29db8cb8` (fresh fork main, including PDF/TXT/MD attachments). Port order: upstream `2c5522a8`, then `1a2b8882`. Parent approved the concrete design on 2026-09-06. No new artwork is needed for these existing surfaces.

## Acceptance results

| Criterion | Result | Evidence |
| --- | --- | --- |
| 360×640 visible, scrollable transcript; no horizontal overflow | Pass | Browser checks a scrollable main region and at least 120px between header and dock, even with a selected multiline draft and three document chips. Long workflow, branch and model cases also fit the scroller. |
| Expand without losing draft, selection or actions | Pass | Same textarea node, text and range `[2,8]` survive keyboard expand/collapse. PDF/TXT/MD chips remain mounted. Attach and Continue stay available; run actions remain outside metadata. Manual effort selection `high → low` survives collapse/expand and desktop resize. |
| Independent per-run disclosure memory | Pass | Component rerender covers run A/B/A and project A/B/A with identical run ids. Browser uses all four task tabs and the real phone drawer to switch runs and return. |
| Effort, account, model, monitoring; desktop context | Pass | Existing header/continuation tests retained. Browser opens the agent badge and reads account and effort. Monitoring schedule is outside the disclosure. At 1440×900 metadata and engine controls are visible with a sticky header, including after a phone resize. |
| Keyboard, expanded state, 44px targets | Pass | Native Enter/Space toggle disclosure, `aria-controls` links mounted content and `aria-expanded` follows state. Browser measures composer/detail/action controls and engine buttons at ≥44px on phones. Workflow and plan controls also have a 44px phone minimum. |
| Themes and reduced motion | Pass | Inspected light/dark phone captures and desktop layout. Critical title, transcript, draft and action text remain readable. Browser emulates reduced motion, verifies no chevron transition, and activates the disclosure. |
| Component and mobile end-to-end tests | Pass | 6,703 unit/component tests, 22 task-thread browser tests and 19 other relevant browser tests pass. New disclosure tests fail against the original source. |

## QA observations

- Phone input stays 16px to avoid focus zoom. Compact text remains editable and internally scrollable; expanding restores autosize. Labels, autocomplete suppression, document intake and submission paths are preserved.
- Short and long names, Session/Changes/Commits/Files, plan/no-plan, expanded/compact composer and phone→desktop→phone were exercised. Long model labels now truncate inside the pill; full string labels retain a title, and the badge popup wraps within the viewport.
- Initial loading and missing-run states retain the shell/navigation and existing recovery actions. Provider-blocked threads retain their Configure providers link because their composer does not collapse. Existing send-error restoration, waiting/queued/failed states and monitoring tests pass.
- Screenshot inspection caught overlapping long picker text and a clipped badge popup that page-width assertions alone missed; regressions now assert pill content height and popup bounds.
- Browser artifacts remain local under `.ai/qa/artifacts_e2e/`: `phone-reading-light.png`, `phone-long-details-dark.png`, `thread-mobile.png`, and `thread-header-mobile.png`. Manual desktop capture: `/tmp/cez92-desktop-final.png`.
- Browser QA uses cached Chrome through agent-browser 0.36.0. This container requires `TMPDIR=/tmp AGENT_BROWSER_ARGS=--no-sandbox`; a real local launch was verified despite the provider doctor's unrelated CDN probe failing. No app configuration changed for this workaround.

## Verification

- `npm run typecheck` — pass.
- `npm test` — 339 files, 6,703 tests pass.
- `npm run test:unit` — pass.
- `npm run build` — pass; `check:pack` verifies the packaged cockpit.
- `npm_config_prefer_offline=true npm_config_fetch_retries=0 npm run test:package` — 22 pass. Default retry settings initially exceeded test timeouts on npm network operations; no test timeout or assertion was weakened.
- `TMPDIR=/tmp AGENT_BROWSER_ARGS=--no-sandbox npx vitest run --config packages/web/e2e/vitest.config.ts task-thread.e2e.ts` — 22 pass.
- The same browser runner for `composer.e2e.ts composer-defaults.e2e.ts task-files.e2e.ts task-changes.e2e.ts` — 19 pass.
- Source-only stash regression check — nine disclosure failures and 139 passing guard tests against baseline; source restored and green verified.
- Independent read-only code review — no blocking findings; readonly label title suggestion applied.

## Existing broader-suite failures

An additional exploratory run of `thread-scroll.e2e.ts` has the same three failures against both baseline and this patch: flat mode expects 1,003 rows but paginated history initially loads 101; auto virtualization is expected before enough history is loaded; and an exact-bottom wait times out. The other three tests pass. Source was stashed, the baseline cockpit rebuilt, and the suite rerun to confirm this. Production history behavior and the suite's thresholds are unchanged; these results are not counted as passing verification. No issue #92 acceptance criterion is deferred.
