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
