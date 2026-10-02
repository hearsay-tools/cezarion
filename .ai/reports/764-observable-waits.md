# Issue #764 implementation and focused validation

Issue: https://github.com/hearsay-tools/cezarion/issues/764. Implemented the issue body and its complete Agent context comment. This is the DIRECT TRACK implementer handoff; the parent owns independent review, ten idle/load repetitions, the eight-task campaign, and the full six-command gate. No production scheduling/concurrency code or dependencies changed.

## Implementation inventory

- Seven browser observation sleeps removed: history's two settlement/cascade delays; GitHub custom-prompt screenshot; GitHub PR review and loading/error/empty screenshots; plan-review screenshots; task-view screenshots.
- Five GitHub clock-only waits removed: refreshing/loading gates now require rendered frame samples plus held toolbar geometry; ready/unavailable results require settled route geometry; focus handoff returns the accepted active-element sample. The original per-frame geometry collectors and unchanged distinct-position assertions remain armed across the entire response gate. The explicit `__finishProjects` request-arrival guard remains.
- Two packaged CLI 150ms observations removed. Each compromised-lock case asserts the owned writer PID is already reaped before reading final numeric ticks. Reaping is the completion acknowledgement: a dead child cannot write again. SIGTERM receipt, installation/recovery state and PID assertions remain.
- History waits for retained page count, idle and the named anchor before checking counts or continuing. Its negative cascade case reloads its own starting state, installs cumulative started/completed/pending observations before the gesture, consumes the response body, waits for page commit and named anchor settlement, then holds the cycle counters before asserting exactly one request. The shared parking helper first establishes the tail before its unpin gesture; an already-near-boundary wheel otherwise loads an unintended page.
- Task-column persistence and skills workspace overrides poll actual saved values. Nine duplicate poll/backoff sites use shared polling: automation completion, two skills preferences, queued-stack fetch retry, four health loops and plan-step order. Plan reordering makes one non-idempotent click after target settlement and observes its changed order.
- Shared HTTP polls have explicit wall-clock and per-probe bounds, cancellation passed into requests and body reads, an absolute deadline for sequential waits, bounded diagnostics inside a reserved portion of the budget, and last error/state context. Existing attempt caps and 10/15/60 second nominal defaults remain. Additional shared HTTP probes in monitoring, new-task and CI-header helpers now propagate cancellation too.
- Composer closed/continue uses a shared 140-second HTTP deadline inside a 180-second test; review follow-up uses 110 seconds inside 180 (two browser waits plus bounded capture reserve); queued setup shares 140 inside 180. Browser polled commands use the remaining monotonic wait budget and reject late samples. Selector/predicate commands have bounded wait-plus-transport budgets. Capture steps and browser close have five-second bounds; fixture server shutdown already has five-second grace plus five-second force acknowledgement. The 60-second hook budget covers cleanup. Ordinary action/screenshot command budgets remain unchanged.
- The guard catches clock-only predicates, permits reject-only event failure deadlines, covers packaged CLI specs and helpers, and catches qualified page/global timers while permitting HTTP socket deadlines. Audited packaged condition intervals, restart simulation and termination policies carry reasoned local annotations. The browser baseline shrank from **18 sleeps + 64 one-shot reads** to **0 sleeps + 61 one-shot reads**, with no additions. Thread-scroll observer deadlines, review celebration latching and focus dismissal behavior are preserved.

## Red/green evidence

The helper/scanner tests were written and run before their implementations. Logs below are checked in beside this report.

| Regression | Evidence without fix | Passing evidence |
|---|---|---|
| Stuck/ignored-abort HTTP probes and last status | `764-unit-red.log`: 6 failures, 37 passes; stuck probe exceeds its test bound and status diagnostics omit last state | `764-unit-green.log` |
| Clock predicates and event deadlines | `764-unit-red.log`: clock waits unflagged; reject-only deadline falsely flagged | `764-unit-green.log` |
| A newly added packaged helper must be scanned | `764-packaged-scanner-red.log`: injected helper produces no findings without packaged traversal | `764-unit-green.log` |
| Qualified `window` / `globalThis` delays | `764-qualified-scanner-red.log`: qualified timer missed | `764-unit-green.log` |
| Fonts/appearance/finite-animation readiness | `764-visual-red.log`: minimal missing-behavior scaffold returns null even for ready targets | `764-unit-green.log` |
| Late CLI sample must fail, not satisfy readiness | `764-browser-budget-red.log`: old command accepts a ready sample after its 100ms budget (fake CLI delays 1500ms) | `764-unit-green.log` |
| Loading spinner's rotating ink must not prevent surrounding layout settlement | `764-spinner-red.log`: consecutive layout samples differ only inside infinite spinner | `764-unit-green.log` |

Final proof: `git stash push -m '764 final regression red proof' -- packages/web/e2e/poll.ts packages/web/e2e/agent-browser.ts packages/web/src/test/e2e-wait-discipline.ts`, then
`npm test -- packages/web/src/test/poll.test.ts packages/web/src/test/agent-browser-wait-value.test.ts packages/web/src/test/e2e-wait-discipline.test.ts -t 'wall-clock and request bounds|observable waits|scans a new packaged helper|rejects qualified page timers|bounds the CLI probe'` produced **9 failures, 50 filtered**, all expected missing behaviors (`764-final-without-fixes-red.log`). `git stash pop` restored the fixes without conflicts; the full targeted helper selection is green afterward.

`764-browser-evidence/` contains preserved screenshots, snapshots and probes from investigation, copied from ignored QA storage before teardown/cleanup. Read the original history failure bundle and subsequent count mismatch; the setup wheel could accidentally request an extra page. The final full history spec passes. Read the task-view bundle: the detailed-table wrapper is hidden while the summary table is visible; readiness now measures the actual route. Read the GitHub loading bundle: returned samples show changing rotated SVG rectangles; the helper excludes infinite animated ink while holding its container and surrounding layout. No overflow, content, geometry-distinctness, focus or celebration assertions were relaxed.

## Commands actually run

All commands ran in this worker's own worktree after `npm ci`. `764-npm-ci.log` retains an explicit successful install. Browser bootstrap also ran its required `npm ci && VITE_CEZ_E2E=1 npm run build`, creating the E2E build marker and descriptor; this was fixture preparation, not a six-command gate. Web-only typecheck rebuilds local server declarations by repository convention.

- `npm run typecheck:web` — passed; `764-typecheck-web.log`.
- `npm test -- packages/web/src/test/agent-browser-wait-value.test.ts packages/web/src/test/agent-browser-interact.test.ts packages/web/src/test/agent-browser-failure.test.ts packages/web/src/test/poll.test.ts packages/web/src/test/visual-ready.test.ts packages/web/src/test/e2e-wait-discipline.test.ts` — **77 passed**, six files; `764-unit-green.log`.
- `node --import ./scripts/test-git-env.mjs --import tsx --test --test-name-pattern='SIGTERM-resistant' packages/cezar/test/e2e/application-update.test.ts` — **2 passed**; `764-package-focused.log`.
- `env -u CEZ_AUTOMATIONS npm run test:e2e -- progressive-history.e2e.ts github-layout.e2e.ts -t 'loads exactly one page|consumes one upward intent|hands focus on|while project boards refresh then settle as ready at 1440 / light|without cached boards, settling as long names at 1440 / light'` — initial iteration: **5 passed, 1 failed, 36 filtered**. The unquoted geometry filters did not select their quoted parameterized titles. `764-history-focus.log`; corrected filters appear below.

After bootstrap, the following iteration commands used the same healthy descriptor and E2E assets directly through npm/Vitest. This avoids rebuilding unchanged app assets whenever a test/helper file changes. The wrapper is the portable entry point for a fresh checkout.

```sh
env -u CEZ_AUTOMATIONS TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm test -- --config packages/web/e2e/vitest.config.ts progressive-history.e2e.ts
env -u CEZ_AUTOMATIONS TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm test -- --config packages/web/e2e/vitest.config.ts plan-mode.e2e.ts task-views-layout.e2e.ts skills-update.e2e.ts github-states.e2e.ts github-pr-review.e2e.ts
env -u CEZ_AUTOMATIONS TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm test -- --config packages/web/e2e/vitest.config.ts task-views-layout.e2e.ts github-states.e2e.ts
env -u CEZ_AUTOMATIONS TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm test -- --config packages/web/e2e/vitest.config.ts github-layout.e2e.ts -t 'refresh then settle as .*ready.*1440.*light|without cached boards.*long names.*1440.*light|hands focus on|handoff fields usable at 1440.*light' --reporter=verbose
```

Results respectively:

1. **7 passed**; `764-history-green.log`.
2. Initial visual iteration **31 passed, 2 failed** (hidden readiness target and spinner sampling described above). Plan, skill-update and PR-review files all passed; `764-visual-persistence.log`.
3. After fixes **10 passed**, both affected files entirely green; `764-visual-persistence-green.log`.
4. **7 passed, 28 filtered**, including desktop/phone focus, cached refresh, uncached long-name geometry and custom-prompt screenshot; `764-github-focus-geometry-green.log`.

Additional budget and transient-event validation:

```sh
env -u CEZ_AUTOMATIONS TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm test -- --config packages/web/e2e/vitest.config.ts composer.e2e.ts review-gate.e2e.ts queued-stack.e2e.ts
```

**18 passed across three files**, including the unchanged one-shot celebration, closed-session Continue, follow-up review gate and queued input behavior; `764-budget-celebration-green.log`. Full specs preserve their shared-state ordering.

## Repeatable representative selection for the parent

Use this exact selection in each isolated lane/worktree, with its own descriptor, `CEZ_HOME`, port, QA paths and browser namespace. Do not run ten repetitions against one evolving shared server. It covers positive and negative history, focus ownership/preservation, both transition frame samplers, custom-prompt visual readiness, intentionally held loading readiness, task-column durability, and skills preference durability.

```sh
env -u CEZ_AUTOMATIONS npm run test:e2e -- progressive-history.e2e.ts github-layout.e2e.ts github-states.e2e.ts task-views-layout.e2e.ts skills-update.e2e.ts -t 'loads exactly one page|consumes one upward intent|hands focus on.*1440|handoff fields usable at 1440.*light|refresh then settle as .*ready.*1440.*light|without cached boards.*long names.*1440.*light|renders GitHub.*loading.*light|persists column choices|shows the inherited global preference' --reporter=verbose
```

The identical selection was run once through the already-bootstrapped npm/Vitest entry point: **10 passed, 47 filtered across five files**, 42.37 seconds; `764-repeatable-focus-green.log`. No ten-repetition campaign was run.

Exact selected cases (quoted string parameterization matters):

1. `loads exactly one page, preserves the visible anchor, and bounds retained pages`
2. `consumes one upward intent without cascading while the boundary remains near`
3. `hands focus on from the closed status button but leaves other focus alone at 1440 ('status button') (#721)`
4. Same focus test at `1440 ('search')`
5. `keeps handoff fields usable at 1440 / 'light'`
6. `keeps filter geometry still while project boards refresh then settle as 'ready' at 1440 / 'light' (#721)`
7. `keeps filter geometry still without cached boards, settling as 'long names' at 1440 / 'light' (#721)`
8. `renders GitHub 'loading' in 'light' without losing navigation`
9. `persists column choices, filters projects, and expands mobile resources through real controls`
10. `shows the inherited global preference and persists an explicit override`

History's cascade case now establishes its own state and can be selected alone. The positive history case starts from the beforeAll tail. GitHub beforeEach resets navigation and view preferences. Task-column and skills cases establish fixtures/preferences in beforeAll and restore/stop them in afterAll. Plan-review screenshot/control tests use the overlay established by earlier plan tests: run the whole `plan-mode.e2e.ts` file when including them, not just its screenshot test.

Each invocation uses **one serial Vitest lane** (`fileParallelism: false`), not four lanes. The selected GitHub loading case opens **two browser sessions**: the GitHub fixture's blank session plus the state session; only the latter drives the loading route. Other selected specs use one session. Thus eight simultaneous selected invocations can peak at sixteen browser sessions, not eight; browser sessions are not a measurement of OS Chrome processes. Unrelated task browser activity was observed on this host during iteration, so these runs are ordinary focused validation, **not controlled idle or eight-task-load evidence**. The parent should count its actual live sessions/processes and retained lane evidence during both controlled campaigns.

## Remaining validation

No known failing focused cases remain. The parent must run independent review and its authorized final gate, ten controlled idle repetitions, ten repetitions under eight-task load, and the complete four-lane suite, retaining per-lane logs, actual browser/process counts, host pressure, latencies and failure bundles. This worker did not run those campaigns, push, create a PR, or change the issue/board.

## Changed implementation paths

```text
packages/cezar/test/e2e/application-update.test.ts
packages/cezar/test/e2e/cockpit-ownership.test.ts
packages/cezar/test/e2e/delegation.test.ts
packages/cezar/test/e2e/stop-child.ts
packages/cezar/test/e2e/task-cli.test.ts
packages/web/e2e/README.md
packages/web/e2e/agent-browser.ts
packages/web/e2e/automations.e2e.ts
packages/web/e2e/composer.e2e.ts
packages/web/e2e/github-layout.e2e.ts
packages/web/e2e/github-pr-review.e2e.ts
packages/web/e2e/github-states.e2e.ts
packages/web/e2e/mobile-task-controls.e2e.ts
packages/web/e2e/new-task.e2e.ts
packages/web/e2e/plan-mode.e2e.ts
packages/web/e2e/poll.ts
packages/web/e2e/progressive-history.e2e.ts
packages/web/e2e/queued-stack.e2e.ts
packages/web/e2e/review-gate.e2e.ts
packages/web/e2e/run-header-ci-wait.e2e.ts
packages/web/e2e/selection-states.e2e.ts
packages/web/e2e/settings-monitoring.e2e.ts
packages/web/e2e/skills-update.e2e.ts
packages/web/e2e/task-views-layout.e2e.ts
packages/web/e2e/touch-targets.e2e.ts
packages/web/e2e/worker-relationships.e2e.ts
packages/web/src/test/agent-browser-wait-value.test.ts
packages/web/src/test/e2e-wait-discipline.baseline.json
packages/web/src/test/e2e-wait-discipline.test.ts
packages/web/src/test/e2e-wait-discipline.ts
packages/web/src/test/poll.test.ts
packages/web/e2e/visual-ready.ts
packages/web/src/test/visual-ready.test.ts
```

The report, checked-in logs and preserved fixture failure bundles live under `.ai/reports/764-*`. Fresh passing screenshots remain under `.ai/qa/artifacts_e2e/` until copied by the parent or cleaned with task history.


## Independent review follow-up

The review identified two gaps, both reproduced before changing the implementation. A settled health probe accepted headers while leaving its streamed response body open; three rejected JSON probes likewise left three sockets open. Clearing the timeout removed their remaining cleanup deadline. `boundedProbe` now aborts its controller in `finally` on every settlement, cancelling unread bodies as well as stopping its timer. The regression uses a real local Node HTTP server with deliberately unfinished bodies, checks one successful health request and three non-2xx JSON requests, observes all sockets close, and force-closes the fixture in cleanup even on failure.

The scanner previously classified reject-only timers by line number, allowing a neighboring success timer on the same line. It now classifies each matched timer call span. The regression places both timers on the same line in both orders and requires the success sleep to be reported while preserving the failure-deadline exemption. The repository baseline remains unchanged.

Red proof before either fix:

```sh
npm test -- packages/web/src/test/poll.test.ts packages/web/src/test/e2e-wait-discipline.test.ts -t 'settled probes close unread streamed bodies|exempts event deadlines per call'
```

**3 failed, 45 filtered**: health retained one socket, JSON retained three sockets, and the scanner omitted the success sleep. Evidence: `764-review-red.log`.

Focused green verification:

```sh
npm test -- packages/web/src/test/poll.test.ts packages/web/src/test/e2e-wait-discipline.test.ts
npm run typecheck:web
```

**48 passed across two files**, including the repository baseline guard; web typecheck passed. Evidence: `764-review-green.log`, `764-review-typecheck.log`.

No browser or application test environment was started for this follow-up. The HTTP fixture binds an ephemeral loopback port and closes its server and connections after each test. No full gate or browser/load campaign was run; those remain parent-owned validation. No unresolved issue remains in either review finding.


Adjacent helper validation also passed **80 tests across six files** (`764-review-helpers-green.log`):

```sh
npm test -- packages/web/src/test/agent-browser-wait-value.test.ts packages/web/src/test/agent-browser-interact.test.ts packages/web/src/test/agent-browser-failure.test.ts packages/web/src/test/poll.test.ts packages/web/src/test/visual-ready.test.ts packages/web/src/test/e2e-wait-discipline.test.ts
```

`git diff --check` passed before commit. Follow-up changes are limited to `packages/web/e2e/poll.ts`, the scanner and their two test files, this report, and four review validation logs.


## Idle-campaign history follow-up

The parent's fifth fresh idle repetition failed the positive history case while the negative cascade case passed. Read the retained `round-5-lane-1/tests.log` and the positive history `probe.json`, `snapshot.txt` and `screenshot.png` before diagnosing. The probe recorded task-anchor top **298 → 310**, scrollTop **0 → 0**, maxTop **8069 → 16108**, mounted rows **128 → 255**, virtualization false. The exact `<2px` anchor assertion remains unchanged.

A focused run in this worktree reproduced the same failure before the fix. Temporary before/after diagnostics showed **header height 164 → 176**, **metadata height 32 → 44**, **PR chip absent → present**, and `__cezIdle: true` at both samples; the authoritative run API was still `running` before paging. Evidence is `764-history-diagnosis.log`; its failure probe/snapshot/screenshot were copied to `764-history-followup-evidence/progressive-history/loads-exactly-one-page-preserves-the-visible-anchor-and-bounds-retained-pages-1/` before cleanup. Temporary diagnostic instrumentation was removed from the final source.

Root cause: this fixture writes a `running` record with no PR URL. CLI startup recovery (`packages/cezar/src/index.ts`, `RunManager.recover` in `packages/cezar/src/workflows/run.ts`) resumes it asynchronously through the dry-run continuation. That continuation eventually parks in `waiting` and exposes a referenced PR. The header's PR control has `no-hover:min-h-[44px]`, enlarging the initial 32px metadata row by exactly 12px. Query/SSE idle only describes current work; it cannot prove a future continuation update has finished. The filtered campaign skipped the earlier tail screenshot test that usually supplied incidental time for this update.

The fix observes recovery's **waiting status**, the **rendered PR chip**, **cockpit idle**, and **stable visual header geometry** in `beforeAll`, before taking any history anchor baseline. It reuses the bounded `waitForStatus` and `settleVisual` helpers, changes no scheduling or fixture state, and preserves all paging, cascade, focus and frame-by-frame assertions. A first synchronization trial incorrectly expected `review`; its bounded failure reported last state `waiting` (`764-history-followup-status-trial.log`), after which the durable recovered state was inspected and the condition corrected.

Exact focused browser red/green commands (red used only the positive filter and temporary header diagnostics):

```sh
env -u CEZ_AUTOMATIONS TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm test -- --config packages/web/e2e/vitest.config.ts progressive-history.e2e.ts -t 'loads exactly one page' --reporter=verbose
env -u CEZ_AUTOMATIONS TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm test -- --config packages/web/e2e/vitest.config.ts progressive-history.e2e.ts -t 'loads exactly one page|consumes one upward intent' --reporter=verbose
```

Red: **1 failed, 6 filtered**, exact 12px failure (`764-history-diagnosis.log`). Green: **2 passed, 5 filtered**, including the negative observation (`764-history-followup-focused-green.log`). Both selections omit `paints the current tail`, matching the campaign's history selection.

```sh
npm test -- packages/web/src/test/e2e-wait-discipline.test.ts packages/web/src/test/visual-ready.test.ts
```

**33 unit tests passed**, including the scanner baseline and visual helper (`764-history-followup-units-green.log`). No helper/scanner behavior changed in this follow-up. The existing ten-case representative campaign selection and shared-state ordering guidance above remain valid.


The complete history file passed **7/7** (`764-history-followup-all-green.log`):

```sh
env -u CEZ_AUTOMATIONS TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm test -- --config packages/web/e2e/vitest.config.ts progressive-history.e2e.ts --reporter=verbose
```

A second filtered invocation with a fresh fixture also passed **2/2**, with the tail-paint test omitted (`764-history-followup-repeat-green.log`); it used the same two-case command above. Each invocation starts its own fresh history fixture and browser session. These are focused iterations, not the parent's controlled ten-repetition campaign. The parent reports its full non-browser gates already passed; renewed idle/load campaigns and final browser validation remain parent-owned. No unresolved focused history failure remains.

Own test environment stopped successfully with `sh .ai/scripts/test-env-down.sh` (`764-history-followup-down.log`). `git diff --check` passed before commit. Changed code is limited to the history spec setup; report, diagnostic/validation logs and the three-file failure bundle are the remaining deliverables.


## Load-campaign custom-prompt follow-up

First merged the parent's tested head `0fa2d91a89a06bc049f89d83aac72d2674dc1d61` normally, as merge commit `92e3307b`, then ran `npm ci` in this worktree (`764-prompt-followup-npm-ci.log`). The current shared `use-hand-to-agent-state` implementation was therefore used for diagnosis and tests. Parent reports idle **10/10** passed and two load rounds (**16 invocations**) passed before round-three lanes 3 and 8 failed. Read both lanes' tests logs, probes, snapshots and screenshots under the parent's `load-1790946042841` evidence before diagnosing.

Both failures contained the default GitHub issue prompt concatenated with `Review this issue and keep this draft`. Current production prompt/base state initializes once per item mount; the extracted hook shares picker and engine state, not prompt initialization. Inspection of the installed `agent-browser 0.36.0` implementation explains the race: [native fill at the pinned v0.36.0 source](https://github.com/vercel-labs/agent-browser/blob/v0.36.0/cli/src/native/interaction.rs#L114) focuses, assigns `this.value = ''`, dispatches a synthetic input event, then sends `Input.insertText` in a separate CDP command. The direct assignment updates React's tracked value, so the synthetic input does not publish the clear to component state. A component rerender in the gap restores the old state; subsequent trusted text insertion appends to that restored default.

A diagnostic-only DOM value-setter/input trace plus an ordinary shared workflow selection update forced the gap on the current application. The exact-value assertion failed with this sequence:

```text
setter: ""
input: trusted=false, value=""
setter: default GitHub issue prompt
input: trusted=true, value=default GitHub issue prompt + intended replacement
```

Red proof: **1 failed, 40 filtered** (`764-prompt-followup-red.log`). The failure screenshot/probe/snapshot are retained in `764-prompt-followup-evidence/keeps-handoff-fields-usable-at-1440-light-1/`. The repeatable fault-injection patch is `764-prompt-rerender-reproduction.patch`: apply it to the pre-fix spec at merge commit `92e3307b`, then run the single-case command below. It injects a shared picker update only when the CLI's synthetic empty input occurs; it changes no production scheduling and does not depend on load or sleeps. Temporary diagnostic code and React-internal inspection are absent from the final spec.

The E2E fix clicks the prompt, sends trusted `Control+a` and `Backspace`, observes the empty value, then fills the replacement. React receives the deletion through its normal keyboard input path before the CLI clear/insert split. With the same fault injection still present, green trace is trusted empty input → synthetic empty input → trusted exact replacement, and the case passes (**1 passed, 40 filtered**, `764-prompt-followup-injected-green.log`). Existing exact-value and post-workflow-dismissal draft persistence assertions remain unchanged. The fix is limited to test input mechanics; no production defect was found or production code changed. No generic retry, sleep, or timeout increase was introduced.

Exact commands:

```sh
env -u CEZ_AUTOMATIONS TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm test -- --config packages/web/e2e/vitest.config.ts github-layout.e2e.ts -t 'handoff fields usable at 1440.*light' --reporter=verbose
env -u CEZ_AUTOMATIONS TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm test -- --config packages/web/e2e/vitest.config.ts github-layout.e2e.ts -t 'handoff fields usable' --reporter=verbose
npm test -- packages/web/src/test/agent-browser-interact.test.ts packages/web/src/test/e2e-wait-discipline.test.ts packages/web/src/routes/github/use-hand-to-agent-state.test.tsx packages/web/src/routes/github/hand-to-agent-draft.test.ts
npm run typecheck:web
```

Normal six viewport/theme handoff cases passed **6/6**, 35 filtered (`764-prompt-followup-six-green.log`). Adjacent seam/scanner/shared-state/draft unit tests passed **44/44** across four files (`764-prompt-followup-units-green.log`). Web typecheck passed on the merged head (`764-prompt-followup-typecheck.log`); this follow-up only adds four existing browser operations to the spec. Scanner baseline remains unchanged. No helper behavior was modified.


The exact 1440/light case also passed in **two fresh-session repetitions**, each 1 passed / 40 filtered, using the first command above (`764-prompt-followup-repeat-1-green.log`, `764-prompt-followup-repeat-2-green.log`). Together with the six-case selection, the originally failing case has three ordinary focused passes plus the controlled fault-injection green. These iterations are not a full load campaign. Own test environment stopped via `sh .ai/scripts/test-env-down.sh` (`764-prompt-followup-down.log`); no application or browser fixture remains from these checks. `git diff --check` passed. The parent retains full gate/load/browser campaign responsibility. No unresolved focused custom-prompt failure remains.


## Load-campaign fixture startup diagnostics

Read the parent's `load-1790947988710/round-3-lane-2/tests.log`. The failure occurred in history `beforeAll`, at `waitForHealth(http://localhost:35801)`, before a browser session existed. Its only recorded cause was “the fixture server never answered”; the spawned CLI used ignored stdio and health polling swallowed request failures. All lanes were already cleaned, so the actual child exit/output and transport error cannot be recovered. Parent reports the prompt-fixed idle campaign passed 10/10, preceding load rounds passed 16/16 invocations, and the other seven lanes passed this round. Those facts do not establish capacity exhaustion or a specific startup cause.

Source inspection found the port allocator binds/releases `127.0.0.1` before CLI spawn; health uses `localhost`; the server defaults to binding `127.0.0.1`. Bind collisions or address-family errors are possible, as are child exits or startup delays, but no one of these is proven by the retained failure. Port allocation, address spelling, HTTP budgets, retry counts and production scheduling remain unchanged. This follow-up is a diagnostic change, **not a claim that the intermittent startup failure is fixed**.

The history fixture now pipes and drains stdout/stderr from spawn onward. `captureFixtureServer` retains a 16,384-character tail for each stream, dropped-character counts, command/arguments, PID, elapsed time, exit code, signal and bounded spawn/error/exit/close lifecycle observations. Health polling preserves failed HTTP statuses and nested Node fetch causes, including bounded `AggregateError.errors` address details, rather than suppressing them. A failed health wait embeds the child snapshot in the thrown error and writes `.ai/qa/artifacts_e2e/progressive-history-startup.json`, which the parent's existing campaign artifact copy retains even without a browser failure bundle. Successful waits also record time to health; shutdown refreshes the lifecycle snapshot while keeping readiness/failure information.

TDD red command before the fixes:

```sh
npm test -- packages/web/src/test/fixture-server-diagnostics.test.ts packages/web/src/test/poll.test.ts -t 'retains real child|actual spawn error|failed health status'
```

**3 failed, 18 filtered**, plus the deliberately missing executable's unhandled error because the observer did not yet exist (`764-startup-diagnostics-red.log`). After implementation all of those checks pass with no unhandled errors. An additional real local bind-conflict test proves actual `EADDRINUSE` stderr retains the loopback address and selected port. The exit/output tests use real Node child processes, not fabricated lifecycle events.

```sh
npm test -- packages/web/src/test/fixture-server-diagnostics.test.ts packages/web/src/test/fixture-server-stop.test.ts packages/web/src/test/poll.test.ts packages/web/src/test/e2e-wait-discipline.test.ts
npm run typecheck:web
env -u CEZ_AUTOMATIONS TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm test -- --config packages/web/e2e/vitest.config.ts progressive-history.e2e.ts -t 'loads exactly one page|consumes one upward intent' --reporter=verbose
```

**56 unit tests passed** across four files (`764-startup-diagnostics-green.log`); web typecheck passed (`764-startup-diagnostics-typecheck.log`). Two fresh focused history invocations each passed **2/2**, with no startup failure (`764-startup-focused-1-green.log`, `764-startup-focused-2-green.log`). Their retained child snapshots are `764-startup-focused-1.json` and `764-startup-focused-2.json`: health ready, normal exit 0, spawn/exit/close lifecycle and drained output. No intermittent cause reproduced in these focused iterations. The parent's next controlled load run is required to capture an actual failure with these diagnostics if one recurs.


Health HTTP-status and transport-cause regressions were subsequently separated and both were proven red with only `poll.ts` stashed (`764-startup-health-without-fix-red.log`: **2 failed, 18 filtered**). The stash restored without conflicts; final four-file green is **56/56**. Exact command for that red proof:

```sh
npm test -- packages/web/src/test/poll.test.ts -t 'failed health status|address-family health'
```

A third fresh history invocation passed **2/2** (`764-startup-focused-3-green.log`) with final metadata capture: `healthReadyAfterMs: 1307`, drained normal CLI startup output, no stderr, and exit 0 (`764-startup-focused-3.json`). It used the same two-case command above. No original startup failure reproduced. Own environment stopped successfully (`764-startup-diagnostics-down.log`), and `git diff --check` passed. Remaining validation is a parent-controlled load run with these diagnostics; actual intermittent root cause is unresolved. Changed code: `fixture-server.ts`, `poll.ts`, `progressive-history.e2e.ts`, `poll.test.ts`, and new `fixture-server-diagnostics.test.ts`; no production files changed.


## Full-browser virtual history setup follow-up

First merged parent `c5e810da11c1c6fe3186259b12c29259f968ecba` normally as `88823b1a`, then installed `npm ci` in this worktree (`764-virtual-tail-npm-ci.log`). Read the parent's full-browser lane-4 log and retained 1440px failure probe/snapshot/screenshot before diagnosing. The initial setup wait exhausted with remaining distance **95px**, although tail content was visible. Parent reports all other browser cases passed and controlled idle 10/10 and load 10×8 campaigns already passed; those campaigns were not rerun by this worker.

Temporary read-only `ResizeObserver` samples around the single scroll-owner call reproduced failures at **both widths** in a full history invocation (`764-virtual-tail-diagnosis.log`: **5 passed, 2 failed**). At 1440px, the requested offset/max was **14366**, virtual row height changed **14494.8125 → 14640.875 → 14589.875**, final max became **14461**, and scrollTop stayed **14366**, leaving exactly the parent's **95px** gap. At 360px, requested max **15034** grew to **15284** while scrollTop stayed **15034**, leaving **250px**. Viewport heights stayed 836 and 583 respectively. Both failure bundles are preserved under `764-virtual-tail-evidence/`. The observation-only patch is `764-virtual-tail-measurement-reproduction.patch`, applicable to the pre-fix spec at merge commit `88823b1a`; temporary instrumentation is absent from the final source.

Root cause: `__cezThreadScrollTo` routes virtual scrolling through `VirtualizerHandle.scrollTo(top)` and intentionally clears follow-tail intent. The caller supplied a numeric maximum sampled before Virtua measured newly mounted rows. The handle keeps requesting that numeric offset while measurements change the extent; passive waiting cannot turn that old offset into the new maximum. This is a setup condition error, not evidence that the paging anchor moved or that the product failed to honor a requested offset.

The initial end request was added to make the unpin wheel safe after a prepend had left the viewport near the history boundary. Its load-bearing condition is **outside the older-history intent arm**. The setup now observes `!isNearHistoryStart(sample)` using the production pure predicate, and atomically rechecks the same threshold in the browser task that dispatches the wheel. Therefore the setup wheel cannot consume an older-page arm even if geometry changes between observations. It still issues one scroll request through the same owner, then parks at the start through that owner. Exact `<2px` anchor assertions, request-count/cumulative-completion cascade assertions, per-frame navigation checks, and all existing budgets remain unchanged. No scroll retries, sleeps, timeout inflation, or production changes were introduced.

Exact verification commands:

```sh
env -u CEZ_AUTOMATIONS TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm test -- --config packages/web/e2e/vitest.config.ts progressive-history.e2e.ts --reporter=verbose
npm test -- packages/web/src/test/e2e-wait-discipline.test.ts packages/web/src/test/agent-browser-wait-value.test.ts packages/web/src/test/visual-ready.test.ts packages/web/src/routes/task-thread/thread-scroll.test.ts
npm run typecheck:web
env -u CEZ_AUTOMATIONS TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm test -- --config packages/web/e2e/vitest.config.ts progressive-history.e2e.ts -t 'virtual history anchor' --reporter=verbose
```

The first command produced the red evidence above with only read-only diagnostics added before the fix; after the fix it passed **7/7** (`764-virtual-tail-all-green.log`), including both virtual widths and the negative cascade case. Helper/scanner/scroll-rule units passed **68/68** across four files (`764-virtual-tail-units-green.log`); web typecheck passed (`764-virtual-tail-typecheck.log`). Scanner baseline remains unchanged. Changed implementation is limited to `packages/web/e2e/progressive-history.e2e.ts`; no helper/scanner behavior was modified.


Two fresh focused invocations of both virtual widths also passed **2/2 each**, with five other cases filtered (`764-virtual-tail-focused-1-green.log`, `764-virtual-tail-focused-2-green.log`), using the final command above. Own environment stopped successfully (`764-virtual-tail-down.log`), and `git diff --check` passed. No unresolved focused history failure remains. Parent owns the final full-browser rerun and remaining gate checks; its completed controlled campaigns are not superseded by these focused checks.


## Parent verification and controlled campaigns

The parent merged current `origin/main` (`b47b4ed9`) without conflicts as `c5e810da`. The final executable change is `6c2ff709`, independently approved by the Sol medium reviewer. Both governed workers’ latest settled revision 5 results were collected.

- `npm run typecheck` → passed on merged `c5e810da`.
- `npm test` → 526 files / 11,345 tests passed on that merged tree.
- `npm run test:unit` → 568 tests passed (64 package scripts + 504 repository scripts).
- `VITE_CEZ_E2E=1 npm run build` → passed, including package-content check.
- `npm run test:package` → 60 tests passed.
- `npm run test:e2e:local` → all four lanes passed on `6c2ff709`: 63 files, 599 tests passed, 7 existing skips. This command rebuilt the merged application.
- Final setup correction focused validation → history 7/7, both virtual widths 2/2 twice in fresh sessions, 68 helper/scanner/scroll tests and web typecheck passed (worker evidence above).

Controlled campaign commands: `node .ai/qa/764-final/campaign.mjs idle` and `node .ai/qa/764-final/campaign.mjs load`. Each invocation runs the documented ten-case selection serially in a fresh isolated checkout with private server/home/browser namespace. Load runs eight invocations concurrently in each of ten rounds. Browser sessions were sampled from the actual provider namespace, alongside host load/memory and global browser roots.

| Campaign | Tested head | Invocations | Case executions | Observed peak owned browser sessions | Peak host load (1m) | Minimum available RAM |
| --- | --- | --- | --- | --- | --- | --- |
| Idle | `06836933` | 10/10 passed | 100 | 2 | 2.52 | 38.87 GiB |
| Eight-task load | `8fb8920b` | 80/80 passed | 800 | 14 | 15.78 | 32.47 GiB |

Individual invocation durations were 29.984–44.250 seconds idle (median 39.577) and 28.878–61.275 seconds loaded (median 42.263). Eight lanes do not mean exactly eight browsers: the GitHub loading test temporarily owns two sessions. All 80 load startup diagnostic snapshots were retained. Campaign heads are explicit: the later virtual-history setup correction was validated with fresh focused repetitions and the complete four-lane suite, not claimed as part of the earlier campaign.

Earlier failed attempts are retained in the report sections above: recovery-header growth, provider textarea clearing, and virtual extent remeasurement each have reproduced red/green evidence. One earlier loaded fixture startup failed before browser creation; its original cause cannot be determined because that run discarded child output. Diagnostic capture was added without changing budgets; the subsequent 80-invocation campaign had no recurrence. This is an unresolved historical observation, not a claimed startup fix.

Durable parent evidence is in `764-parent-verification/`: full gate logs, four lane logs, campaign summary, reproducible orchestration source, and `campaign-evidence.tar.gz` containing setup/results, actual host/session samples, per-invocation logs and startup snapshots. The campaign script is a retained reproduction artifact; run it from its documented original `.ai/qa/764-final/` location.

## PR #773 CI package tick observation follow-up

Merged parent `fe27b00c098ed205f090d93d0b5954fb8ec665bb` normally as `ef36081d` (retained both report sections), and installed `npm ci` in this worktree before validation. Parent CI run `37022421007`, job `110888538147`, failed only the promotion reaping case at `application-update.test.ts:477`: `finalTicks` was `''`, while the staging case passed. The failing case ran 3021.8ms. The test had already established that the child was reaped before reading. Both child fixtures used `fs.writeFileSync(ticks, String(++n))` every 25ms, and the production owned-child code waits for `close` after SIGTERM / bounded SIGKILL escalation. A forced termination can interrupt the truncate/content seam of this fixture write; process reaping does not imply the last write completed.

Added a shared **test-only** tick writer that writes a sibling `.pending` file and renames a completed number into place. Both fake npm children use it; their interval, SIGTERM behavior, authoritative PID reaping checks, numeric final-tick assertion, recovery assertions and enclosing budgets are unchanged. No production change is needed for this demonstrated observation race. No application environment was started.

The new real-child regression commits tick 1, intercepts the next filesystem write at the truncation/content seam, emits an IPC observation, and blocks until its parent sends SIGKILL. The parent waits for `close`, proves the writer was reaped, and applies the same numeric assertion plus the stronger exact committed value `1`. Against the original direct-write implementation it fails with `actual: ''` (`764-ticks-red.log`); with atomic publication it passes (`764-ticks-green.log`). This deterministically proves the fixture can produce the CI symptom independently of readiness or production reaping. The exact interrupted syscall in the original CI run was not captured; the mechanism is reproduced rather than inferred solely from duration.

Exact focused validation from repository root:

```sh
npm ci
node --import ./scripts/test-git-env.mjs --import tsx --test packages/cezar/test/e2e/tick-writer.test.ts
node --import ./scripts/test-git-env.mjs --import tsx --test --test-name-pattern='SIGTERM-resistant|compromised|queued helper' packages/cezar/test/e2e/application-update.test.ts
npm test -- --run packages/web/src/test/e2e-wait-discipline.test.ts packages/cezar/src/application-update/npm-process.test.ts
npm run typecheck -w @wjarka/cezarion
git diff --check
```

Results: regression **1/1**; both reaping cases and three adjacent stale/compromised-lock cases **5/5**; scanner and npm-process units **37/37**; package typecheck and diff check passed. Evidence is `764-ticks-{red,green,package-green,units-green,typecheck,npm-ci}.log` alongside this report. The package cases ran against the parent build already present in this worktree; no production source changed. Parent owns CI rerun, full package gate and PR writes. No unresolved focused failure remains.

## Review follow-up: cancellable tick-fixture observation

The new tick regression's original bare IPC promise ignored test cancellation. Extracted its fixture lifecycle into `packages/cezar/test/e2e/tick-writer-fixture.ts` and made the observation reject on its supplied `AbortSignal`; the original regression supplies `TestContext.signal`. Settlement removes message/error/exit/abort listeners. Success and cancellation both send SIGKILL and await `close` under a separate 1000ms cleanup deadline, then remove the directory in a nested `finally`, even when reaping reports an error. The authoritative PID check remains before reading the final tick. Atomic publication and the original 5000ms enclosing test budget are unchanged.

A deterministic missing-observation case aborts upon the child's `spawn` event. Against the extracted original IPC wait, it fails with `cancellation did not settle` (`764-ticks-cancellation-red.log`); an independent bounded rescue kills the child and removes its directory during this red check. With signal-aware observation, it passes and directly proves the PID is gone and directory is absent. No elapsed delay triggers cancellation. This verifies the cancellation path used by node:test rather than assuming the enclosing test timeout unwinds arbitrary promises.

The original interrupted-write proof was rerun with only atomic publication temporarily replaced by the original direct write: the truncation case fails with the original empty-number assertion while cancellation passes (`764-ticks-cancellation-truncate-red.log`). Restoring atomic publication gives **2/2** (`764-ticks-cancellation-green.log`). Both real SIGTERM-resistant cases and adjacent lock cases pass **5/5** (`764-ticks-cancellation-package-green.log`); scanner/npm-process units pass **37/37** (`764-ticks-cancellation-units-green.log`); package typecheck and diff check pass (`764-ticks-cancellation-typecheck.log`). Exact commands are the same focused selection in the preceding section. No production code, interval, dependency or browser environment changed; no environment was started. Parent owns review and CI rerun.

Parent follow-up verification on `130643fa`: `npm run test:package` → 62/62 passed (including both new fixture regressions). Independent reviewer approved the atomic publication and cancellation follow-up; evidence `764-parent-verification/package-ticks-cancellation.log`.

## PR #773 CI worker-relationship theme setup follow-up

Merged parent `9955b401` normally as `f249c766` and ran `npm ci` in this worktree. Read the retained CI log and all three failure-bundle files before diagnosis: the 1440/dark case fails only `facts.theme` at line 147; screenshot and snapshot show light theme (`Theme: light. Switch to dark.`), with worker 32 focused, visible and a 44px target. The original artifact is retained in `764-worker-theme-ci-bundle/`.

The setting is **browser-local**, not an asynchronous workspace save: `ThemeProvider.setTheme` synchronously writes `cez-theme` through `writeStoredTheme`; density/width are the appearance values saved over HTTP. The affected test clicked the theme and immediately issued a hard `goto` through `open()`, without observing that the click reached the selected control, stored preference or applied root. A completed browser command alone was its ordering assumption. The original full spec passed 9/9 locally (`764-worker-theme-before.log`), so the uncontrolled CI event ordering is not claimed as locally reproduced.

For controlled red/green evidence, seed the previous light preference, gate the real dark button's click delivery, and release that event when the next stored-theme observation runs. This deliberately exposes the click/navigation ordering boundary without a sleep, request retry or production change. The original setup navigates away and discards the pending change, reproducing the exact theme assertion failure while the focus/geometry assertions pass (`764-worker-theme-red.log`, `764-worker-theme-red-bundle/`). With the correction, the localStorage read releases the pending event and the wait observes its actual commit before navigation; the same gated case passes (`764-worker-theme-gated-green.log`). The repeatable injection is retained as `764-worker-theme-event-gate.patch` against the pre-fix spec. It demonstrates the missing ordering guarantee; the original CI artifact has no event trace to establish the exact browser delivery sequence.

Final code changes only the setup for the four existing worker keyboard/viewport/theme rows: before hard navigation, wait for `localStorage.getItem('cez-theme')`, the chosen radio's `aria-checked` value, and the root's light class to agree with the requested theme. All injection code is removed. Exact downstream theme, focus, reduced-motion and geometry assertions and existing budgets remain unchanged. No helper, production code or baseline change.

Exact focused commands from repository root:

```sh
npm ci
env -u CEZ_AUTOMATIONS TMPDIR=/tmp TMP=/tmp TEMP=/tmp sh .ai/scripts/test-env-up.sh
env -u CEZ_AUTOMATIONS TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm test -- --config packages/web/e2e/vitest.config.ts worker-relationships.e2e.ts -t '1440x900 dark' --reporter=verbose
env -u CEZ_AUTOMATIONS TMPDIR=/tmp TMP=/tmp TEMP=/tmp npm test -- --config packages/web/e2e/vitest.config.ts worker-relationships.e2e.ts --reporter=verbose
npm test -- --run packages/web/src/test/e2e-wait-discipline.test.ts packages/web/src/test/poll.test.ts packages/web/src/components/theme-provider.test.tsx
npm run typecheck:web
sh .ai/scripts/test-env-down.sh
git diff --check
```

The filtered command is the controlled red/green pair above (1 failed, then 1 passed / 8 filtered). Final ordinary full worker-relationships spec passed **9/9** (`764-worker-theme-all-green.log`); adjacent scanner, bounded polls and theme-provider units passed **68/68** (`764-worker-theme-units-green.log`); web typecheck passed (`764-worker-theme-typecheck.log`). Environment bootstrap/install logs are `764-worker-theme-{up,npm-ci}.log`. Parent owns CI rerun and broad gates/campaigns. No unresolved focused failure remains.

Own environment stopped successfully (`764-worker-theme-down.log`); final diff check passed. The fixture's own browser/server cleanup completed in the focused spec.
