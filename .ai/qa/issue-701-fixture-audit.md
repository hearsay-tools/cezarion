# Issue hearsay-tools/cezarion#701 fixture ownership audit

Scope: all 42 files containing `new RunManager` at the implementation base (`git grep -l 'new RunManager' HEAD -- '*test*.ts'`), including shared testkits and packaged CLI tests. Construction sites within each file, replacement/recovery managers, teardown hooks, and repository initialization were inspected. Only test/testkit files change.

## Evidence and semantics

[CI job 109621552805](https://github.com/hearsay-tools/cezarion/actions/runs/36631457622/job/109621552805) reports **5375 passing tests**, then `model-identity-wiring.test.ts:61` fails in afterAll with ENOTEMPTY. The newer deletion retries hide that ownership race.

PR hearsay-tools/cezarion#400 (`29c53964d950655adcf115eb5211b25d6e0c6472`) established drain → dispose/flush → rm and disabled Git background maintenance. Its `awaitRunTermination` helper ignored the returned boolean. Today that API only proves delegated worker execution; ordinary root runs return false immediately. `dispose()` intentionally does not terminate sessions. Continuations can remain parked indefinitely. Status alone is therefore insufficient.

The shared test-only factory observes real `pump`, `execute`, `runContinuation`, `recordTurnEnd`, autosave, naming, retention, worker-finalization, detached Finish settlement and queue-rescue promises plus returned session closure. It preserves the original return values and production failure handling. Teardown cancels admitted work once, interrupts remaining sessions (including sessions of disposed/replaced managers), waits for owned promises, then disposes and flushes every store. A bounded ownership timeout fails without removing the directory. Synthetic private active entries in unit tests are not process-ownership evidence. No production API or runner behavior changes.

## Site-by-site audit

Paths below are relative to `packages/cezar/`.

| File | Finding and disposition |
| --- | --- |
| `src/core/harness-parity.testkit.ts` | driveRun root fixture only awaited isActive=false, lacked manager disposal and could leave naming/bookkeeping outstanding: now tracks/drains and disables unrelated naming. withOwnedInputRun already waits worker ownership and tracked turn bookkeeping, then disposes/flushes. Disabled maintenance in both initializers. |
| `src/delegation/destruction-results.test.ts` | Replacement managers registered with shared root teardown; fixture close owns final disposal/removal. |
| `src/delegation/input.test.ts` | Eight standalone constructor sites use deliberately synthetic sessions/state, including two recovery managers with scheduler admission held. ACK promises are explicitly settled; cleanup disposes managers, flushes stores and restores real timers before removal. No service-fixture teardown exists here. Retained raw constructors: registering these managers with the shared factory without calling its drain leaked registrations. |
| `src/delegation/provision-workflows.test.ts` | Recovery managers share the service fixture root. Registered all replacement managers; checked worker termination remains before dispose and service close drains root execution too. |
| `src/delegation/routes.test.ts` | Replacement manager registered with shared root teardown; fixture close owns final disposal/removal. |
| `src/delegation/service.test.ts` | Replacement/recovered managers registered with shared root teardown; fixture close owns final disposal/removal. |
| `src/delegation/service.testkit.ts` | Shared fixture now tracks every manager, cancels workers, rejects false termination results, drains root/continuation/bookkeeping promises, then disposes/flushes before removal. Existing maintenance settings retained. |
| `src/delegation/workspace.test.ts` | Dispose alone did not establish ownership completion; now drains before disposing stores/removing roots. Disabled Git maintenance. |
| `src/server/provider-action-gating.test.ts` | Live mixed-backend fixture cancelled without awaiting completion. Registered real managers and drain before env restoration/removal. Earlier route-only fixtures have no live manager work. |
| `src/server/repo-branches-api.test.ts` | Routes await their Git operations; Continue is rejected under a reclaim claim. No launched sessions. Existing dispose/flush retained; disabled Git maintenance. |
| `src/server/start-run-idempotent.test.ts` | No Git repo and maxParallel=0; all work stays queued. Existing dispose/flush clears admission before removal. No changes. |
| `src/server/worktrees-api.test.ts` | Some route tests admit Continue just before returning. Registered manager and drain before removal; synthetic active state used for reclaim refusal has no real pending work and is cleared by dispose. Disabled maintenance. |
| `src/task-cli/cockpit.testkit.ts` | No Git repo and maxParallel=0; HTTP socket closes, manager disposes and store flushes before removal. No changes. |
| `src/workflows/agent-profile-wiring.test.ts` | Direct profile resolution has no sessions, but manager sampler/subscriptions lacked disposal. Shared drain/dispose/flush now owns cleanup; no Git repo. |
| `src/workflows/agent-tmpdir.test.ts` | Captures returned specs while real continuation/start prologues can remain. Registered initial and recovered managers and drain before home/repo removal. No Git repo. |
| `src/workflows/auto-resume.test.ts` | Terminal status does not imply completion; replaced retrying rm with tracked drain across initial/recovered managers. Disabled Git maintenance. |
| `src/workflows/autosave-gate.test.ts` | Tests clear timers, but manager subscription was not disposed. Drain/dispose/flush before removal; disabled Git maintenance. |
| `src/workflows/check-stop-kill.test.ts` | Successful cases await isActive=false, but failure cleanup removed roots directly. Shared drain handles all outcomes; disabled maintenance and unrelated LLM naming. |
| `src/workflows/codex-startup-cancel.test.ts` | Releases held startup, cancels all runs and waits isActive=false before dispose/flush/removal; cancellation precedes any turn, so no turn bookkeeping exists. No Git repo. No changes. |
| `src/workflows/continuation-tools.test.ts` | Captured specs/terminal records can precede final writes. Registered ownership and replaced nested rm retries with drain then one rm. Disabled maintenance. |
| `src/workflows/continue-unarchive.test.ts` | A fixed 30ms post-dispose sleep was not a completion barrier. Release held mock session, drain tracked work and remove; no Git repo. |
| `src/workflows/cursor-bootstrap-continue.test.ts` | Captured specs/terminal records can precede final writes. Registered ownership and replaced nested rm retries with drain then one rm. Disabled maintenance. |
| `src/workflows/delegation-integration.test.ts` | Already releases/cancels, awaits real execute/runContinuation and recordTurnEnd promises, then disposes/flushes/closes controller before rm. Kept drain; disabled maintenance. |
| `src/workflows/delegation-reconcile.test.ts` | Pure persisted-state reconciliation; no startRun, runner or continuation. Existing dispose/flush before rm is sufficient. No Git repo. No changes. |
| `src/workflows/model-identity-wiring.test.ts` | Continuation tests intentionally leave root sessions parked. Now uses tested removeFixtureRepo: stop sessions, drain actual owned promises, dispose/flush, then single rm. Removed retries; disabled Git maintenance. |
| `src/workflows/pasted-attachments.test.ts` | Terminal-status waits and a finally block could remove a still-owned root even after wait failure. Registers replaced/recovered managers; releases gates and drains before removal, which is no longer in finally. Disabled maintenance. |
| `src/workflows/pi-teardown.test.ts` | Both start and continuation explicitly await isActive=false after provider failure; no completed turn bookkeeping. Existing dispose/flush retained; disabled maintenance. |
| `src/workflows/prelaunch-cancel.test.ts` | Releases held setup, cancels all runs and awaits isActive=false before dispose/flush/rm; no turn can occur before the tested cancellation. No Git repo. No changes. |
| `src/workflows/pump-repo-cache.test.ts` | Every explicitly invoked pump/probe is awaited; maxParallel=0 prevents sessions. Existing dispose/flush before rm sufficient. No Git repo. No changes. |
| `src/workflows/recover-autonomous.test.ts` | Frozen scheduler means no sessions, but initial anonymous recovered managers were not disposed. Register all managers and drain/dispose before removal. Disabled maintenance. |
| `src/workflows/recover-followups.test.ts` | Frozen scheduler means no sessions, but anonymous recovered managers were not disposed. Register all managers and drain/dispose before removal. Disabled maintenance. |
| `src/workflows/recover-session-failure.test.ts` | Registers both recovery managers, retaining ownership after explicit disposal; drain before rm. Disabled maintenance. |
| `src/workflows/retention-wiring.test.ts` | Terminal status/checkpoint can precede final work; tracks retention and execution work before dispose/flush/removal. Disabled maintenance. |
| `src/workflows/run-isolation.test.ts` | Status-only waits did not cover final work/failure cleanup; registered all managers and drain before rm. Disabled maintenance and unrelated LLM naming. |
| `src/workflows/run-lease.test.ts` | Status-only drain omitted detached bookkeeping and store flush. Shared tracking drains execution, retention and naming before dispose/flush/removal. Disabled maintenance and unrelated LLM naming. |
| `src/workflows/run.test.ts` | All construction sites (including replacements and inline variant fixture) registered. Every root-removing hook now drains before env restoration/removal. Synthetic private active/starting entries own no real promise; disposal clears them. Disabled maintenance and unrelated naming. |
| `src/workflows/stopped-composer.test.ts` | A fixed 30ms post-dispose sleep was not a completion barrier. Releases held mock session, drains tracked work and removes; no Git repo. |
| `src/workflows/system-prompt.test.ts` | Terminal status and captured wire observations can precede final writes. Both fixture groups track and drain ownership before rm. Disabled maintenance. |
| `src/workflows/worker-destroy.test.ts` | Already releases barriers, cancels, awaits captured executions and isActive=false (which includes worker session/turn/delivery ownership) before dispose/flush/rm. No lifecycle changes; disabled maintenance only. Unrelated hearsay-tools/cezarion#515 behavior unchanged. |
| `src/workflows/worker-wait.testkit.ts` | Already cancels and awaits execute/runContinuation and recordTurnEnd before dispose/flush/rm. Kept mechanism; disabled maintenance. |
| `src/workflows/workspace-semaphore.test.ts` | Status wait swallowed timeout and missed replaced manager ownership. Opens every held check gate, then shared drain replaces the status wait and tracks all managers for each root. Deliberately nonresolving continuation stubs perform no subsequent writes and replace the tracked method. Disabled maintenance in both initializers. |
| `test/e2e/delegation.test.ts` | Packaged CLI: awaited child process exit in first case; second already cancels, asserts worker termination=true, awaits execution/turn promises and closes controller before rm. Kept drain; disabled maintenance in both initializers. |


Additional affected consumer: `delegation/conversation-service.test.ts` must restore its deliberately stubbed cancellation before shared cleanup; otherwise a false worker termination proof now correctly fails teardown. `delegation/service.testkit.test.ts` also no longer catches leftover removal errors.

## Regression evidence

`npm test -- packages/cezar/src/workflows/fixture-cleanup.test.ts -t 'keeps the repo'` with `removeFixtureRepo` temporarily changed to immediate rm: **2 failed**, root and continuation both observed the repository missing while the real session's final-write barrier remained held. Restored the exact saved helper afterward.

`npm test -- packages/cezar/src/workflows/fixture-cleanup.test.ts packages/cezar/src/delegation/service.testkit.test.ts` after restoration: **8 passed**. Includes real root/continuation ownership, ownership timeout preserving the directory, filesystem removal failure propagation, false worker termination refusal, and prior owned-work rejection coverage.

## Verification

Final focused checks and parent integration gate results are recorded in the implementation handoff. The parent owns the final full six-command gate at the integrated revision. Native-wire lifecycle parity additions are not required: production lifecycle behavior is unchanged.

### Implementation-worker checks (2026-10-03)

- `npm ci`: passed before any tests.
- `npm run build:server`: passed (needed emitted declarations for the service test typecheck).
- `npm run typecheck -w @wjarka/cezarion`: passed after the final code edits.
- 35 affected fixture suites at the normal Vitest worker count: 34 files / 657 tests passed; `run.test.ts` initially had four cleanup compatibility failures. Two synthetic ActiveRun entries had no real interrupt function; cleanup now distinguishes tracked work from synthetic/queued state. Two cases restored the auxiliary naming environment between suites; the namer is now disabled before each test in this file.
- `npm test -- packages/cezar/src/workflows/run.test.ts packages/cezar/src/workflows/model-identity-wiring.test.ts packages/cezar/src/workflows/fixture-cleanup.test.ts packages/cezar/src/delegation/service.testkit.test.ts`: **4 files / 184 tests passed** after those corrections.
- `npm test -- packages/cezar/src/workflows/run.test.ts -t 'queued-stack mutators|continueRun override|parallel variants'`: **49 passed**, 112 intentionally filtered out.
- `npm test -- packages/cezar/src/server/delegation-cleanup.test.ts packages/cezar/src/server/run-relationships.test.ts packages/cezar/src/discovery/cli.test.ts packages/cezar/src/core/codex-provider-failure.test.ts`: **4 files / 24 tests passed**.
- `npm test -- packages/cezar/src/workflows/workspace-semaphore.test.ts`: **11 passed** after explicitly releasing every held check gate and waiting for check completion before cancellation/removal.
- `npm test -- packages/cezar/src/delegation/service.testkit.test.ts`: **4 passed**, including real worker acceptance and Stop with a forced false termination result.

The initial broader parity filter also selected owned-input tests unnecessarily. Its nine failures were a test-helper shorthand typo (`runId` after removal of the obsolete local); all referenced afterSettled callbacks. The corrected invocation supplies `runId: started.id`. The subsequent exact driveRun consumer filter is recorded below.

Exact 35-file batch command (iteration evidence, not a claim that the full repository suite ran):

```sh
npm test -- packages/cezar/src/delegation/conversation-service.test.ts packages/cezar/src/delegation/destruction-results.test.ts packages/cezar/src/delegation/input.test.ts packages/cezar/src/delegation/provision-workflows.test.ts packages/cezar/src/delegation/routes.test.ts packages/cezar/src/delegation/service.test.ts packages/cezar/src/delegation/service.testkit.test.ts packages/cezar/src/delegation/workspace.test.ts packages/cezar/src/server/provider-action-gating.test.ts packages/cezar/src/server/repo-branches-api.test.ts packages/cezar/src/server/worktrees-api.test.ts packages/cezar/src/workflows/agent-profile-wiring.test.ts packages/cezar/src/workflows/agent-tmpdir.test.ts packages/cezar/src/workflows/auto-resume.test.ts packages/cezar/src/workflows/autosave-gate.test.ts packages/cezar/src/workflows/check-stop-kill.test.ts packages/cezar/src/workflows/continuation-tools.test.ts packages/cezar/src/workflows/continue-unarchive.test.ts packages/cezar/src/workflows/cursor-bootstrap-continue.test.ts packages/cezar/src/workflows/delegation-integration.test.ts packages/cezar/src/workflows/model-identity-wiring.test.ts packages/cezar/src/workflows/pasted-attachments.test.ts packages/cezar/src/workflows/pi-teardown.test.ts packages/cezar/src/workflows/recover-autonomous.test.ts packages/cezar/src/workflows/recover-followups.test.ts packages/cezar/src/workflows/recover-session-failure.test.ts packages/cezar/src/workflows/retention-wiring.test.ts packages/cezar/src/workflows/run-isolation.test.ts packages/cezar/src/workflows/run-lease.test.ts packages/cezar/src/workflows/run.test.ts packages/cezar/src/workflows/stopped-composer.test.ts packages/cezar/src/workflows/system-prompt.test.ts packages/cezar/src/workflows/worker-destroy.test.ts packages/cezar/src/workflows/workspace-semaphore.test.ts packages/cezar/src/workflows/fixture-cleanup.test.ts
```

The worker deliberately did not run the full six-command gate, per the parent's assignment. Full `npm test` at normal worker count, package and browser gates remain the parent's integration responsibility. No unrelated hearsay-tools/cezarion#515 or application-update behavior was changed.

Final parity check: `npm test -- packages/cezar/src/core/harness-parity.test.ts -t 'harness parity — run tier|harness parity — late child attention|harness parity — stored assistant ASK|harness parity — live task scratch'`: **65 passed**, 253 intentionally filtered out. This covers every driveRun consumer group through each backend's native mock wire; no new parity cells or production runner changes were needed.

`git diff --check`: passed. All remaining verification belongs to the parent integration gate; no known unresolved targeted-test failures remain.


### Independent-review corrections (2026-10-03)

The first helper missed inactive Finish and watchdog rescue: neither requires an active session or execution promise. Added ownership observation for `settleSuccess`, `settleRequestedRootFinish` and `rescueStalledQueue`. Regressions seed real RunStore records in a real Git repository and hold the real Git diff / workflow catalog result before the manager's durable settlement/adoption writes. Both ordinary and delegated-root Finish are covered. Removing the repository cannot proceed until those operations, and any work they admit, settle.

Also corrected the input-fixture audit above and restored raw constructors at its eight synthetic sites. These fixtures never used the shared service teardown, so factory registration retained their disposed managers and stores. Their explicit ACK/recovery waits and existing disposal/flush remain sufficient.

Before the correction, `npm test -- packages/cezar/src/workflows/fixture-cleanup.test.ts -t 'detached Finish|queue rescue'`: **3 failed**, each on the repository having been removed while the held boundary remained pending; **4 filtered out**. Detached operation promises are observed in the regression so expected broken-helper rejections cannot escape as unrelated unhandled errors.

Review-round verification (normal Vitest worker count):

- `npm test -- packages/cezar/src/workflows/fixture-cleanup.test.ts packages/cezar/src/delegation/input.test.ts packages/cezar/src/delegation/service.testkit.test.ts packages/cezar/src/workflows/model-identity-wiring.test.ts`: **4 files / 60 passed**.
- Temporarily removed only the three new ownership entries, reran `npm test -- packages/cezar/src/workflows/fixture-cleanup.test.ts -t 'detached Finish|queue rescue'`: **3 failed / 4 filtered out**, each with missing repository at the held boundary. Restored the saved helper in `finally`.
- After restoration, `npm test -- packages/cezar/src/workflows/fixture-cleanup.test.ts packages/cezar/src/workflows/auto-resume.test.ts packages/cezar/src/workflows/agent-tmpdir.test.ts packages/cezar/src/workflows/run.test.ts -t 'detached Finish|queue rescue|watchdog|[Ff]inish|keeps the repo|ownership timeout|removal errors'`: **4 files / 13 passed / 196 filtered out**.
- `npm run typecheck -w @wjarka/cezarion`: **passed**.

## Parent integration verification

The complete six-command gate passed on `c878e4a1`: typecheck; Vitest (529 files, 11,452 tests at normal workers); node unit (504 tests); build/check:pack; packaged CLI (62 tests); and `test:e2e:local` (all four lanes, `TEST_E2E_STATUS=passed`). The subsequent review fix changes only fixture tests/testkit and this audit, leaving runtime, package and browser inputs unchanged.

On final code revision `d7b1fdf7`, `npm run typecheck` and the complete `npm test` passed again (529 files, 11,455 tests, normal worker count). The independent Astra reviewer approved the corrected implementation, passed 45 focused tests, and replayed both originally failing Finish/watchdog reproductions without late errors. All review findings are resolved. `git diff --check` passed and merging freshly fetched `origin/main` reported already up to date.
