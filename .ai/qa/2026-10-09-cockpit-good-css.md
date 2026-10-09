# Cockpit CSS accessibility follow-up

Source: hearsay-tools/cezarion#941. The implementation preserves the approved palette, Radix primitives, navigation, and browser floor.

| Finding | Implementation and verification |
| --- | --- |
| 1. Keyboard focus | Shared semantic outlines, forced-colors system ink, and an editor wrapper outline. Chrome checks both themes, forced colors and actual keyboard navigation. |
| 2. Reduced motion | Overlay movement and switch translation opt into motion-safe; fades/status remain. Chrome checks preference activation, switch duration and dialog open/close. |
| 3. Editable text | One unlayered phone/coarse-pointer 16px floor covers route overrides and both editor surfaces. Chrome measures workflow textarea and editor/underlay alignment at 390px. User zoom remains enabled. |
| 4. Syntax comments | Independent per-theme OKLCH comment inks. Chrome measures actual editor comments and added/deleted word highlights in the real Git diff. The added-word regression failed at 3.7687:1 before the final adjustment. |
| 5. Touch targets | Actual 44px layout floors at phone widths and on any coarse pointer, independent of density. Switches retain a compact track inside their target. Workflow controls no longer expand overlapping pseudo-elements; square targets retain rounded glyphs. Chrome measures 1024px tablets in comfortable, compact and ultra density. |
| 6. Dialog bounds | Dialog and AlertDialog have dynamic-viewport bounds and scrolling. DialogBody allows a fixed header/footer around scrollable content; the folder dialog adopts it. Chrome checks reachable actions at 360×640 with a 24px root font. The heading reserves space for the close control after screenshot review exposed overlap. |
| 7. Composer sizing | Native field-sizing follows wrapping; older engines retain the measured fallback, with inline-resize/font-load updates and observer cleanup. Browser coverage checks native growth/shrink, fallback growth, cap, draft and focus. Existing disclosure unit coverage pins draft, selection and attachment retention; mobileCollapsible currently has no production caller. |
| 8. Available-width layouts | New-task split uses a named container; settings configuration groups use an intrinsic grid. New-task gutters use a bounded rem-based clamp. Existing picker/browser suites cover narrow allocations. |
| 9. Pointer feedback | Shared pressed feedback does not move controls. Button hover and the preview divider require a fine hovering pointer; keyboard/active feedback remains independent. |
| 10. Logical edges | Production CSS layout edges, multi-value spacing, and touched shared-control spacing utilities use logical properties. Physical pointer coordinates and preview protocols are unchanged. This is not a claim of full RTL product support. |
| 11. Color tokens | Existing sRGB palette values converted to equivalent OKLCH; palette assertions convert back to the original byte values. Neutral hue is none. Redundant light-theme aliases removed; first-paint theme selection remains unchanged. |
| 12. Intentional clipping | Decorative ghost-code reveal uses clip. Script-scrolled editor underlay, thread/shell scrolling and real scrollers keep their existing mechanisms. |
| 13. Style consolidation | New-task geometry moves from the global sheet into its route sheet, editor metrics live together, workflow description has one final rule, duplicate task-heading rule removed, and shared accessibility floors have one owner. |

## Experience

No new imagery: these are controls and layout corrections. Existing loading, empty, error, disabled and success states remain. Local Chrome artifacts are written by `good-css.e2e.ts` under `.ai/qa/artifacts_e2e/good-css/` (editor in both themes, actual diff highlights, and enlarged-text folder dialog). Browser tests use fixture-owned files and folders.

## Compatibility and remaining QA

No `light-dark()` migration: the existing theme selectors avoid raising the Safari floor. Composer measurement remains available where `field-sizing: content` is unsupported. `overflow: clip` is used only for decoration.

**Real Safari QA remains unperformed:** this Linux host has no Safari/device connection. Chrome emulation does not establish iOS focus-zoom or virtual-keyboard behavior. Before accepting the Safari criterion, check phone/tablet input focus (including the code editor), keyboard-open short dialogs, composer growth/cap and draft retention, reduced-motion overlays, and both themes in real Safari. Do not treat a WebKit emulator as that evidence.

Verification commands and outcomes are recorded below and in the task handoff; partial browser runs are not the full local gate.

## Step 2 verification

Tested on `fix/cockpit-good-css` over `f579308dff40`, with the uncommitted issue changes.

- `npm run typecheck`: passed.
- `npm run test:unit`: passed (75 service tests and 539 repository-script tests).
- `npm run build`: passed, including the package-content gate.
- `npm run test:package`: passed (72 tests).
- `npm test -- --maxWorkers=2`: completed with 667 files passing and one failing; 15,144 tests passed, one failed, two skipped. The sole failure was the delegation fsync snapshot-cleanup descriptor assertion (`packages/cezar/src/delegation/results.test.ts:137`). Its isolated rerun passed unchanged. The full command exited 1; the passing retry does not establish a fully green full-suite run.
- Full browser execution exposed hex/RGB-only assertions in the thread and smoke specs. They now accept the new representation while retaining the approved keyword color and shell/token equality checks; focused re-verification passed (3 color/scroll checks and 4 picker-layout checks). The composer regression now observes rendered size rather than inline-style mutation; the layout regression checks the container-based stacking behavior.

The good-css browser lane passed: 19 files, 139 tests passed and one capability-dependent test skipped. The enlarged 360×640 dialog screenshot was inspected after the final heading clearance change: title, close control, folder list, and both footer actions remain distinct and visible. The full four-lane run completed: 660 passed, 4 failed, and 7 capability-dependent skips. The four failures were outdated representation/measurement/layout assertions; all now pass in focused reruns. The tab-coordination rerun retained a CDP-session cleanup rejection in the unchanged tab-coordination spec and also hit a remote Basic Auth navigation timeout (4 tests passed, 1 failed). No application or browser coordination code changed for these failures.

Focused unit guards passed: 139 tests across message colors, fixture readiness, and wait discipline. The fixture inventory includes the new owned server; the wait baseline only shrank, removing two obsolete selection-state reads.

The tab-coordination cleanup failure was traced to an unowned worker-setup promise rejecting after CDP teardown. The test now collects setup errors and asserts them before teardown, while owning late cleanup rejections. All five tab-coordination tests passed after this test-only change, with no unhandled errors. No application coordination code changed. Together with the seven focused color/scroll/layout checks, all failures exposed by the full browser run now have passing reruns; this does not rewrite the original full command’s exit status.

The full unit run is finished. Its sole delegation snapshot failure passed an isolated rerun unchanged (1 selected test); the cause of the intermittent result is not established. No service implementation changed. Real Safari QA remains outstanding. All monitored commands and owned workers have finished.

The user approved opening the draft with the documented test exception; real Safari QA remains required before merge.

## PR CI follow-up

The first PR CI run exposed restored draft text in the older-browser fallback test: its fill appended to the previous test’s `Short draft`. The test now clears through keyboard input before filling, preserving the exact draft-retention assertion. All 13 good-css browser checks passed in the focused rerun. The same CI run also failed the unchanged server `omp-input-pipe.test.ts` Codex closed-input assertion; the next push will recheck it. Other three browser shards and both Node-floor shards passed.

### Reproducing the tab-coordination cleanup check

From the repository root, install dependencies and run `npm run build`, then run:

```sh
E2E_PREBUILT_ASSETS=1 npm run test:e2e -- tab-coordination.e2e.ts -t 'ten mixed tabs'
```

This selects the two parameterized cases that create replacement SharedWorkers and close their CDP sessions during teardown. On an unfixed checkout, the intermittent failure signature is `Unhandled Rejection: Error: CDP session closed`, with the stack pointing to `AgentBrowser.withCdp` and `tab-coordination.e2e.ts:31`; it may be reported during the next test. It is timing-dependent, so a single passing run does not reproduce or disprove the old failure. The expected fixed outcome is both cases passing with no unhandled rejection; setup errors before teardown still fail the explicit assertion.

The original full-spec reproduction command was `E2E_PREBUILT_ASSETS=1 npm run test:e2e -- tab-coordination.e2e.ts`; its fixed rerun passed all five tests with no unhandled errors. The separate remote Basic Auth navigation timeout produced `.ai/qa/failures/tab-coordination/remote-Basic-Auth-keeps-finite-recovery-authenticated-without-a-worker-or-ordina-1/`; that bundle describes the navigation timeout, not the CDP cleanup rejection.

PR CI on commit `7f4394c8` subsequently passed both Vitest shards, both Node-floor shards, all four browser shards, and the aggregate build/package gate after the documented retry of an unchanged runner test.

## Authorized runner follow-up

The user expanded scope after repeated CI failures. OpenCode classified only numeric exit codes; an external SIGKILL could settle without an error when process exit preceded SSE closure. The runner now recognizes an external signal and includes its name in the error, while preserving successful self-initiated termination. The existing RUNNER_IDS shutdown S22 regression retains native mocks and delays only the SSE terminal notification to force this ordering. It failed against the original source, then all 38 shutdown-parity tests passed with the fix. This strengthens an existing registered parity cell rather than introducing an exemption.

## Preview landing failure evidence

The preview landing adjustment responds to [CI job 114009939596](https://github.com/hearsay-tools/cezarion/actions/runs/37986554086/job/114009939596) on `2d62cd36`. Download its `cockpit-failures-shard-4` artifact; `live-preview/registers-runs-streams-takes-a-click-and-stops-1/` contains `snapshot.txt`, `probe.json`, and `screenshot.png`. The snapshot shows “Open a page in this task’s browser”, a registered server and its “Review” button. The probe records `needs-approval` as null. This is distinct from the earlier sticky-header click failure: opening the pane succeeded, but it landed on the valid server list instead of directly selecting approval.

Recheck locally after building E2E assets with `npm run test:e2e -- live-preview.e2e.ts`. This command passed after the adjustment. The test follows Review when that landing appears and retains the original command/approval assertions, explicit Run and open action, stream/click checks and stop check. The CI failure is timing-dependent; a local pass alone does not reproduce the earlier ordering. All four browser shards subsequently passed on `9783423d`.
