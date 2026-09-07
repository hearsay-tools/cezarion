# Owned workers acceptance and QA

Date: 2026-09-07. Issue #111. The five ordered gates and all eight issue-specific
browser cases passed. The full browser run remains failed on two separately
tracked baseline issues; publication and CI are pending. This file records the
actual results and their limits. The approved spec and implementation plan share this filename prefix.

## Environment and scope

Current main through `ab6d076a20a08146bfc1c614c64a442374f4fd61` (v0.11.10) was
integrated before final verification. The sole conflict preserves upstream
parent-turn-only activity recognition for both monitoring and owned worker waits.
The first full browser run accidentally reached the original repository and
its active runs; recovery autosaved the pending merge as `3e5b6fdf` at
2026-09-07 06:49:42 UTC. This was a fixture side effect, not an agent-issued
commit. The controller retained that tree and incident history; no guessed
run-store restore, branch reset or worktree replacement was performed.
No remote browser or user browser profile was used.

The packaged lifecycle installs the actual release tarball into a temporary path
containing spaces/apostrophes. It imports that installation's real RunStore,
RunManager, WorkspaceSemaphore and DelegationController, invokes its provisioned
absolute CLI with no `cez` on PATH, and runs a real ClaudeCliRunner child process
over wire-faithful stream-json. Only that external agent process is scripted.
The successful first targeted run took 5.6 seconds. Review assertions explicitly
set the existing `CEZ_REVIEW_GATE=1`; the shipped default remains off.

Browser prerequisite adaptation is confined to a disposable scratch PATH wrapper
around cached native agent-browser 0.36.0 and Chrome 151. Each real command uses
`TMPDIR=/tmp` and `AGENT_BROWSER_ARGS=--no-sandbox` because this container's
inherited temporary path exceeds Chromium's Unix-socket limit and its sandbox
cannot launch. Doctor runs native `--offline --quick` cached checks followed by
an actual unique-session open/get-url/close live probe. These replace the native
doctor's failing network/built-in-launch probes. No descriptor or suite marker is
fabricated. `skills get core` is unavailable in the native cache (no skills
directory); the repository's provider instructions and actual command interface
are used. This is prerequisite evidence, not an application pass.

## Browser containment incident

The first `npm run test:e2e` ran from 06:49:36–06:54:15 UTC. Its existing
quick-list main/wide/empty fixtures used non-Git temporary folders below the
inherited task TMPDIR in the original Git checkout. CLI Git discovery therefore
selected the original repository before any browser assertion. The first API
check saw 99 original runs instead of six fixture records. One quick-list file
executed (23 failures, one pass); 35 more files failed import after their temporary
Vitest cache disappeared. This is a diagnosed isolation failure, distinct from
historical broad-suite ENOENT/EISDIR diagnostics.

Controller investigation found spurious restart/resume events for four active
runs, including this worktree's active-writer refusal and autosave merge. It
recorded and terminated 30 documented fixture-owned processes (eight OpenCode
servers and their descendants) using process identities and pidfds, then verified
no matching accessible processes remained with the three incident fixture homes. The original index retained
99 records, all four active worktrees/temp folders remained, and no incident-window
worktreeReclaimedAt was persisted. No successful browser run mutation was evidenced:
rename and pin failed before their controls. Startup/shutdown can independently
write state, so that is not a claim that the incident had no other effects.
Without a complete pre-incident state snapshot, exact last-writer attribution and
all transient changes cannot be reconstructed. Evidence remains in the Task 9
containment audit, process inventory, original-state/index and recovery-event logs.

Remediation is a shared **pre-spawn** fixture guard: canonicalize the fixture path,
remove inherited/caller Git environment redirection, run Git discovery under that
same child environment, accept only its own Git root or a confirmed non-Git root,
and reject uncertainty or an ancestor repository before Cezar starts. Every direct
browser fixture boot now uses it (queued-stack was the sole bypass). Five tests
exercise the guard without booting Cezar, including a non-Git child of disposable
Git, ordinary own-Git/non-Git, aliases, redirected Git and unavailable discovery.
All subsequent test processes also pin TMPDIR/TEMP/TMP to `/tmp`. The production
CLI's repository-discovery behavior is unchanged.

## Acceptance matrix

Paths below are under `packages/cezar/src` unless prefixed otherwise. Named tests
are executed by the full Vitest gate, not inferred from source presence alone.

| Approved requirement | Actual evidence |
| --- | --- |
| Complete parent lifecycle | `packages/cezar/test/e2e/delegation.test.ts`: “installed CLI completes owned-worker lifecycle with lost spawn reply and one slot”. Actual spawn acceptance with ignored first reply, exact replay after parent HEAD moves, committed baseline/dirty exclusion, queued child at maxParallel=1, immediate wait registration, yield/admission, inspect, attributed steer, worker review/parent wake, worker-only diff, stop, checked destroy/repeat, worktree/registration/branch absence and retained review/history. |
| Server-derived identity and no secrets | `delegation/credentials.test.ts`: independent tokens, invalid/altered token, rotation, revocation, close. `delegation/policy.test.ts` operation matrix: copied Caller, wrong project, unrelated root, worker, missing/malformed owner, persisted grants and lifecycle. `delegation/routes.test.ts`: strict forged identities/JSON/query, scope rejection, origin/Host guards and no cockpit authority. Installed lifecycle checks public records/events contain no generated credential. |
| One generation, ownership, finite limits | `delegation/policy.test.ts`: all operations denied to workers even with elevated persisted permissions; `delegation/service.test.ts`: “caps accepted creations at 32 including destroyed workers; replay does not consume a creation”, replay across moving HEAD/restart, and 33rd undelivered input rejection. |
| Committed isolation and attributed diff | `delegation/workspace.test.ts`: parent HEAD excludes dirty edits without autosave; named-ref movement; non-Git/foreign/bad refs; collisions and private marker/receipt substitution; real manager creation fails before agent launch with no root fallback; worker commits/dirty/ignored files, changed branch, bounded truncation and unavailable resources. Installed lifecycle independently checks committed content and parent-only edits. |
| Capacity, wake and recovery | `workflows/worker-wait.test.ts`: “releases only on yield and admits a live wake behind already queued work”; all terminal outcomes before register/park; 32 outcomes; finite deadline without cancelling a child ask; registered execution retains capacity; every recovery phase and identified duplicate delivery; scheduler fairness; durable Finish and cancelled-intent recovery. Both fresh/continuation handlers use the same wait/ask/input decisions. |
| Safe destruction and crash ambiguity | `workflows/worker-destroy.test.ts`: queued/startup/live/parked paths, ignored SIGTERM, concurrent waiters, session result plus pending bookkeeping, periodic autosave/check-process barriers, unknown/stale/private completion, destruction guards and explicit retry. `delegation/workspace.test.ts`: moved/symlink/replaced/locked resources, branch checked elsewhere/tip changes, partial checkpoint replay and missing receipt denial. `delegation/service.test.ts`: serialized retry, unknown termination incomplete, exact remaining resources and retained tombstone. |
| All four runners preserve human answers | `core/harness-parity.test.ts`: S11/S12 and R6–R11 run through real Claude/Codex/OpenCode/pi runners with their offline wire fixtures. Before/during/after asks, native acknowledgement, queued/startup/restart/Continue, refused human delivery, delayed reply plus DONE and post-send checkpoint failures. The executable matrix rejects skipped/pending cells and permits only declared wire limitations. |
| Default off, inherited env, degraded provisioning | `delegation/provision.test.ts`: no listener/ordinary metadata off; failed listener leaves ordinary runs unprovisioned; invalid metadata never promoted; all runner environments. `core/agent-env.test.ts`: all four backends strip inherited URL/token under full and passthrough modes, then merge only controller-generated values. `delegation/provision-workflows.test.ts`: ordinary native Claude off/Continue guard; controller close revokes without terminalizing; lazy projects provision before recovery. |
| Supported execution identity across constructors | `delegation/provision-workflows.test.ts`: queued/restart/Continue keep accepted account after registry deletion/repoint, native versus explicit/named Claude layout, same-directory override and changed-HOME refusal, actual merged environment, missing/malformed private evidence/home, model/effort locks and supported provider limits. `workflows/run.ts` has both ActiveRun construction sites, both call shared account preparation/provisioning and hydrate pending asks; recovery launches through these paths. |
| Persistence/quarantine, termination versus shutdown | `runs/delegation-state.test.ts` validates optional legacy metadata, malformed authority quarantine, atomic ownership/receipts/private evidence and failed-write no-publication. `workflows/worker-wait.test.ts` covers parent cancelled/failed/review/done cascade separately from disposal and late callbacks; waits/children survive shutdown. |
| Human deletion and retention | `server/delegation-cleanup.test.ts`, `server/worktrees-api.test.ts`, `workflows/worker-destroy.test.ts` and `delegation/workspace.test.ts` cover off-mode human cleanup, malformed body no mutation, blocked continuation/rematerialization/deletion, missing parent receipts and protected orphan resources. `runs/store.ts:canDeleteRun` scans both receipts and actual children; worker/invalid history is retained. `runs/retention.ts` excludes owned/invalid resources at every reclaim entry. |
| HTTP contract and inventory | `server/contract-parity.delegation.test.ts` checks both directions and scoped/boot aliases; `server/run-relationships.test.ts` reads complete archived ownership with strict params/query; `server/runs-index-api.test.ts` verifies slim role/wait projection; typed bodies, route parity, version surface and `bc-route-inventory.test.ts` run in the full suite. API-client re-exports schemas; service runtime does not import it. |
| Current human ask across compact/paginated history | Existing ask schemas moved unchanged to the Node-free contract and re-exported from core. One pure pending-ask reducer is shared by manager delivery, compact producer and current cockpit attention. Compact context retains only the latest valid pending question; only its matching successful human-delivery receipt retires it. Separate visible/current tests cover refused attempts, stale receipts, agent input and answered/old history; legacy transcript rendering remains unchanged. Real browser asserts header and dock as well as visible question. |
| Cockpit | `packages/web/e2e/worker-relationships.e2e.ts` is discovered by the existing `*.e2e.ts` include. Actual browser observations and suite outcome are recorded below after execution. Component/cache tests cover query errors/retry, durable IDs, ask priority, attribution, all four tabs, full 32-worker list and all local/global/palette consumers. |

## Verification and observed failures

Exact commands, stdout/stderr and exit codes are retained under
`.superpowers/sdd/2026-09-06-owned-workers-isolated-worktrees-plan/native-task-9-*`.

- First targeted package attempt correctly settled the worker to `done`: its new
  fixture had omitted the existing review opt-in. Its teardown also called the
  worker-only termination barrier for the root, masking the first assertion and
  leaving the controller open. Wire/events were preserved; fixture setup and
  teardown were corrected. No product behavior or timeout was changed.
- First ordered typecheck failed on a duplicate observation key in the new browser
  test. The duplicate key was renamed; all later gates were withheld.
- First integrated full Vitest run: 364 files/7,436 tests passed, one test failed.
  The old autosave-gate fixture still invoked private `armAutosave(state)` after
  Task 6 added its run-ID argument. Both production call sites were correct.
  Updating the test seam and passing the actual fixture ID gave 6/6 focused
  passes. No production autosave mechanism changed.
- Existing broad-suite ENOENT/EISDIR diagnostics are preserved. The previously
  recorded OpenCode ten-second waits are not relabeled as a proven startup bug
  or fixed by a blanket timeout change.

The ordered `boundedfinal` gate logs, before review correction I1, record:

| Command | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm test -- --maxWorkers=2` | exit 0; all 366 files, 7,456 tests; 472.48 seconds |
| `npm run test:unit` | exit 0; 37 service tests and 60 repository-script tests |
| `npm run build` | exit 0; packaged cockpit/contract checks passed |
| `npm run test:package` | exit 0; 24 tests, including the installed complete lifecycle |

The intervening `accepted` typecheck stopped before later gates: the schema move
needed a remaining Zod type-only import and an import insertion had also matched
a repeated constant in a function call. Both local mistakes were corrected;
60 affected tests passed before restarting the complete ordered gates above.

The new fixture guard failed five tests without its fix. Compact-context/attention
regressions failed eight assertions without the producer/consumer correction.
Exact source restoration and SHA-256 hashes are recorded in the source-removal
logs; 274 affected tests then passed, including all 65 worker-wait lifecycle
cases and the existing strict ask-schema and legacy transcript tests.

## Actual browser observations

Focused final browser run: **8/8 passed**, exit 0, 14.09 seconds. This uses native
Chrome against the rebuilt application and guarded real fixture server. It does
not substitute component classes or a synthetic suite marker for browser evidence.

| Observation | 1440×900 light/dark | 360×640 light/dark |
| --- | --- | --- |
| All 32 links reachable with actual Tab presses | yes | yes |
| Last link visibly focused within sticky-header/list viewport | yes, y328–372 | yes, y241–285 |
| Smallest worker link target | 44px | 44px |
| List scroll at last link | 1304px | 1836px |
| Horizontal page overflow | none | none |
| Actual reduced-motion media preference | enabled | enabled |

All four Session/Changes/Commits/Files routes retained every project-scoped worker
link, including archived records and incomplete cleanup. Enter followed the last
worker and its loaded parent link. Unavailable parent and successful empty state
remained distinct. Loading/503 errors retained known IDs; actual browser network
offline paused retry and reconnect fetched real relationships. Global Tasks and
the cross-project palette showed Worker labels and matching parked-root status.
The visible structured human question and attributed agent input remained intact;
the actual header said **needs you**, and the composer dock said **waiting for
your reply**. The relationship strip continued to describe the outstanding wait.

Inspected screenshots: `workers-1440-light.png`, `workers-360-light.png`,
`workers-360-dark.png`, `workers-preserved-ask.png`, `workers-offline.png`; the
fourth theme screenshot is also saved. Source artifacts and exact metrics live in
`.ai/qa/artifacts_e2e/`; a definitive copy from the focused final run lives in
`native-task-9-browser-focused-artifacts/` under the Task 9 evidence directory.
The fixture log names only `/tmp/cezar-e2e-relationships-*` and its two deliberate
waiting seed records; the fixture server was stopped and its root removed.


## Full-browser failure diagnosis and corrections

The first contained full run (`native-task-9-browser-full-verified.log`) failed:
36 files, 26 passed/10 failed; 207 tests passed, 17 failed, six conditional skips.
It is retained as failed evidence. The current fixtures had stale assumptions
against main: the agents dock starts collapsed, Pi is the fourth runner, Agent
accounts is the sixth settings page, per-project GitHub navigation requires that
project's remote, and GET config includes effective model defaults. Tests now
use the real dock expansion control and current explicit IDs/default baselines.
Route, queued edit and settings save assertions wait for the rendered committed
state (including enabled input) before the next action; an API acknowledgement
alone does not establish React settlement. Progressive history waits for its
scheduled anchor frame before retaining the same two-pixel assertion. The long
agent sheet scopes its viewport to the sheet and expands its actual collapsed
tool streak before checking real overflow. No product defaults were changed.

The 1,000-row thread fixture now explicitly exercises the supported full-replay
fallback by returning 404 for only the optimized history request at the browser
boundary. Its real server/SSE, 1,003-row count, virtualization/DOM comparison,
width, jump and saved-offset assertions remain. The separate progressive-history
suite continues to exercise real default pagination.

That accurate fixture exposed a genuine fallback Jump bug. Resetting the failed
optimized query briefly unmounted the transcript and restarted replay, discarding
its current scroll intent. Runtime captures showed the fully replayed transcript
at top=0 after Jump, and a later restored offset displaced from the saved point.
`useRunHistory.jumpToLatest` now leaves an established full replay and live SSE
intact; ordinary paginated Jump still resets/reloads. Two hook regressions fail
with the old source, verify no pending transition/event loss/SSE restart, and
preserve following live events. Exact removal/restoration hashes are retained in
`native-task-9-fallback-jump-source-removal.log`; 17 affected tests and all seven
restored hook tests passed. After rebuilding, the actual native browser passed
all ten dock/scroll tests, including the unchanged saved-offset tolerance:
`native-task-9-browser-scrolls-fallback-fixed.log`, exit 0. Earlier failed captures
are preserved separately; the empty loading geometry was never accepted as a
successful jump.


The next full run (`native-task-9-browser-full-finalaccepted.log`) passed 35 files
and 219 tests, but failed the five dependent plan-mode cases (six conditional
skips). The exact first stack is the initial mode toggle's `aria-checked=true`
wait, before typing or any plan POST; the later overlay/save/start failures
cascade from it. It was initially inferred from the case title to be a submission
failure; the complete stack disproved that inference. Two focused runtime
captures then passed all five cases and showed pointerdown/click targeting the
actual mode button with false→true selection. The second capture preserved the
original number of browser round trips before clicking. No mode hydration/reset
or disabling branch was found in the source, and plan-mode uses its own fresh
fixture server. The original intermittent toggle cause remains **unconfirmed**.

The fixture now requires an existing, loaded source pill and editable composer
before the first mode click, then accepted text and an enabled submit control.
Its prior optional-chain predicate could pass without a source element. This is
an explicit valid readiness precondition, not a proven production fix for that
intermittent failure. Pointer/DOM/request metadata and the own-server log are
retained; no retry/reclick, forced toggle state, new sleep or timeout increase was
introduced. All original plan/chain/mobile/reorder/start assertions remain.


A subsequent ordered run (`native-task-9-gate-2-releasecandidate.log`) stopped
at 7,449 passed/seven failed tests: six five-second fixture timeouts across
provisioning, the 32-worker cap, autosave termination and worker waits; one
OpenCode wait for a question reply. The exact seven cases then passed together
in 8.58 seconds. Process/load evidence was captured; concurrent work was left
untouched. The six Git/lifecycle timeout causes remain unconfirmed; focused
success is not proof that resource contention caused every failure.

The OpenCode case had a demonstrable fixture ordering race: it waited for the
mock to receive GET /question, then sent the answer before the runner had
necessarily consumed that response and published ask.requested. A 75ms delayed
mock response makes the old precondition fail immediately with no question
published. The corrected precondition waits for the actual runner question,
retains the GET-count assertion, and exercises the original delayed reply,
queued prompt and auto-end behavior. All 44 OpenCode tests passed; removing only
the corrected wait reproduces RED, exact bytes/SHA are restored, and the case
passes again. This changes test ordering only, not runner semantics or timeouts.
It is distinct from historical unresolved OpenCode startup waits.

The controller approved `npm test -- --maxWorkers=2` for the final full test
gate on this shared host (12 detected CPUs, no existing configured worker cap).
Every project, test, assertion and original timeout remains enabled. The other
four gate commands are unchanged; no repository concurrency setting was added.


Independent Task 9 source review found one additional fallback attention boundary:
`ThreadView` excluded full-replay fallback from the canonical pending-ask scan.
That let a refused user-message bubble clear current attention, and let a matching
successful receipt leave it pending. The correction uses canonical currentEvents
whenever history is supplied, including full replay; only callers without history
retain the existing compatibility inference. Six fallback cases now mirror the
separate current/visible-history cases: pending, refused attempt, stale receipt,
agent input, matching receipt and old history. Two fail with the old source;
152 affected tests pass, exact source removal reproduces RED, and exact restoration
passes all 12 attention cases. Legacy transcript rendering and wire shapes stay
unchanged. The preceding boundedfinal gates/browser concern the build before this
review correction; fresh final results are recorded separately below.


The complete `boundedfinal` browser run passed: 36 files, 224 tests, six existing
conditional skips, 357.11 seconds; actual `TEST_E2E_STATUS=passed`, exit 0.
This is explicitly **before review correction I1**. All eight new relationship
cases and all five plan-mode cases ran and passed. The six skips are enabled-only
automation/inbox coverage (one automation, three inbox, one smoke inbox badge)
and the mutually exclusive single-project navigation case in a multi-project
fixture. They are not counted as passes. All 120 artifact files were copied with
mtime/SHA metadata to `native-task-9-browser-pre-fix1-artifacts`; timestamps
separate this run's outputs from older retained failure captures.


The post-I1 `fix1final` ordered run passed typecheck, then stopped at the full
unit gate: 7,460 passed/two five-second timeouts in worker-wait restart fixtures
(Finish with review=true; preserving a delegated ask across restart). Later gates
were withheld. A temporary diagnostic copy, removed in finally with the original
source hash unchanged, passed both cases in 2.989s/3.772s. Recorded phases show
worker planning at 11–12ms; initial mock ask playback about 1.75s, and the second
case's human continuation another 1.78s. This describes the successful capture,
not the unknown timeout phase in the failed run. No timeout or production change
was made from that evidence. Further full retries were withheld while the
controller consolidated whole-feature review findings.

The owned shared QA server PID3950450 (canonical worktree/argv verified) was
stopped using `.ai/scripts/test-env-down.sh`, exit 0, TEST_ENV_STATUS=stopped.
Its descriptor/log and all preceding browser artifacts were preserved. A future
final browser run must boot a fresh guarded fixture after the review changes.

At that earlier checkpoint, consolidated review corrections and subsequent
verification remained pending. The final results appear below; publication and CI
remain controller-owned.


### Consolidated whole-feature findings wave

The independent whole-feature review found three blocking defects after the prior
Task 9 source review. The corrected source now refuses to rotate unknown worker
execution evidence, retains independently validated private accepted tool/Bash
grants, and holds nonfinal agent steps through admitted worker wakes. Unknown
owned execution also preserves scratch across startup sweeps and direct manager
teardown; proven completion remains the cleanup boundary. No public option,
transport field or ordinary legacy fallback was added or changed.

Regression evidence is retained in `native-final-wave-*.log` under the private
Task 9 workspace. The reviewed source produced 17 C1/I2 behavioral failures and
six I1 failures (all four actual runner wires plus both multistep shapes); the
ordinary no-wait chain passed. Source removal against the exact reviewed tree
later produced 31 failing cases with four guards passing, followed by exact
byte restoration. The corrected focused set passed 36 cases, including late
registration after timer arming, same-session capacity accounting, unexpected
session close, and portable human-ask precedence. A separate source-removal
proof covers that final ask correction.

The first broader affected run passed 301 cases and failed three worker-wait
fixtures: two five-second timeouts and a proven fixed-delay registration race.
The race fixture now gates the actual offline Claude result until all seven real
Git workers exist. A focused diagnostic run passed the 32-worker bound case
(1.69s), controlled registration (0.31s), and parked-deadline recovery (2.84s).
The timeout causes remain unconfirmed; bounded phase/run/event capture is kept
for recurrence. No test timeout or product timer was increased. One attempted
late-case test filter matched zero cases; its skipped log is retained and is
not a pass claim. Later `nonfinal` runs executed both actual late cases.

All earlier five-gate and full-browser passes remain evidence for earlier trees.
The scoped review found C1/I1/I2 addressed with no introduced findings; final
acceptance still requires the corrected-tree gates and actual full browser.
Publication and CI remain controller-owned and pending.

### Final integration-fixture diagnosis and budgets

The first corrected full run passed 7,484 tests and failed 15. One injected
deadline-write fault also outlived its assertion phase and surfaced an EISDIR
against the preceding fixture during a later case. Failed logs are preserved.
Two persisted-human-answer restart tests depended on cancelling an invocation
before normal mock playback completed. They now use an explicit offline Claude
wire response gate: the actual runner receives the human input, cancellation
precedes its reply, recovery re-admits it, and releasing the reply produces the
single matching receipt. The deadline fault and registration cases similarly
wait for the actual first-input handshake. All four focused cases passed;
ordinary mock defaults and product behavior remain unchanged.

A subsequent full run with `npm test -- --maxWorkers=1` passed 7,491 tests and
failed eight, across 362 passing and four failing files (1,034.22s). All eight
failures hit the outer five-second test limit; one also hit the ten-second
cleanup-hook limit. One synchronous worker creation alone took 9.37s, and the
32-worker durable cap case took 11.6s. Other original failure phases remain
unconfirmed. Accessible process scans after both runs found no matches for their
documented fixture roots. Reducing concurrency did not eliminate the failures.

One approved diagnostic run of those eight cases used a 30s outer allowance
while retaining every existing 15s state/termination assertion, real Git/fsync,
runner and product timer. All eight passed with no cleanup errors. The nonfinal
agent→check capture observed the actual auto-end veto while parked, admitted
wake with the parent counted, real reply clearing the wake marker, permitted
auto-end and next-step start. This demonstrates that invocation's behavior;
it does not reconstruct the original timeout or establish a performance fix.
Temporary instrumentation was restored byte-for-byte and its logs/hashes kept.

The controller then approved explicit 30s integration envelopes for the
worker-wait and worker-destroy real-manager suites and their process cleanup,
plus only the three named 32-creation cases in service, store and relationships
tests. Their existing 15s state/termination bounds, actual 250ms auto-end checks
and all semantic assertions remain. Repository-wide, schema and unit defaults
are unchanged. Failure snapshots now copy their checkpoint arrays. This narrowly
supersedes the earlier unchanged-timeout execution policy; it does not attribute
every historical timeout to load or weaken durability to accelerate fixtures.

Final ordered gates all passed on the corrected source (logs use suffix
`wholewaveintegration`):

| Command | Actual result |
| --- | --- |
| `npm run typecheck` | Exit 0 |
| `npm test -- --maxWorkers=1` | Exit 0; 366 files, 7,499 tests; 943.88s |
| `npm run test:unit` | Exit 0; 37 service and 60 repository-script tests |
| `npm run build` | Exit 0; compiled cockpit/contract and pack checks |
| `npm run test:package` | Exit 0; 24 tests, including the installed delegation lifecycle |

### Final browser outcome and separately tracked baseline failures

The actual guarded `npm run test:e2e` exited 1 with
`TEST_E2E_STATUS=failed`: 34 files passed/two failed; 222 tests passed/two failed,
six existing conditional skips; 349.98s. It is **not** reported as a full-browser
pass. Under the user's instruction to keep existing fixes and focus further work
on #111, these unrelated failures were investigated and filed separately:

- [#136: Repo Git test assumes a flat diff DOM](https://github.com/wjarka/cezar/issues/136).
  Actual API and UI totals both showed 45 changed files, with all paths in the
  tree, while the existing virtualized renderer mounted one visible file card.
  The test waited for 45 DOM cards. Baseline source/history and native-browser
  DOM/API/screenshot evidence support the attribution; no correction was added.
- [#137: Progressive-history anchor investigation](https://github.com/wjarka/cezar/issues/137).
  The identical 10,378-pixel failure predates this task's two existing post-page
  animation-frame lines. Production scroll files match main, and this default
  paginated case does not call the changed fallback Jump path. Exact fixture
  timing versus preexisting product behavior remains unconfirmed. No further
  scroll correction, tolerance change or broad retry was made.

The direct final issue-specific command,
`npm test -- --config packages/web/e2e/vitest.config.ts worker-relationships.e2e.ts`,
passed **8/8**, exit 0, 23.64s. Fresh real screenshots were inspected at
1440×900 and 360×640 in both themes: the final worker has a visible keyboard
focus ring below the sticky header, minimum target height 44px, no horizontal
overflow and reduced motion enabled. All four tabs retain 32 scoped links;
actual list scroll was 1304px desktop/1836px mobile. The question header says
“needs you” and its dock “waiting for your reply”; attributed agent input remains
separate. Loading/error/offline keep known IDs, real retry/reconnect succeeds,
and global Tasks/palette statuses match the local view.

The full run's 120 artifacts are retained with mtime/SHA metadata in
`native-task-9-browser-final-artifacts/`; its manifest belongs to the failed
aggregate run. Definitive focused screenshots/observations/server log are in
`native-task-9-browser-issue111-final-artifacts/`. Four generated historical
screenshots were preserved privately and restored to their verified baseline.
The shared fixture PID236236 was rechecked by start ticks, cwd and CEZ_HOME,
then stopped with `.ai/scripts/test-env-down.sh` (exit 0,
`TEST_ENV_STATUS=stopped`). The final accessible-process scan found no shared
QA-home or `/tmp/cezar-e2e-*` home matches. No real Cezar instance or unrelated
process was stopped. Final review disposition, commit, draft PR and CI remain
controller-owned.
