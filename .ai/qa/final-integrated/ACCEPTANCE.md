# Issue224 / PR235 — integrated verification

**Final verification passes.** All five repository gates are green, and the complete browser suite passes373 tests with6 existing skips across43files. Source correction commit:c74141b3; test-only commit:204b78b1. Final29-file snapshot and command exits are recorded in `final-serial-manifest.json` and `final-serial-complete.json`.

## Implementation and regression checks

Already reported source commits:8ec8fdbc fixes the offline Tasks registry retry loop and Automation editor overflow;237df6c9 updates the action guardian and grouped diff-number expectation;463f7caa keeps New Task switch thumbs white and View YAML’s actual target44px at every density.

Source commit c74141b3 embeds Plan22 review in the New Task page canvas, retains the hidden draft, moves focus into review and restores it on Escape/discard. Nested Save/Overwrite dialogs keep their own Escape behavior. GitHub now has a separate amber bypass warning, orange conflict heading and vertically stacked mobile Labels/Assignees. Readiness, exact-head merge payloads, permissions, workflow/provider selection and all existing actions remain.

The new Plan regression failed against the old overlay (`plan-inline-red.log`). New Task/GitHub270unit cases, nested Escape, Plan/GitHub38browser cases and AgentsDock4browser cases pass. The dock fixture now sends actual upward mouse-wheel input before scrolling to and hit-testing the control. The earlier keyboard/scrollTop0 setup was unreliable; geometry showed a visible control at the short page tail, and programmatic scrolling alone could still click the wrong agent. Three fresh4-case dock runs pass with wheel intent (browser-dock-wheel.log). GitHub32 passes after waiting for the actual tab link, rather than only the earlier-mounted header. No dock product behavior was changed. New Task backdrop and picker failures have independent causes: the confirmed design removed the decorative twinkle surface, so the test checks the visible composer and retained autofocus; the multi-select Skills picker stays open during selection, so the submit case dismisses it with Escape before typing. Neither is justified by the separate execution-control scrolling proof.

## Full verification

The final sequence ran without overlap: `npm run typecheck`; `npm test -- --maxWorkers=4` (386files/8,011tests); `npm run test:unit` (261tests); `npm run build`; `npm run test:package` (27tests); then `npm test -- --config packages/web/e2e/vitest.config.ts` (43files/373passed/6existing skipped). Every command exited0. Logs are `final-serial-*.log`; the29file hashes remain unchanged. The served index and86JS/CSS/font hashes match the inspected build; Poppins, JetBrains Mono and IBM Plex Mono load in the actual browser.

The normal test:e2e doctor skipped because its container sandbox/CDN checks failed; that is not counted as a browser pass. Actual installed Chromium drove the real built application through the explicit `--no-sandbox` wrapper. Final test children exclude inherited CEZ metadata and receive isolated CEZ_HOME/TMPDIR; the governed controller environment is unchanged. `mock-write-scope.json` reports the earlier outside-fixture handoff mutation and exact-line cleanup, without claiming an unavailable historical write audit.

Historical full-suite failures and interrupted runs remain in the evidence. They are superseded by the final complete run, not erased or promoted from isolated reruns. `browser-root-causes.md` accounts for the historical102failure checkpoint. No source or behavioral assertions were changed during the final frozen run.

## Design inventory and scope

Confirmed cezarion.pen SHA256:56a71a27c7795137cab1c0a40a5839edecbacab4014d2d39ddc90f89343275f8. The ledger has193unique frames:157owned,36shared/Skills delegated.152owned paired route captures were independently inspected; four composite boards have separate specimen evidence and one board is design instructions. `ledger-proof.json` checks paths/hashes/inventory, not pixel parity.

Historical owner baselines remain explicitly rejected. Capture source qualifications distinguish actual audit snapshots; affected Settings52, NewTask/Session/Git22, GitHub width6 and final Plan4/filter/merge captures were refreshed after relevant changes. `variant-state-map.json` maps incompatible compositions to actual states: New Task follows23, workspace All Tasks follows26, GitHub lists follow9 and selected PRs follow27. Legacy1/5 are not simultaneously claimed pixel-matched.29/33 are specimen boards, not simultaneous runtime screens. Dedicated Inbox empty19B follows its full page layout; frame33’s compact Inbox specimen is not claimed simultaneously matched. Latest settled owner inputs are pinned in latest-owner-evidence-inputs.json and do not replace the independent captures.

## Per-view findings

| View | Actual checks and qualification |
|---|---|
| New Task | Both themes/widths; white thumbs, starters, switches, provider controls, submission and preserved draft.23is the implemented expanded composition; retained mobile content puts the CTA below legacy1’s first viewport. |
| Session | Activity/tool expansion, tabs, drawer, workers, follow-tail and continuation controls. Real workflow/progress/resource metadata changes height; no invented historical runner or handoff timestamp. |
| Project/All Tasks | Resource-column disclosure, two-line names, actions, pins, grouping, filters and independent sidebar scope. Workspace26 and legacy5 remain distinct source variants. |
| Inbox/Automations | Populated, empty/off, instruction/editor and activity specimens. Overflow corrected. Optional responses are disclosed contract fixtures; no optional agent launch. |
| Plan | Four source pairs now show embedded desktop canvas/mobile card. Twelve empty/fallback/discard specimens inspected; empty Start disabled, fallback explicit, discard returns unchanged draft/focus. Save/Overwrite/reorder/start tests pass. Three fixture steps versus four reference steps is data. |
| Variants | Results, waiting/error and cancelled pick confirmation, both themes. Actual metrics/status/diffs retained. |
| Git and task changes/files | Changes/commits/branches, mobile tree/diff and real file reads. Source16 empty selection plus four selected src/session.ts specimens inspected; source16 does not draw selected-file content. Native Open file by path remains available. |
| GitHub | Issue/PR conversation and changes; ready/unknown and twelve blocked/bypass/conflict specimens across widths/themes; six280/360/520list-width captures. Corrected mobile issue URL and stacked filters. Bypass and conflict colors now match their source distinction. No merge POST. |
| Tools | Tools menu, diagnostics, versions and capability states in both themes; source-defined surfaces inspected. Actual missing remote/dependencies remain honestly unavailable. |
| Settings | All13sections ×2widths ×2themes,52pairs. Real MCP Reset/Save/original-byte restoration checked. `settings-retained-coverage.json` traces auth, privacy, hosted read-only, scope and persistence guards. No active authentication fabricated. |

## Remaining legitimate differences

Real issue/PR text, authors, counts, timestamps, SHA, branch, runner/model/account/workflow values and versions replace samples. Extra refresh/search, privacy/scope/help, resource and worker controls remain. Global Changes has no API diffStat; PR assignee/board metadata is issue-only; historical per-turn runner/handoff timestamps are absent. These values were not fabricated. Selection borders/fills were checked against exact source nodes: mobile model has no stroke, desktop subtle borders measure1.26/1.39:1, and mobile Skills rows have uniform fills. Tests instead retain text/icon contrast, focus, native disabled and actual selection behavior.

No known categoryA mismatch remains in the reviewed owned states. The parent retains shared/Skills review and integration approval. Detailed intermediate diagnoses remain in WORKER-STATUS and historical command logs.
