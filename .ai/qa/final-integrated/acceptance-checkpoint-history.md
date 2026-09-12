# Integrated acceptance audit — issue224 / PR235

**Repository gates pass at the recorded checkpoint. Whole-product design/browser acceptance is withheld.**

Final parent bundle through local `e730bd7f` includes all twelve Session/Settings/shared source corrections. Owned fixes `8ec8fdbc` and unit expectations `237df6c9` were already integrated by the parent. Two subsequently authorized corrections (white New Task switch thumbs, density-independent44px View YAML) are undergoing another stable full gate run. No push, PR, merge or delegation.

## Repository validation

Checkpoint `e730bd7f`: all five commands passed in order: `npm run typecheck`, `npm test -- --maxWorkers=4` (**386files /8,010tests**), `npm run test:unit`, `npm run build`, `npm run test:package`. See `final-bundle-gate-results.json` and `final-bundle-*.log`. Environment isolated CEZ_HOME, TMPDIR=/tmp, inherited CEZ_AUTOMATIONS/CEZ_FOLLOWUPS unset. These are full-suite results, not isolated reruns. New corrections have separate `final-corrections-*` logs and must not inherit this checkpoint's pass.

## Evidence integrity

The confirmed design hash is `56a71a27c7795137cab1c0a40a5839edecbacab4014d2d39ddc90f89343275f8`. Ledger checks193uniqueframes,157owned,36delegatedshared/Skills. All152current captured pairs were independently inspected in bounded groups;5owned composite/state boards have no single equivalent final capture. **152inspected is not193accepted.** Historical owner/parent baselines are explicitly rejected as final evidence.

`coverage-193.json` records each reference, browser path/hash, scope, inspection and outstanding state qualification. `ledger-proof.json` verifies inventory/hash integrity only. `final-settings/pairs.json` provides52final Settings captures at e730bd7f with served-index provenance. Twenty-two affected NewTask/Session/Git-subview captures were refreshed and reinspected after that bundle. All86served JS/CSS/WOFF2 assets match disk in `server-proof-final-bundle.json`; Poppins and JetBrains loaded in actual browser. Source fixes after this proof require new affected captures/proof.

## Regressions fixed

- Offline `/p/default` could remain at scope-resolving indefinitely: the newly mounted Tasks child retried the failed registry query, causing its scope gate to unmount/remount it. Disable retryOnMount only for that child; preserve global default retry behavior. Existing route regression failed in isolation before the fix (`fallback-isolated.log`); the focused215test run passed after (`regression-green.log`). Actual browser populated Tasks with both registry and health aborted (`fallback-browser-green.json`).
- Automation editor's accessible sr-only legend lay outside its unpositioned fieldset, causing402px viewport to have438px document width. Position its fieldset; preserve the legend. Browser before/after: `automation-overflow.json` and `automation-overflow-green.json` (402/402after).

## Browser qualification

Normal `npm run test:e2e` skipped because its doctor could not launch sandboxed Chromium and probed an unavailable CDN. This was **not** counted as a pass. The installed browser works with explicit `--args --no-sandbox`; a local provider wrapper was proven against the real test server, then the full actual suite was invoked directly with its repository Vitest config.

The first full direct run had266pass107fail6skip, but overlapped a rebuild; it is diagnostic only. A bounded rerun also overlapped the final build and is not final acceptance. `e2e-stable-full.log` is the subsequent complete run against an unchanged built app: **271passed,102failed,6skipped;20failed/23passed files**. All379tests were included. The final failure traces are `e2e-stable-failures.log`. Do not substitute isolated passing reruns for that full result.

Known stale assertions include232px desktop sidebar,232px mobile drawer, lowercase wordmark, first-nav-only selection, visible version text counted as a footer control, Notes action names/order, old decorative backdrop and selection-rail styling. Only bounded proven expectations were updated; other failures remain visible for owner triage. A20px mobile menu layout box is not itself a touch regression: its ::after creates44px, and both outside hit points reach the button (`mobile-menu-hit-area.json`). The smoke test now asserts that actual region.

## Evidence coverage and provenance

`coverage-193.json` inventories193unique reference IDs from source-confirmed .pen SHA256 `56a71a27c7795137cab1c0a40a5839edecbacab4014d2d39ddc90f89343275f8`. **36shared/Skills frames are delegated;157owned frames remain in this audit.**152owned states have current browser PNGs. Five composite/board entries require multiple specimen states rather than a fictitious one-page screenshot.All152captured pairs were independently inspected; their state/geometry gaps remain explicit and are not accepted by capture count. Historical parent coverage is retained as provenance and explicitly rejected as final evidence.

The real reusable fixture under `.ai/qa/runtime-verified` supplies four schema-valid runs, two actual variants, actual Git history/diffs and worker relationships. Browser-only contract fixtures supply GitHub responses, optional-state data, Plan results and installed-skill status; no external GitHub mutation, authentication or automation launch is represented as real. Settings seed uses only isolated fixture files/APIs; MCP Save/Reset/restore and navigation were exercised. Runtime home/repo state is not part of the evidence commit.

Final served index and all86JS/CSS/WOFF2 hashes match disk (`server-proof-final-bundle.json`). Body Poppins and loaded JetBrains Mono are verified; font files include Poppins, JetBrains Mono and IBM Plex Mono. Original font audit identifies 9486-text distribution (8550Poppins,721JetBrainsMono,215IBM PlexMono) and76filled Lucide outlines. Missing source-font U+2304/U+21BB fallback squares are reference defects, not required application glyphs. No arbitrary substitute icons were introduced here.

## Per-view findings

| View | Independently checked evidence | Outstanding gap or legitimate data difference |
|---|---|---|
| New Task | Desktop/mobile light plus desktop dark;1/23family | Starters and follow-ups add height versus older1frames but are required by23frames. Actual provider/branch differ legitimately. Dark switch thumb color differs from white reference. |
| Session/activity | Desktop/mobile light+dark; expanded actual tool; navigation drawer | Active tab was black/white; checkpoint fixes it to purple, verified in all four Session pairs. Extra workflow progress/start delimiter and document-flow composer change vertical rhythm. Historical per-turn runner/model and handoff timestamp unavailable; do not fabricate them. Expanded fixture has one actual command, so reference multi-command failure/history layout is not accepted. |
| Project Tasks | Desktop/mobile, column-menu specimen, floating New task | Retained Mark all read, Columns, pins, workers and comparison strip change height. Dynamic counts/resources remain actual. Full long-title/cell browser failures still require triage. |
| All Tasks | Populated two-project desktop/mobile | Grouped cards/actions match26intent but substantially differ from5table layout. Global Changes API has no diffStat; never invent totals. Filter/tag grouping increases mobile first-row depth. |
| Inbox | Runnable plus note-only fixtures, expanded instructions; empty/disabled specimens | More runner/model/effort controls than reference. Population fixture refreshed after initial one-card capture; no follow-up launched. |
| Automations | List with paused record and real-format activity fixture; editor; empty/disabled | Editor overflow fixed. Actual intervals/names differ legitimately. Activity response fixture targets correct `/automation-log` endpoint; historical launch entry is disclosed, not an actual launch. |
| Plan | Populated3step desktop/mobile and both themes; task creation blocked | Desktop modal overlay instead of reference embedded canvas. Mobile sticky bottom action area creates extra whitespace. Three rather than four steps is fixture data. Empty/fallback/save/discard composite not wholly pixel-accepted. |
| Variants | Desktop/mobile result cards, dark; waiting/error/pick confirmation specimens | Realreview/done statuses, resources and diffs differ from artwork. No progress notes in fixture is legitimate. Confirmation cancelled; no variants removed. |
| Git | Changes, commits, branches; settled mobile/dark diff | Real one-file worktree and no-remote Pull guard differ from reference. Actual author/time/SHA retained. Mobile tree/render differs and old suite expected tree hidden; this needs design/behavior reconciliation rather than fabricated files. |
| Task Changes/Commits/Files | Settled actual diff, commit list, file tree | Extra worker/progress/commit controls retained; purple mobile tab accent restored. Empty file selection is honest state. Reference full-file/expanded-tree specimens not all accepted. |
| GitHub | Issue list and selected PR conversation/changes; unknown-readiness and ready fixtures | PR assignee/board metadata are issue-only APIs. Passing checks with unknown requirements correctly keep merge blocked. Merge confirmation/bypass/conflict composites are not fully accepted; no merge attempted. Resize280/360/520both themes independently inspected; actual issue list/detail contained, fixture data differs. |
| Tools | Workspace tools light/dark; current tools menu; actualdiagnostics | Actual toolchain versions/availability replace samplevalues. No remote means Repository row omitted honestly; all actual tools retained. Diagnostic copy/recheck/add-project behavior covered by browser suites/fixture checks; not every modal state pixel-reviewed. |
| Settings | All13sections in both themes and desktop/mobile;52final seeded captures | See `acceptance-notes.md` for concrete section differences. Agents switch-thumb defect fixed and visually rechecked in final bundle. Accounts layout/auth-active state differs substantially. Mobile controls stack differently; actual scope/persistence/extra safeguards retained. |

## Settings test-deletion audit

Compared the integrated Settings changes with their baseline. Removed tests covered the replaced horizontal navigation-pill geometry; disclosure/deep-link checks replaced them. Auth/account polling, hosted MCP read-only behavior, project/global scope, byte save/reset and persistence remain covered in separate Settings suites. This does not establish that every existing browser selector is current: Settings Agents, Appearance and page headings now pass18focused browser tests with auth/scope/persistence guards retained.


## Final findings and remaining acceptance gaps

- Settings final52states inspected. S02thumbs visible/white again; S03primary agent files and contained editor restored; S12actual2account count/defaultmodel labels truthful. Extra privacy/scope/helper text makes mobile cards taller. Real MCP byte Save/Reset/restore smoke passes; Add project dialog opens/cancels; auth flow was not fabricated. Removed Settings tests concern replaced horizontal-pill geometry and account detail presentation, with identity-fetch/auth/MCP/scope/persistence guards retained.
- New Task source23starters/followups matches the implemented composition substantially better than legacy1. Legacy1mobile Start remains below initial viewport because retained starters/project control add height. This is an explicit visual mismatch, not a reason to remove capabilities. Dark thumb color correction is now owned and pending final proof.
- Session extra worker/progress/start markers and truthful metadata change vertical rhythm. Expanded reference multicommand/error transcript is not reproduced by the real one-command fixture; no per-turn runner labels or handoff timestamp invented. Purple tabs now match.
- TaskChanges/Commits/Files have actual five changed files after the fixture's real MCP/config smoke, one commit, extra progress/search/author/SHA. This is genuine data, not the reference four-file task. File view selects paths; reference Open worktree action differs. Mobile tree stays selectable above diff as shown by design, superseding the old hide-tree assertion.
- Global Changes lacks API diffStat; PR assignee/board metadata belongs to issue APIs. No fabricated fields. GitHub mobile eOnqx remains list-only versus reference selected issue; expanded confirmation/bypass/conflict composites and Plan empty/save/discard composites remain unaccepted. Merge never executed.
- Sidebar Active/Archived lives in Tools; initial missing-control hypothesis was corrected by tracing AppShellContainer152/ToolsMenu113. Existing in-memory filter resets on reload intentionally. Actual browser independence/persistence checks are being updated, not removed.
- Touch v3:20pass4fail; remaining genuine View YAML target38.5px compact/33px ultra corrected in source. Menu20px and workflow26px icon boxes have real44px pseudo hit areas; actual five-point edges pass. Earlier menu overlap came from stale scroll position and disappears after initial-scroll reset.
- Selection contrast remains an explicit blocker: enabled model boundaries ratio1mobile/1.39darkdesktop/1.26lightdesktop against>=3guard; four mobile Skills selected-surface cases currently transparent. Structural old rails were replaced by selected surface/ARIA/textAA checks; contrast/focus/native-disabled guards remain. Do not describe these failures as stale selectors.

The stable full browser baseline was271pass102fail6skip (43files) before the final bundle/test adaptations. Focused passes are recorded separately and cannot replace a final unchanged-build whole browser result. Final whole browser execution/result is still required; this report supplies no whole-product signoff.

R2width gap closed: six current side-by-side pairs inspected after actual browser280/360/520preference readback. Counts now152images/152inspected,5ownedboard/compositeframes withoutsinglematch. Width proof: github-width-current.json. Fixture wrongissueURL is recorded as fixturedata defect, no launch performed.

Corrections review: actualYAMLtoggle44px and all24touchtests passed; workerrelationships8/8, mobileTasks16/16 and taskChanges7/7 passed in bounded114run. Sourceguardian rejectedrawwhiteclasses; implementation now usesexisting bg-accent-strong-foreground token (white in both themes), rather than widening guardian. Later duplicateimport duringe2etestediting made transienttypecheckred; corrected before finalfreeze. These intermediate failures remain logged and are not finalpasses.
