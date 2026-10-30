# Break up RunManager: a facade over `workflows/run/` modules

Epic hearsay-tools/cezarion#2051; this record is hearsay-tools/cezarion#2052. The owner approved
the plan on 2026-10-28. Decision record: [ADR 0053](../../docs/adr/0053-keep-runmanager-a-facade-over-run-modules.md).
Baseline: `main` at `fe9b5a183`.

`packages/cezar/src/workflows/run.ts` is 10,646 lines and 608,875 bytes. It holds one class,
`RunManager`, with about 525 functions and 45 state fields. The method splits up to
hearsay-tools/cezarion#2050 made methods smaller, but no stateful part has left the class. This
spec says how the class becomes a thin facade over about 40 modules in
`packages/cezar/src/workflows/run/`, one module per pull request, in six phases.

Methods are named, never cited by line number: every move shifts the lines.

## Decisions

1. **The facade stays.** `workflows/run.ts` keeps the `RunManager` export, its constructor
   `(store, repoRoot, options)` and the 48 members that shipped code calls from outside the file.
   Packaged E2E tests and `packages/web/scripts/tab-fixture-server.mjs` load
   `dist/workflows/run.js` by path, and 154 test files import from `run.ts`.
2. **Modules live in `workflows/run/`.** A module never imports `run.ts`, not even for a type. It
   calls back through a host interface that the facade builds as an object literal, the way
   `ContinuationChecks` takes `AdmissionReads` in `continuation-admission.ts`. A module never
   takes `Pick<RunManager, …>`, because that makes private methods public and ties the module
   back to `run.ts`.
3. **One shared context.** Modules read `store`, `repoRoot`, `dataDir`, `semaphore` and
   `disposed()` and owned `work` from one `RunModuleContext` object. No module copies a manager map.
4. **One module per pull request, each at most 1,000 lines.** `file-length.test.ts` refuses a
   new file over 1,000 lines, so the class needs at least ten modules. Each move PR lowers the
   `run.ts` entry in `file-length.baseline.json` (`FILE_LENGTH_UPDATE=1`).
5. **Move verbatim first.** A move keeps method names and bodies. The CI complexity gate pairs a
   moved function with its origin only by identical body, or by the same name and at least half
   of its lines shared, so a rewrite during a move can turn an old function into a new one over
   the limit. Refactoring comes in a later PR. The exception: a Phase 1 issue that names a
   function over complexity 20 splits it while it moves.
6. **Test seams keep working until Phase 5.** A method that a test spies on, wraps or replaces
   stays a `RunManager` method, and a module calls it through the host, so the spy or wrapper
   still sees the call. A map that tests reach stays reachable on the manager under the same
   name, through a getter that returns the same instance. Phase 5 moves the tests.
7. **Tuning fields are read at use time.** Tests overwrite `wakeRetryBackoff`, `orphanBackoff`,
   `orphanTermGraceMs`, `noWaitNudgeReplyMs` and `unreadInputGraceMs` on the instance, and the CI
   wait tests replace `ciSupervisor` with `Object.assign`. A module reads them through the host when
   it uses them; a copy taken at construction ignores the test. Phase 5 moves
   `wakeRetryBackoff` into `WakeRetries` and tests set that instance field directly.
8. **Teardown keeps its order.** Each module owns a `dispose()` for its own timers and maps. The
   facade's `dispose` calls them in today's order, with `disposed = true` first. Maps that
   `dispose` does not clear today stay uncleared until hearsay-tools/cezarion#2064 decides.
9. **A move changes no behavior and no expected test outcome.** A behavior question found during a
   move becomes its own issue, linked from the epic.
10. **A train, not a swarm.** At most two move PRs are open at once, and they merge in order. A
    module takes its imports with it: 59 of the 97 commits to `run.ts` in the month before
    2026-10-28 changed an import line, and 10 pull requests had merge conflicts in the file.
11. **Children are filed per phase.** The epic lists the Phase 0 and Phase 1 children. Each later
    phase's children are filed when the phase before it meets its exit, because their scope
    depends on how the earlier moves land.

## Why the class does not split on its own

- **Shared state has many writers.** About 20 methods write `queue` and 18 write `starting`.
  `waiting` has about 14 write sites, `waitWakeAdmitted` 9 and `monitoring` 7. On `ActiveRun`,
  input delivery, turn end, runner events and launch all write the turn-boundary fields
  (`session`, `atTurnBoundary`, `parkAfterAck`, `doneAtBoundary`, `pendingHumanAsk`). A cluster
  that writes these fields cannot move alone.
- **`releaseSlot` re-enters every pump.** `releaseSlot` calls `semaphore.release()`, which runs
  each participant's `pump` up to its first `await`, and that prefix runs `reconcileAutoResumes`.
  Each `releaseSlot` call can therefore arm or withdraw an auto-resume timer before it returns.
- **Code is copied.** Nine methods copy the guard `!run || run.stopping ||
  this.workerExecutionStopped(runId) || this.executionBlockedByRootFinish(run)`. The `onEvent`
  handlers of `runAgentStep` and `runContinuation` are near copies with three differences. Four
  methods rebuild the `StartRunInput` that `queuedRecoveryInput` already builds. Three
  settlement methods copy the closing-wake decision.
- **Guards are bound to the file path.** See [Guards and reader sweep](#guards-and-reader-sweep).
- **Tests reach inside.** 86 test files reach 93 private members at 636 sites. `active` alone is
  reached from 49 files. `fixture-cleanup.testkit.ts` replaces 12 methods on each manager it
  builds, and 56 test files use it.

## Target layers

Each module imports only from its own layer or a lower one. The facade sits on top.

| Layer | Phase | Modules |
|---|---|---|
| Facade | — | `workflows/run.ts`: constructor (composition root), ordered `dispose`, `activate` and `dropActive`, the public members, test-seam delegators, `execute` and `runContinuation` entry points, `cancel`, `finish`, `startRun`, `continueRun`, `move` |
| Orchestrators | 4 | `input-delivery`, `wake-admission`, `turn-nudges`, `turn-settler`, `run-settlement`, `continuation-acceptance`, `step-session`, `step-loop`, `continuation-session`, `run-recovery` |
| Hubs | 3 | `run-line` (the scheduler line), `queued-revival`, `wait-watches`, `wait-registry`, `family-reconciler`, `human-waits`, `worker-questions`, `completion-gate`, `session-events` |
| State owners | 2 | `maintenance-claims`, `repo-root-lease`, `attachment-writer`, `cezar-tools`, `worker-orphans`, `worker-executions`, `queued-input`, `launch-context`, `run-skills`, `worktree-autosave`, `turn-bookkeeping`, `wake-retries` (moved to Phase 4), `auto-resume`, `inbox-claims`, `input-receipts` |
| Pure modules | 1 | `turn-markers`, `prompts`, `steps`, `run-guards`, `wake-ledger`, `pending-ask-facts`, `workflow-position`, `step-decisions`, `launch-settings`, `run-workspace`, `opening`, `usage-accounting`, `input-timers`, `input-batch`, plus `delegation/execution-settings.ts`, `delegation/execution-identity.ts` and `runs/run-title.ts` |
| Shared | 0 | `types.ts`, `RunContext` |

Precedents in the repository: `WorkerScratchCleanup` (a state owner with a predicate host),
`ContinuationChecks` (a narrow host of callbacks) and `SemaphoreParticipant` (the interface that
`run-line` implements).

## Module map

Paths are under `packages/cezar/src/workflows/run/`. A path that starts with another directory, such as `delegation/`, is under `packages/cezar/src/`.
"Host" counts the callbacks the module takes from the facade. Line counts are estimates.

| Module | Phase | Issue | Takes from `RunManager` | Owns | Host | Lines |
|---|---|---|---|---|---|---|
| `types.ts` | 0 | hearsay-tools/cezarion#2054 | `StartRunInput`, `DelegationExecutionSettings`, `AutomationToolService`, `PendingContinuation`, launch and continuation types; explicit `LaunchDelegation`, `LaunchCiTools`, `StepProfile`. Also takes in `drop-active.ts` and `resolved-wait-input-batch.ts` | — | 0 | 150 |
| `turn-markers.ts` | 1 | hearsay-tools/cezarion#2055 | The turn readers (`turnParkSignals` to `discardQueuedMessagesOnAsk`); note constants go to `turn-end.ts` | — | 0 | 300 |
| `prompts.ts`, `steps.ts`, `runs/run-title.ts` | 1 | hearsay-tools/cezarion#2056 | Prompt and skill text helpers, `stepScope`, `settlesAsDone`, `stepLabel`, `makeRunTitle` | — | 0 | 250 |
| `delegation/execution-settings.ts`, `delegation/execution-identity.ts` | 1 | hearsay-tools/cezarion#2057 | `selectDelegationExecutionSettings`, the `workerIdentity` checks, `ownedWorkflow`, `continuationDefStep(s)` | — | 0 | 160 |
| `run-guards.ts` | 1 | hearsay-tools/cezarion#2058 | `rootFinishRequested`, `executionBlockedByRootFinish`, `historyDeletionPending`, the named self-wake guard | — | 0 | 60 |
| `wake-ledger.ts`, `pending-ask-facts.ts`, `workflow-position.ts` | 1 | hearsay-tools/cezarion#2059 | `owesWake`, `pendingConversationWakes`, `owesDelivery`, the automatic-wake count; `hasPendingHumanAsk` and its neighbors; the workflow step-index reads | — | 0 | 190 |
| `step-decisions.ts` | 1 | hearsay-tools/cezarion#2060 | Closing-wake decision, continuation close kind, execution settlement kind, check-step outcome | — | 0 | 120 |
| `launch-settings.ts`, `run-workspace.ts`, `opening.ts` | 1 | hearsay-tools/cezarion#2061 | Model, effort and runner resolution for both launch paths; base ref and workspace; opening inputs and composition | — | 0 | 430 |
| `usage-accounting.ts` | 1 | hearsay-tools/cezarion#2062 | `beginUsageInvocation`, `recordReportedCost`, `recordUsageUiEvent`, `persistUsageCheckpoint`, `recordUsagePeaks` | — | 0 | 150 |
| `input-timers.ts`, `input-batch.ts` | 1 | hearsay-tools/cezarion#2063 | Timer clears and harness reads; pure stages of input submission and flushing | — | 0 | 160 |
| `maintenance-claims.ts` | 2 | hearsay-tools/cezarion#2096 | `claimForPublish`, `claimWorktreeReclaim`, `claimForBranchCleanup`, `claimWorkerCleanup` | `reclaiming` | 4–7 | 60 |
| `repo-root-lease.ts` | 2 | hearsay-tools/cezarion#2098 | `acquireRepoRoot` | `repoRootTail` | 3 | 50 |
| `attachment-writer.ts` | 2 | hearsay-tools/cezarion#2097 | `persistAttachment`, `persistPastedAttachments` | `queuedImageSeq` | 2 | 80 |
| `cezar-tools.ts`, `preview/run-tools.ts` | 2 | hearsay-tools/cezarion#2099 | Tool handler factory, `toolSessionRefusal` as a pure function, the automation-tools slot, preview register and stop | `automationTools`, `automationToolsWaiters` | 8 | 180 |
| `worker-orphans.ts` | 2 | hearsay-tools/cezarion#2100 | Orphan probe, reprobe, reap and terminate | the 8 `orphan*` fields | 4 | 220 |
| `worker-executions.ts` | 2 | hearsay-tools/cezarion#2102 | `beginWorkerExecution`, `finishWorkerExecution`, the termination proof; `trackTurn` and `trackDelivery` replace direct writes to `executions` | `executions`, `finalizedWorkers`, `stoppedWorkers`, `terminationWaiters` | 6 | 200 |
| `queued-input.ts` | 2 | hearsay-tools/cezarion#2103 | Queued and deferred messages, prompt amendments, hydration | `deferredMessages` | 9 | 240 |
| `launch-context.ts` | 2 | hearsay-tools/cezarion#2104 | `agentEnv`, `agentEnvForStep` (delegator stays), `automationsPart`, `agentWebhooksPart`, `sessionContextFor` | — | 5 | 170 |
| `run-skills.ts` | 2 | hearsay-tools/cezarion#2106 | `loadRunSkills`, `enabledSkills`, `provisionRunSkills`, `provisionLiveSlashSkill` | — | 6 | 190 |
| `worktree-autosave.ts` | 2 | hearsay-tools/cezarion#2108 | The autosave body; `saveWorktree` and `autosaveCleanupBlocker` delegators stay | `autosaveTasks` | 8 | 130 |
| `turn-bookkeeping.ts` | 2 | hearsay-tools/cezarion#2101 | Turn markers, `diffStat`, the namer; Phase 5 removes the bookkeeping delegators (hearsay-tools/cezarion#2235) | `lastNamerKey` | 5 | 110 |
| `wake-retries.ts` | 2, moved to 4 | hearsay-tools/cezarion#2194 | Moved to Phase 4: see its Phase 4 row | — | — | — |
| `auto-resume.ts` | 2 | hearsay-tools/cezarion#2109 | Arm, fire, reconcile and withdraw the usage-limit resume; `deriveAccountHolds` | `autoResumeTimers` | 5 | 200 |
| `inbox-claims.ts` | 2 | hearsay-tools/cezarion#2105 | Claim, acknowledge, release and expire inbox claims | `inboxClaimTimers` | 10 | 90 |
| `input-receipts.ts` | 2 | hearsay-tools/cezarion#2107 | Consumed and unread receipts; bundled delivery and answer commits | — | 4 | 100 |
| `run-line.ts` | 3 | hearsay-tools/cezarion#2141, hearsay-tools/cezarion#2143 | Slot counting, `pump`, line order, launch dequeue, the stalled-queue watchdog; implements `SemaphoreParticipant` | `queue`, `pendingJobs`, `pendingContinuations`, `starting`, `waiting`, `monitoring`, `waitWakeQueuedAt`, `waitWakeAdmitted`, `forceNextPump`, `forceStarted`, `pumping`, `pumpAgain`, `pumpRepoInfo` | about 16 | 300 |
| `queued-revival.ts` | 3 | hearsay-tools/cezarion#2145 | Revive queued runs and continuations, for recovery and the watchdog | — | about 12 | 150 |
| `wait-watches.ts` | 3 | hearsay-tools/cezarion#2144 | Arm, disarm and settle timers, CI watches and process watches | `waitTimers`, `ciWatches`, `ciRetries`, `processWatches`, `processSupervisor` | 6 | 170 |
| `wait-registry.ts` | 3 | hearsay-tools/cezarion#2146, hearsay-tools/cezarion#2147 | Register, cancel and resolve waits, including worker, request and peer waits | `ciRegistrations` | about 12 | 400 |
| `family-reconciler.ts` | 3 | hearsay-tools/cezarion#2148 | `reconcileWorkerWaits` (delegator stays) and the family passes | `reconcilingWorkers`, `reconcilingFamily`, `pendingReconciliations`, `requestDeadlineTimers`, `workerResolveRetries`, `recoveryFactsPending` | about 15 | 220 |
| `human-waits.ts`, `worker-questions.ts` | 3 | hearsay-tools/cezarion#2142, hearsay-tools/cezarion#2149 | Open, show and withdraw human waits; route worker questions, park notices, routed answers, fallback asks | — | about 8 | 330 |
| `completion-gate.ts` | 3 | hearsay-tools/cezarion#2150 | Read side of the completion gate, `completionRefusal` | — | 7 | 90 |
| `session-events.ts` | 3 | hearsay-tools/cezarion#2151 | One session event handler and one launch preamble for both launch paths | — | about 13 | 150 |
| `input-delivery.ts` | 4 | hearsay-tools/cezarion#2192 | Flush, submit and acknowledge input, the idle boundary (`settleIdleBoundary`), `handleAgentInputReady`, the unread and held input timers, human message delivery, the body of `deliverConversationInput`, routed answer delivery: 23 methods, moved verbatim. `sendMessage`, `respondPermission` and `steerWorker` stay on the facade | — | 26 | 500 |
| `input-delivery.ts` (splits) | 4 | hearsay-tools/cezarion#2196 | After hearsay-tools/cezarion#2192, splits `settleIdleBoundary` (22, to about 17) and `handleAgentInputReady` (22, to about 13) inside the module | — | — | 0 |
| `wake-retries.ts` | 4 | hearsay-tools/cezarion#2194 | `retryWaitAdmission` and `clearWakeBackoff` (delegators removed in hearsay-tools/cezarion#2232), named operations for the inline reads and writes, its `dispose` step | `wakeRetries`, `wakeBackoffs`, `retainedNotes` | 3 | 25 |
| `wake-admission.ts` | 4 | hearsay-tools/cezarion#2197 | `parkOnWaits`, `queueWaitWake`, `deliverAdmittedWake`, sessionless wakes, empty-wake retirement, the wake budget, delivery failures, and the wait teardown (`cancelOpenWaits`, `disarmRunWaits`, `onRunDeleted`). `commitContinuation` stays for hearsay-tools/cezarion#2199 | — | 16 | 360 |
| `turn-nudges.ts` | 4 | hearsay-tools/cezarion#2195 | The autonomous nudge, the no-wait nudge and the completion refusal: nine methods | — | 15 | 195 |
| `turn-settler.ts` | 4 | hearsay-tools/cezarion#2198 | `settleTurn`, `takeDoneRequest` to `closeAsDone`, `endTurn` to `settledTurnOutcome`, `openTurnEndHumanWait`, `armIdleTimer`, `parkForUser`, `openTimerAlias` | `turnEndCarriers` | 23 | 470 |
| `run-settlement.ts` | 4 | hearsay-tools/cezarion#2200 | Execution, continuation, success and idle settlement (`settleSuccess` delegator stays), `stepLeftOpen`, `unansweredWorkflowAsk` (renamed), `republishFinishVerdict`, and the tail of `dropActive` after `store.unpin`. `dropActive` stays on the facade | — | 16 | 460 |
| `continuation-acceptance.ts` | 4 | hearsay-tools/cezarion#2199 | Accept, checkpoint, commit (`commitContinuation`) and dispatch a Continue; `failCrashedContinuation` (delegator stays). `continueRun` stays on the facade | `continuationGenerations` | 10 | 155 |
| `step-session.ts`, `session-events.ts` | 4 | hearsay-tools/cezarion#2201 | `runAgentStep`, `stepOpening`, `startStepSession`, `awaitStepSession`, `releaseStepSession`. The shared launch helpers (`stepProfileFor`, `launchStale`, `launchOpening`, `launchSystemTail`, `persistWorkerAssistantResult`, `makeUiSink`, the runner UI handlers, `disposedSessionEvent`, `recordSessionFault`, `markTurnBoundary`) go to `session-events.ts` | — | 6, plus one 13-member shared-helper host | 460, of which about 160 go to `session-events.ts` |
| `run-recovery.ts` | 4 | hearsay-tools/cezarion#2202 | `recover`, `adoptOrphanedRun` and their passes | `recoveryScope`, `recoveryInFlight`, `adoptionTail` | 20 | 350 |
| `step-loop.ts` | 4 | hearsay-tools/cezarion#2203 | Twelve methods behind `execute`: start, worktree, the step loop, check steps, `requeueWhileHeld`. `execute` stays on the facade | — | 7, plus the `run-settlement` and `step-session` instances | 480 |
| `continuation-session.ts` | 4 | hearsay-tools/cezarion#2204 | The part of `runContinuation` after `unmarkStarting`, under a new name: workspace, repository-root lease, worktree, settings and skills, prelaunch stops, start, await and release. `runContinuation` keeps its head on the facade | — | 15, plus the `run-settlement` instance | 540 |
| `tracked-work.ts` | 5 | hearsay-tools/cezarion#2226 | Records the 12 operations that `fixture-cleanup.testkit.ts` wraps, where each promise is made; `RunModuleContext.work` | the tracked promises and sessions | 0 | 0 |
| `run-finish.ts` | 5 | hearsay-tools/cezarion#2238 | `completionGate`, `deferParentCompletion`, `acceptDone`, `finish`, `acceptRootRequestFinish`, `closeQuestionOnFinish`, `settleRequestedRootFinish`, `holdContinuationForRootFinish`. `finish` and `acceptDone` delegators stay | — | 5, plus four instances | 175 |
| `run-start.ts` | 5 | hearsay-tools/cezarion#2239 | `startRun`, `startRunIdempotent`, `enqueueOwnedRun`, `ownedJob`, `launchQueuedRun`. The three public delegators stay | — | 5 | 150 |
| `run-cancel.ts` | 5 | hearsay-tools/cezarion#2241 | `cancel`, `cancelActiveRun`, `cancelWorkerExecution`, `cancelQueuedRun`, `cancelRunWithoutSession`, `requestWorkerStop`, `cancelWorkerWait`. The three public delegators stay | — | — | 95 |
| `compose.ts` | 5 | hearsay-tools/cezarion#2243 | The constructor's wiring: builds every module from `RunModuleContext` and one `FacadeHost`, and returns one record of module instances | — | `FacadeHost` | 430 |

Phase 5 rows come from the check against `main` at `ca83636c4`; their lines are lines out of `run.ts`.
Phase 4 rows come from the check against `main` at `97335b352`. Their host counts callbacks after
Phase 2 and 3 modules are passed as instances, and their lines are gross lines out of `run.ts`,
before delegators and wiring come back. Two Phase 4 children change tests only:
hearsay-tools/cezarion#2193 pins the disposal routes (question 2 in
[Behavior questions](#behavior-questions)), and hearsay-tools/cezarion#2205 fixes a spy that no
code reaches.

The methods that hearsay-tools/cezarion#2044 and hearsay-tools/cezarion#2049 split out of
`submitAgentInput` and `flushAgentInputs` (`recordAgentInputTurn`, `admitsAgentInput`,
`sendAgentInput`, `supersedeFallbackBeforeFlush`, `cancelCappedTimersBeforeFlush`,
`flushAgentInputBatch`) go to `input-delivery.ts`; their pure parts go to `input-batch.ts`.

A module whose host would pass about 12 members waits until its dependencies have moved, so its
host shrinks. That is why the orchestrators come last. After Phase 3, three Phase 4 hosts are still
well over 12: `input-delivery` (26), `turn-settler` (23) and `run-recovery` (20). The planner
accepted them; Phase 5 narrows them.

## Phases and exits

| Phase | Pull requests | Lines out | `run.ts` after | Exit |
|---|---|---|---|---|
| 0 Guardrails | 3 | 150 | 10,500 | A function moved into `workflows/run/` stays under every guard that covered it in `run.ts` |
| 1 Pure modules | about 9 | 1,700 | 8,800 | `run.ts` is under 524,288 bytes, so Squeal checks its complexity again |
| 2 State owners | about 14 | 2,100 | 6,900 | Each moved field has one owning module |
| 3 Hubs | about 8 | 1,800 | 5,300 | Only `activate` and `dropActive` write shared state |
| 4 Orchestrators | about 14 | 3,900 | 2,100 | No function in `run.ts` or `workflows/run/` is over complexity 20 |
| 5 Thin the facade | 18 issues, hearsay-tools/cezarion#2226 to hearsay-tools/cezarion#2243 | about 1,650 | about 680 | `run.ts` has no entry in `file-length.baseline.json`. If it ends above 1,000 lines, its final length is pinned and the epic closes (owner, 2026-10-29) |

"After" includes the delegators and wiring that each phase adds to the facade. The Phase 4 row
was measured again before its children were filed; the first estimate was about 8 pull requests,
2,800 lines out and 2,900 after.

Results so far:

- Phase 1: `run.ts` went from 10,486 lines and 600,109 bytes to 9,251 lines and 533,544 bytes. The
  byte exit missed by 9,256 bytes, because the delegators that test seams need stay in the facade.
- Phase 2: 14 pull requests; 9,251 lines to 7,510 lines and 439,702 bytes, under 524,288 bytes, so
  Squeal checks the complexity of `run.ts` again.
- Phase 3: 7,510 lines to 6,048 lines and 353,889 bytes at `97335b352`, with
  hearsay-tools/cezarion#2151 still open.
- Phase 4: 14 pull requests; 6,007 lines to 2,336 lines at `ca83636c4`. No function in `run.ts` or
  `workflows/run/` is over complexity 20.

**Phase 0.** hearsay-tools/cezarion#2053 widens the guards before any code moves into
`workflows/run/`. hearsay-tools/cezarion#2054 then adds the shared types, which removes the eight
type-only import cycles that pass through `run.ts`.

**Phase 1.** The children are independent of one another after hearsay-tools/cezarion#2053.
hearsay-tools/cezarion#2057 and hearsay-tools/cezarion#2062 split four of the eight functions over
complexity 20 while they move.

**Phase 2.** Order: maintenance claims, repo-root lease and attachments first (no hot paths); then
the cezar tools, where a pure `toolSessionRefusal` breaks the cycle between the tools and the
waits; then worker orphans before worker executions; queued input and launch context; run skills;
autosave and turn bookkeeping; auto-resume; inbox claims and input receipts. The wake-retries
move went to Phase 4 (hearsay-tools/cezarion#2194): it is about 25 lines and had to follow
hearsay-tools/cezarion#2060.

**Phase 3.** `run-line` first: every write from outside becomes a named operation (`enqueueJob`,
`park`, `unpark`, `joinPool`, `leavePool`, `admitWake`, `forget`), and compatibility getters keep
`queue`, `waiting`, `monitoring`, `starting` and `pendingJobs` reachable from tests. Then queued
revival; wait watches before the wait registry; the family reconciler, whose recursion guard must
stay synchronous and re-entrant through `onDelegationRun`; human waits and worker questions,
after the `parkForUser` call moves out of `askParentForWorker` into its only caller; the
completion gate; session events.

**Phase 4.** The order follows the measured sizes and the hosts. At most two move PRs are open;
while hearsay-tools/cezarion#2151 is open, it counts as one of them.

1. The disposal pin first: hearsay-tools/cezarion#2193 pins both launch paths' disposal routes
   (question 2 in [Behavior questions](#behavior-questions)) before any PR shares code between
   them. It changes tests only.
2. Input delivery moves verbatim (hearsay-tools/cezarion#2192), including `settleIdleBoundary` and
   `handleAgentInputReady` at complexity 22. hearsay-tools/cezarion#2196 then splits them inside
   `input-delivery.ts`. Decision 5 allows a split during a move only in Phase 1, and a split
   inside `run.ts` would grow its pinned length. The split touches only `input-delivery.ts`, so it
   may run beside any wave after the move.
3. Wake retries before wake admission: hearsay-tools/cezarion#2194 gives the three maps one owner,
   so hearsay-tools/cezarion#2197 takes `WakeRetries` instead of three raw maps.
4. The nudges before the settler: with the nudges, `turn-settler.ts` measures about 660 lines, so
   hearsay-tools/cezarion#2195 moves them first. Turn settlement (hearsay-tools/cezarion#2198) then
   follows PR hearsay-tools/cezarion#2026, which has merged; hearsay-tools/cezarion#1534 is the
   history of `settleTurn`, and AGENTS.md's rule on merging handlers applies.
5. Continue acceptance (hearsay-tools/cezarion#2199) and run settlement
   (hearsay-tools/cezarion#2200) before the launch paths. Settlement code sits inside both launch
   paths. Moving it first removes about 8 callbacks from each launch-path host, and no code moves
   twice.
6. The step session (hearsay-tools/cezarion#2201) and recovery (hearsay-tools/cezarion#2202), then
   the step loop (hearsay-tools/cezarion#2203) and the Continue session
   (hearsay-tools/cezarion#2204). The launch paths wait for hearsay-tools/cezarion#2151, the
   disposal pin and settlement.

An orchestrator calls another orchestrator through its host, as a lazy callback to the
`RunManager` member, never by importing it. One exception: a launch-path module (`step-loop.ts`,
`continuation-session.ts`) takes the `run-settlement.ts` instance, and `step-loop.ts` also takes
the `step-session.ts` instance. Neither callee calls back into a launch path, so the edges have no
cycle, and the constructor builds the callees first.

A module imports the Phase 1 pure functions it needs instead of taking the manager's one-line
wrapper. Phase 5 moved the `automaticWakes` spy (row U7m) to `WakeAdmission` in
hearsay-tools/cezarion#2232. These wrappers still stay host calls: `executionBlockedByRootFinish` and
`hasUnansweredHumanAsk` (`ci-wait-registration.test.ts`). A module that imports
`canProceedWithRun` passes it the host's `workerExecutionStopped` and
`executionBlockedByRootFinish`, which tests also spy on.

**Phase 5.** At most two PRs that edit `run.ts` are open at once; the epic lists the waves.

1. `TrackedWork` (hearsay-tools/cezarion#2226) replaces the 12 instance wrappers in
   `fixture-cleanup.testkit.ts` and the six hand-written wrappers, and adds `runInternals(manager)`.
   It lands before every test-migration issue and hearsay-tools/cezarion#2239.
2. Beside the train, with no `run.ts` edit: narrow `RunManager` ports for delegation, automations
   and server (hearsay-tools/cezarion#2228), input-receipt tests (hearsay-tools/cezarion#2229),
   turn-settler order pins (hearsay-tools/cezarion#2230), and a `stepLeftOpen` that clears nothing
   (hearsay-tools/cezarion#2233, after hearsay-tools/cezarion#2227).
3. hearsay-tools/cezarion#2227 moves the module-level constants and deletes uncalled delegators.
4. Tests move off `RunManager` to the module instances, family by family: run line
   (hearsay-tools/cezarion#2231), waits (hearsay-tools/cezarion#2232), input
   (hearsay-tools/cezarion#2234), turn (hearsay-tools/cezarion#2235), launch
   (hearsay-tools/cezarion#2236) and workers (hearsay-tools/cezarion#2237). Each delegator and
   compatibility getter goes when no test reaches it. Each PR records its proof in the PR body
   (`docs/sdlc/regression-proof.md`), and each moved spy or replacement asserts that it was reached.
5. The last facade bodies move: Finish and the completion gate (hearsay-tools/cezarion#2238, after
   hearsay-tools/cezarion#2235 and hearsay-tools/cezarion#2237), run start
   (hearsay-tools/cezarion#2239), input and launch-context bodies (hearsay-tools/cezarion#2240),
   Stop (hearsay-tools/cezarion#2241) and the lifecycle leftovers (hearsay-tools/cezarion#2242).
6. `compose.ts` takes the constructor's wiring and meets the exit (hearsay-tools/cezarion#2243,
   last).

## Rules for a move pull request

The PR body states each of these:

- The handlers it moves, with each handler's side effects in order, and the test or parity row
  that pins each one.
- The comments it keeps because they state a load-bearing order, quoted.
- The path with no live session (`this.active.get(runId)` absent) for each moved method that
  reads `active`, and the test that covers it.
- The reader sweep: every guard, test, doc and comment that names a moved member, and what
  changed in each.
- For a move in a wait, turn-end, failure or step-settlement path: the `core/*-parity` and
  `workflows/*-parity` verdicts. For this epic, the owner set this rule on 2026-10-29: a verbatim
  move relies on CI's Vitest shards for those verdicts. A PR that is not a verbatim move (a split,
  a handler merge, a call-order change, shared launch-path code, or a test change) also runs both
  parity globs locally with `npm test`, never through Squeal, before the PR. This is an exception
  to AGENTS.md § Runner regressions ship with shared coverage, for this epic only. A Phase 5 PR
  that changes tests only relies on CI's parity shards too (owner, 2026-10-29).
- The new `run.ts` entry in `file-length.baseline.json`.

Review asks one question of every move: does any test wrap or spy on a moved method, and does
every call still go through the manager?

## Orders that must survive

Each order below is load-bearing: other code reaches a correct state because of it.

| Handler | Order | Goes to |
|---|---|---|
| `dropActive` | The auto-resume schedule runs before `releaseSlot`; its comment says "that order is the whole point", because `releaseSlot` pumps and a pump reads the hold off the records. Unstated so far: the wake queued for owed waits can reach `releaseSlot`, and a pump, before the schedule. That is safe only because `canQueueWaitWake` refuses a run that is not running, waiting or queued, while the schedule acts only on failed runs. A change to either guard moves the wake after the schedule | facade, `run-settlement` |
| `finishWorkerExecution` | Settle sessions, then turns, then deliveries. Then record the completion (`stop-worker` before `commitWorkerExecutionComplete`), reap scratch, delete only the same execution entry, resolve, queue the wake (or retry its admission), clear `stopping`, and call `releaseSlot` last | `worker-executions` |
| `parkOnWaits` | Human wait first, then clear the idle timer, then publish the intent (a refused write throws). Then `waiting.add`, the pool join or leave, the idle timer, `queueWaitWake`, and `releaseSlot` last | `wake-admission` |
| `queueWaitWake` | Guards, then restore worker wait inputs before any admission, then the turn-boundary check, then arm the admission retry before delivery; admitted, pool, already queued, live or sessionless; `releaseSlot` last | `wake-admission` |
| `submitAgentInput` | Reservation, flight, send, checkpoint, flush, settle. "Attach rejection handling before any persistence/capacity work can throw." | `input-delivery` |
| `openWait` | `withdrawCezarHumanWaits`, then `commitWait` (a failure maps to `persistence`), then `armWait`, then park | `wait-registry` |
| `resolveWait` | The budget check before the commit; the result and its lifecycle input commit together, before `queueWaitWake` | `wait-registry` |
| `pump` | Wakes first, then unstarted runs, first in first out among the entries that can start. `disposed` and `recovering` are checked again inside the loop. A forced sweep is read and cleared in the same pump | `run-line` |
| `recover` | Facts, orphan settlement, `reconcileWorkerWaits`, scratch, per-run recovery, family reconcile, the scope clear in `finally`, messages, routed answers, re-armed wakes, `reconcileAutoResumes`, and `pump` last | `run-recovery` |
| `releaseContinuationSession` | Revoke the CI tools and the delegation, record usage peaks, clear the idle and autosave timers, await `saveWorktree`, check for a late cancel, `dropActive`, queue the workflow remainder, then `pump` | `continuation-session` |
| Session `onEvent` (both launch paths) | Disposed check, image, text (clear timers, note nudge content, append, strip markers), unconsumed input, tool events, raw event, cost, error (then return), the session-error short-circuit, session id, token usage, `ScheduleWakeup`, turn end. The return points decide what is persisted | `session-events` |
| `queueCompletionRefusal` | The refusal is enqueued with its charge in one commit, before `queueWaitWake` | `turn-nudges` (hearsay-tools/cezarion#2195) |
| `finish` | Cancel open waits, persist the root finish request, close the question, set `finishRequested`, clear the idle timer, the lifecycle event, then end the session | facade |
| `dispose` | `disposed = true` first; orphan state cleared before termination waiters settle; wait records stay for a later manager to re-arm | facade |

## Guards and reader sweep

| Guard | Reads today | Breaks when | Action | Phase |
|---|---|---|---|---|
| `skills-read-outside-enabled-skills`, `skills-write-outside-load-run-skills` (`.ai/ast-grep/rules/`) | `files:` names `run.ts` only | Skills code leaves `run.ts`. The rules then pass silently | Add `workflows/run/**`; keep `enabledSkills` and `loadRunSkills` as method definitions, or change the exemption | 0 |
| `workflows/run-states.test.ts` | 91 `via` names and 21 exit literals, in `run.ts` text | A `via` function or an exit writer moves | Also read `workflows/run/*.ts` | 0 |
| `run-fact-readers.test.ts` | `RESUME_TIME_READERS` names `run.ts` | Auto-resume moves | Add the new file; drop `run.ts` when its entry goes stale | 2 |
| `workflows/run-active-pin.test.ts` | The literal text of `activate`, `active.set`, `active.delete` and the two `createActiveRun` sites | Those move or their signature text changes | They stay on the facade | — |
| `file-length.baseline.json` | `run.ts` pinned at 10,646; limit 1,000 | Every shrink; any new file over 1,000 lines | Lower the pin in each PR | all |
| `outcome-write-outside-commit-outcome` baseline | Two `run.ts` entries: the fallback literal in `cancelWorkerWait`, a read view kept as a baseline entry on purpose | Those lines move | Re-key both entries to the new file in the same PR; the re-keyed baseline counts as growth, so it needs the owner's `baseline-growth` label | 3 |
| `// ast-grep-ignore: run-status-write-outside-transition` in `acceptUntouchedContinuation` | The line below it | That line moves | Move the comment with its line | 4 |
| CI complexity gate | Pairs a moved function by identical body, or by name and at least half of its lines | A move rewrites the body | Move verbatim | all |
| AGENTS.md parity trigger and Task routing; `agents-md-budget.test.cjs` | Name `run.ts` | — | Name `run.ts` and `workflows/run/`, with no byte growth | 0 |
| Docs and comments | AGENT_PROTOCOL.md (18 lines), `docs/areas/` skills, automations, git-worktree, runs-store and handoff-journal, `.ai/skills/auto-merge/SKILL.md`, and 24 shipped files with prose citations | A named member moves | Sweep in the move PR; leave ADRs as records | each PR |

Generic scans already cover new files and need no change: `old-engine-removed.test.ts`,
`contract-import-boundaries.test.ts`, `env-example.test.ts` and `test-wait-discipline.test.ts`.

## Test seams

Two kinds of seam fail differently when code moves:

- A `vi.spyOn` on a name that no longer exists throws, so the test fails.
- A replaced instance method keeps working only while internal callers dispatch through
  `this.<name>`. When a module calls its own copy, the spy counts zero and the fixture drain stops
  waiting. The test can stay green and prove nothing.

Members that tests wrap or spy on, which must stay `RunManager` methods called through the host
until Phase 5. The list was checked against `main` at `97335b352`:

- The 12 operations that `context.work` tracks at promise creation (hearsay-tools/cezarion#2226): `pump`, `execute`, `runContinuation`,
  `recordTurnEnd`, `saveWorktree`, `autoNameRun`, `enforceRetention`, `finishWorkerExecution`,
  `settleSuccess`, `settleRequestedRootFinish`, `rescueStalledQueue`, `trackWorkerSessionResult`.
  The fixture reads one `TrackedWork` per repository root. It does not replace manager methods.
  `runInternals(manager)` provides the typed module, context, active-map and disposal reads; its
  instance test pins every class-module field. The 12 facade members remain in this PR, while
  cleanup ownership also covers a module calling its own methods.
- Spied: `awaitRunTermination`, `reconcileWorkerWaits`, `startRun`, `recover`,
  `deliverConversationInput`, `continueRun`, `settledTurnOutcome`,
  `releaseSlot`, `noticeParkedWorker`, `completionGate`, `dropActive`, `reviveQueuedRun`,
  `retireUnreadParentQuestion`, `armNoWaitNudgeReplyTimer`,
  `executionBlockedByRootFinish`, `hasUnansweredHumanAsk`, `workerExecutionStopped`, `isActive`,
  `cancel`, `settleSuccess` (`harness-parity-cells.testkit.ts`), `settleOrphanedWorkerExecution`,
  `routeWorkerQuestion`, `unansweredQuestions`, `parentCompletionBlockers`, `acceptDone`,
  `sendMessage`, `discoverSkills`, `agentEnv`.
- Replaced on the instance: `agentEnvForStep`, `execute`
  (`worker-destroy.test.ts`), `recordTurnEnd` (4 files), `pump` and `runContinuation`
  (`run.test.ts`), `settleSuccess` (`worker-wait-capacity.test.ts`), and the field `ciSupervisor` (Decision 7).
- Wait seams moved in hearsay-tools/cezarion#2232: `queueWaitWake`, `automaticWakes`,
  `owesWake`, `parkOnWaits` and `wakeHeld` use `runInternals(manager).wakeAdmission`;
  `resolveWait` uses `.waitRegistry`. Timer and CI-watch reads use `.waitWatches`;
  CI-registration reads use `.waitRegistry`; retry/backoff reads and tuning use `.retries`.
  Each migrated spy asserts that the product path called it.

- Turn seams moved in hearsay-tools/cezarion#2235: `endTurn`, `settleTurn`, `boundaryTurn`,
  `parkForUser`, `armIdleTimer` and `openTurnEndHumanWait` call `TurnSettler` directly;
  `clearIdleTimer` uses `input-timers.ts`. Nudge tests use `.turnNudges`, including the
  `armNoWaitNudgeReplyTimer` spy. Timeout tests pass `noWaitNudgeReplyMs` at construction;
  waits-parity cells tune `.turnNudges.noWaitNudgeReplyMs` only when they did so before.
  Bookkeeping calls and `lastNamerKey` reads use `.turnBookkeeper`; `trackTurnEnd` lives there.
  `recordTurnEnd` and `autoNameRun` stay async tracking wrappers so dropped calls retain their
  rejection behavior. The harness bookkeeping drain reads only tracked `recordTurnEnd` work.
  The five remaining HumanWaits one-liners are removed; callers use `.humanWaits`.
  `settledTurnOutcome` stays on the facade for the prototype spy in `turn-outcomes.testkit.ts`;
  `parentCompletionBlockers` stays for `human-waits.test.ts`. `completionGate`,
  `deferParentCompletion`, `completionRefusal`, `finishDecision` and `completionMayPass` wait
  for hearsay-tools/cezarion#2238.

Function modules have no instance: `launch-context.ts`, `session-events.ts`, `completion-gate.ts`,
`queued-revival.ts`, `input-receipts.ts`, `usage-accounting.ts`, `run-guards.ts`,
`pending-ask-facts.ts` and `workflow-position.ts`. Their spied seams stay facade members.

State that tests reach, ranked by test files: `active` (49 files, 174 sites), `pump` (22 files),
`runContinuation` (10), `queue` (10), `execute` (9), `monitoring` (9), `agentEnvForStep` (7),
`waiting` (7), `busySlots` (6), `starting` (6), `settleSuccess` (6), `waitTimers` (6),
`executions` (5).

Phase 5 migration (hearsay-tools/cezarion#2231): scheduler tests now read `queue`,
`starting`, `waiting`, `monitoring`, `waitWakeQueuedAt`, `waitWakeAdmitted`,
`pendingJobs` and `pendingContinuations` through `runInternals(manager).line`.
The same instance owns the `releaseSlot`, `pump`, `busySlots`, `oldestQueuedAt`,
`oldestWakeAt` and `rescueStalledQueue` seams. The facade keeps `reviveQueuedRun`
for the function-module spy in `scoped-recovery.test.ts`; other queued-revival
calls go directly to `queued-revival.ts`. `pump` and `rescueStalledQueue` keep
async tracking wrappers so dropped calls retain their rejection behavior.

## Facade surface

Shipped code calls these 48 members from outside `run.ts`; Phase 5 may narrow their types but
keeps their names and signatures:

- Server routes: `isActive`, `claimForPublish`, `claimWorktreeReclaim`, `claimForBranchCleanup`,
  `adoptOrphanedRun`, `cancel`, `cancelAutoResume`, `editTask`, `respondPermission`,
  `sendMessage`, `enqueueMessage`, `deferMessage`, `editQueuedMessage`, `removeQueuedMessage`,
  `finishBlockedReason`, `finish`, `continueRun`, `startRun`, `startRunIdempotent`,
  `builtinSkills`, `setAutomationTools`, `setCockpitAddress`.
- CLI and project context: `recover`, `dispose`, `startRun`.
- Automations: `startRun`, `cockpitAddress`.
- Delegation: `setDelegationProvisioner`, `pauseWorkerCleanup`, `recoverWorkerCleanup`,
  `claimWorkerCleanup`, `selectDelegationExecutionSettings`, `builtinSkills`, `isActive`,
  `deliverConversationInput`, `continueRun`, `reconcileWorkerWaits`, `canClaimInboxInput`,
  `reserveInboxInputs`, `acknowledgeInbox`, `releaseInbox`, `registerRequestWait`,
  `registerPeerWait`, `enqueueOwnedRun`, `settleOrphanedWorkerExecution`, `steerWorker`,
  `requestWorkerStop`, `registerWorkerWait`, `cancelPeerWait`, `cancelWorkerWait`,
  `awaitRunTermination`, `takeWorkerTerminationBlocker`, `previewHost`.
- The semaphore registers five callbacks (the scheduler four now target `RunLine`): `busySlots`, `oldestWakeAt`, `pump`, `oldestQueuedAt`,
  `accountHolds`.

These members stay on the facade with no Phase 4 issue, and their code waits for Phase 5:
`completionGate` (complexity 20), `deferParentCompletion`, `acceptDone`, `finish`, `cancel`,
`launchQueuedRun`, `onDelegationRun` (complexity 20), `settleRequestedRootFinish`,
`holdContinuationForRootFinish`, `latchAgentInputError` and `steerWorker`. None is over 20, so
the Phase 4 exit still holds.

`run.ts` also keeps re-exporting the module-level names that shipped code and tests import:
`StartRunInput`, `DelegationExecutionSettings`, `AutomationToolService`, `PastedContent`,
`toPastedContent`, `isUntouchedCancelledRun`, and the constants and helpers tests import.

In hearsay-tools/cezarion#2227, module-level constants move to `run/constants.ts`; helpers move
to `workflow-position.ts`, `repo-root-lease.ts`, `run-guards.ts` and `worker-orphans.ts`, and
local types move to `run/types.ts`. The facade keeps its existing exports. The 35 uncalled
private delegators and getters listed in that issue are removed after the reader sweep;
their module implementations stay, including the `run-states.ts` via targets. No test seam changes.

`registerWait`, `cancelWait` and `registerWorkerListWait` stay public: they are agent-tool
entry points that tests drive (planner decision, 2026-10-29). Their test sites stay on the
facade. `registerAsk` has no test caller and its cezar-tools host calls `WaitRegistry` directly.
`disarmWait` stays on the facade to order watch teardown, family retry removal and process
watch teardown. `WaitRegistry.abortRegistrations` owns CI-registration abort-then-delete;
`WakeAdmission.disarmRunWaits` calls it before disarming watches.

Phase 5 (hearsay-tools/cezarion#2235) removes `recordTurnEnd` from the facade; it was a direct
integration-test drive, while shipped callers named it only in comments. The bookkeeping,
nudge, settlement and HumanWaits delegators listed in § Test seams are removed too. Public
agent-tool entry points and spied function-module seams remain.

Input delivery and receipt test seams now use module instances through `runInternals(manager)`
(hearsay-tools/cezarion#2234): readiness, submission, delivery and flush use `inputDelivery`;
queued hydration and deferred buffers use `queuedInput`; attachment writes and counters use
`attachments`. Restart submission observes `InputDelivery.prototype`. Liveness tests supply
`unreadInputGraceMs` through the constructor. Receipt callbacks call these instances and the
`input-timers.ts` functions directly. The public input and inbox facade members stay unchanged.

## Behavior questions

A move never answers these:

1. `deferredMessages` and `queuedImageSeq` keep entries after a run ends, and `dispose` keeps eight
   other maps: hearsay-tools/cezarion#2064.
2. Both launch paths honor a Stop or Finish accepted before the manager is disposed, by different
   routes. `awaitContinuationSession` checks `preserveRunAfterDisposal` itself. `awaitStepSession`
   returns on `isDisposedDelegatedRun` and leaves the decision to `nextAfterAgentStep` and
   `settleExecution`. hearsay-tools/cezarion#2193 pins both routes with a test before the two
   paths share code.
3. The `dropActive` order invariant in [Orders that must survive](#orders-that-must-survive) has
   no comment or test. The `run-settlement` move (hearsay-tools/cezarion#2200) adds both.
4. `supersedeFallbackThenWorkflowAsk` supersedes the worker fallback before checking for an unanswered ask.
   hearsay-tools/cezarion#2200 renamed it when it moved.
5. At Phase 4, `registerAsk`, `stopPreviewServer` and `autosaveCleanupBlocker` were public, but no shipped code
   outside `run.ts` calls them. The only caller of the first two is the cezar-tools host that
   `run.ts` builds, which `cezar-tools.ts` calls. `autosaveCleanupBlocker` has one test caller
   (`harness-autosave-settlement.test.ts`). `reconcileAllWorkerFamilies` delegates to
   `FamilyReconciler` and has test callers only (`delegation-reconcile.test.ts`). Phase 5 makes them
   private, points the host at the modules, or moves the tests. `registerAsk` now goes directly
   to `WaitRegistry` (hearsay-tools/cezarion#2232).
6. `stepLeftOpen` is now a pure read (hearsay-tools/cezarion#2233); each caller clears the
   consumed mark under its original conditions. A cancelled Continue keeps the mark, and
   nothing reads it before its `ActiveRun` is dropped; the difference is not observable.
7. At Phase 4, `disarmRunWaits` deleted entries from `ciRegistrations`, the map that `WaitRegistry` owns, from
   outside the registry. That goes against the Phase 3 exit. hearsay-tools/cezarion#2197 moves the
   loop verbatim and reads the map through `WaitRegistry`; hearsay-tools/cezarion#2232 gives the
   registry its own CI-registration teardown (`abortRegistrations`), called before watch teardown.

## Risks

| Risk | Mitigation |
|---|---|
| A spy counts zero or a fixture drain stops waiting | Decision 6 and the review question; Phase 5 replaces the seams with product hooks |
| A guard goes silent when code leaves `run.ts` | Phase 0 widens every path-bound guard first and proves each with a planted violation |
| Merge conflicts with feature work | Decision 10: a train of at most two PRs; imports move with their module |
| A host grows into a second god object | A host of about 12 members waits for its dependencies to move |
| Parity suite cost (57 files; the slowest take 95 to 167 seconds) | Phase 1 batches moves; CI's Vitest shards give the full verdict |
| Review load: move PRs exceed the auto-merge limits of 10 files and 400 lines | Owner review; verbatim moves keep `git diff --color-moved` readable |
| A move hides a behavior change | Decision 9 and the ordered side-effect list in each PR body |

## Evidence

Cezar task `da62f747` surveyed `run.ts` on 2026-10-28 at `e9872623f`, with five line-range
explorations and one cross-cutting survey (public surface, test seams, guards, tooling limits,
wiring and churn). The reports are task artifacts, not repository files; this spec carries what
the plan needs from them. Measurements:

```bash
node .ai/skills/check-code-quality/scripts/metrics.mjs packages/cezar/src/workflows/run.ts --json
git log --since=2026-09-28 --oneline -- packages/cezar/src/workflows/run.ts | wc -l
```

Between that survey and `fe9b5a183`, hearsay-tools/cezarion#2044, hearsay-tools/cezarion#2049 and
hearsay-tools/cezarion#2050 split `submitAgentInput`, `flushAgentInputs` and `dropActive`. On
`fe9b5a183` eight functions in `run.ts` are over complexity 20:

| Function | Complexity | Removed by |
|---|---|---|
| `recordReportedCost` | 28 | hearsay-tools/cezarion#2062 |
| `selectDelegationExecutionSettings` | 27 | hearsay-tools/cezarion#2057 |
| `workerIdentity` | 25 | hearsay-tools/cezarion#2057 |
| `recordUsageUiEvent` | 23 | hearsay-tools/cezarion#2062 |
| `openTimerAlias` | 23 | `turn-settler` (hearsay-tools/cezarion#2198); 20 on `97335b352` |
| `settleIdleBoundary` | 22 | hearsay-tools/cezarion#2196, after the move in hearsay-tools/cezarion#2192 |
| `handleAgentInputReady` | 22 | hearsay-tools/cezarion#2196, after the move in hearsay-tools/cezarion#2192 |
| `registerProcessWait` | 21 | `wait-registry`, Phase 3 |
