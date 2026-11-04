# Let the run store own run exits

Decision record: [ADR 0056](../../docs/adr/0056-let-the-run-store-own-run-exits.md). Glossary:
[Run exit](../../GLOSSARY.md#run-exit). Baseline: `main` at `60f6a9557`. Designed with the owner
on 2026-11-03 (architecture review, task f5410885). Slice 4.4 of epic hearsay-tools/cezarion#2487
(hearsay-tools/cezarion#2523) is slice S0 here.

Functions are named, with line numbers only as of the baseline; every slice moves them.

## Problem

`RunStore` (`runs/store.ts`) has about 117 public members. A caller must know rules the store
could enforce:

- **Which exit may write which status.** `RUN_EXITS` (`workflows/run-states.ts`) declares 21
  exits. Callers apply it in three ways: `RunManager.move`, a `status: transition(…)` value in a
  patch, or `transitionVia` around five store commits that write a status themselves. The check
  runs only in tests. There it throws: `transition()` before the caller writes, `transitionVia()`
  after the commit ran. Either way the caller sees a throw that the app never raises, so a test
  can take a different path from the app.
- **Which fields an exit settles.** 66 call sites each choose their own `finishedAt`,
  `currentStepId`, `activity`, step and Finish-intent changes. Sites of one exit disagree (see
  § Differences).
- **Durable or debounced.** `updateRun` decides from the patch's fields.
- **Which record rules run.** `record-write-rules.ts` keeps one rule list per write path. Four of
  the five commits after it was extracted fixed a rule that one path skipped
  (hearsay-tools/cezarion#2376 to hearsay-tools/cezarion#2382).

Seven writers bypass the table: six in the `run-status-write-outside-transition` baseline and
`setLiveStatus`, which the rule misses because its status is a variable.

## Decisions

1. **One entry point.** `RunStore` changes a status only by applying a run exit:
   "move run R by exit E", with extra fields the exit cannot know (an error message, a step id).
   `updateRun` and every other store method lose `status` from their patch types.
2. **The exit table lives in `runs/`** (`runs/run-exits.ts`). Each exit declares: `from`, `to`,
   the fields it settles, an optional named guard, and its durability. `workflows/run-states.ts`
   keeps `RUN_STATES`, `RUN_TRIGGERS` and `WAIT_KINDS` and imports the exits.
3. **One behavior for an undeclared transition.** The store writes it and records a violation.
   Production logs one warning. The test setup fails the test in `afterEach`. Nothing throws in
   the write path. `strictRunExits()` changes only how a violation is reported.
4. **Durability belongs to the exit**, with today's rule unchanged: a plain Finish stays
   debounced so a locked database cannot stop cleanup; Done with a completion option, handoff
   records and the archive options commit at once. The record rules become one ordered pipeline.
   A rule that differs between the saves on purpose is a named difference in that pipeline.
   Durability is decided in one of three ways, never by the caller's patch:
   - **by the exit**: each exit declares debounced or committed;
   - **by the record**: an exit to `done` commits when the run has a completion option, as
     `updateRun` decides today;
   - **by an enclosing commit**: an exit applied inside another commit (`resume` inside
     `commitOutcome`, `continue-*` inside `commitWorkerContinuation`) commits with it.

   Precedence, first match wins: an enclosing commit, then the record rule, then the exit's own
   declaration. Only an exit declared debounced can be raised to committed; nothing lowers a
   committed exit. So one status write always persists the same way for the same record and call.

   The one call-site choice today, `parkOnWaits` committing a park only when the run gives up its
   slot, becomes its own exit, `park-release` (same `from` and `to` as `park`, committed, clears
   `activity`, sets the step to waiting). Table A marks each exit's way.
5. **Exits replace status-writing commits.** `commitParked`, `commitRootFinishSuccess`,
   `commitRootFinishCancellation`, `commitWorkerCancellation` and `commitAutoResumeWithdrawal`
   become exits. Four have a precondition and get a named guard. A failed guard keeps the
   method's failure behavior today:
   - root Finish success and cancellation (a root with a pending Finish intent): write nothing,
     return false. They differ from `succeed`, `succeed-review` and `cancel` in guard, `from` set
     and durability, so they become their own committed exits: `succeed-root`,
     `succeed-root-review` and `cancel-root` (Table A rows);
   - worker cancellation (role worker): throw, because a non-worker here is a caller error;
   - the hold withdrawal (a usage-limit hold): write no status.

   `commitAutoResumeWithdrawal` also clears `autoResumeAt` and `autoResumeAttempts` on a run that is
   not a hold, without a status change. That cleanup stays a statusless store commit; only the hold
   case becomes the `withdraw-hold` exit. `commitParked` has no precondition; it becomes the
   `park-release` exit (Decision 4). `transitionVia` is deleted.
6. **The bypass writers become exits** (§ Table C). Then `run-status-write-outside-transition`
   and its baseline are deleted: the type refuses a status outside an exit.
   Test fixtures use `setRunStatus` in `runs/run-store.testkit.ts`, which calls the same
   update path as before. Production cannot import the helper.
7. **Slice 4.4 removes the four outcome baseline entries at their cause**: `commitOutcome`
   returns the waits it settled, and the outcome module provides the receipt fields of the
   `conversation-message` event. PR hearsay-tools/cezarion#2572.

## Slices

One pull request per slice, in order, because each touches `store.ts`. S1 starts beside this spec's own pull request. Each slice changes no app
behavior unless its row says so. Each slice runs `npm run test:parity` before push when it
touches a turn-end, wait or settlement path.

| Slice | Change | Removes | Behavior change |
|---|---|---|---|
| S0 | Slice 4.4 (Decision 7) | outcome baseline | none |
| S1 | Move `RUN_EXITS` to `runs/run-exits.ts`; Decision 3 | the throw in the write path | tests only: an undeclared transition now writes, then fails the test |
| S2 | `RunStore.move(id, exit, extras)`. `RunManager.move` and the five `status: transition(…)` patches call it; `commitOutcome` and `commitWorkerContinuation` take an exit instead of a status. `status` leaves the patch types of `move`'s extras, `commitWorkerContinuation` and `commitOutcome`'s dependency patch | direct status in the five patches; `transition()` | none |
| S3 | Decision 5 | `transitionVia`, five commits | none |
| S4a | Decision 6: every writer in Table C applies an exit. The store's load-time and archive writers use `applyExit` (`runs/run-exits.ts`) on the record in hand, and `move` writes through it. The Draft PR route takes its own exit, `draft-pr` (review, done, failed, cancelled → done); a Stop on load takes `cancel-late` | the status rule's baseline entries | none |
| S4b | `status` leaves `updateRun`'s patch type; test fixtures that set a status move to `setRunStatus` in `runs/run-store.testkit.ts`, guarded against production imports | status rule and baseline | none |
| S5 | Each exit settles the fields all its sites agree on (Table A). A site that does more passes an explicit extra; a site that does less uses a named variant of the exit | hand-written clears in 66 sites | none |
| S6 | Decision 4. Each exit declares its durability; `RunStore.move` takes it from the record rule (`doneCommits`), then the exit, never from its extras. `updateRun` keeps its field rule (handoff records, completion options) for writes that are not exits. The record rules become one ordered list, `RECORD_WRITE_RULES`, that every write path runs with its path as input; a rule one update save skips names its difference. `UpdateHooks` keeps what the store owns: redaction, the repository, the transcript and the save | `WRITE_PATH_RULES` path lists, ten of the fifteen `UpdateHooks` | none |
| S7 | Normalize Table B, one commit per row, each with a red test where it fixes a bug | the S5 extras and variants | yes, per row (§ Table B targets) |

## Case tables

### Table A: exits and what they settle

"Settles" is what the exit owns since S7 (Table B targets; the row that changed it is named). "Sites"
counts call sites at the baseline. SRF is `settledRootFinishPatch` (retires the root's Finish intent),
which `RunManager.move` added for every exit whose status is `failed` until S5. Durability: D
debounced, C commit.

**Settled** (S7, B1-B4) is what every exit that writes done, review, failed or cancelled writes over
its caller's extras: `currentStepId` cleared, the root's Finish intent retired, and
`finishedAt ??=` the caller's time, else now. "Live steps" are running and waiting steps; a step an
exit settles takes `finishedAt ??=` the run's settled time.

| Exit | from → to | Sites | Settles (all sites agree) | Guard | Durability |
|---|---|---|---|---|---|
| start | queued, running, waiting → running | 3 | nothing | none | D |
| start-held | queued → queued | 1 | `startedAt ??= now`, runner, systemPrompt, modelIdentity, `invalidAsk` cleared | none | D |
| requeue | queued, running, failed → queued | 6 | `currentStepId` cleared | none | D |
| continue-line | waiting, review, done, failed, cancelled → queued | 3 | `error`, `finishedAt`, `currentStepId` cleared | none | D by exit; worker C by enclosing commit (`commitWorkerContinuation`) |
| continue-now | same → running | 1 | `error`, `finishedAt` cleared; `currentStepId` = the step | none | D by exit; worker C by enclosing commit |
| park | running, queued, waiting → waiting | 14 | the step the caller names, else the current step, waiting unless it ended (B8) | none | D by exit; `park-release` (Decision 4): C by exit, clears `activity`, settles the step as `park` does |
| park-for-wake | queued, waiting → waiting | 1 | nothing | none | D |
| hold | failed, waiting → waiting | 1 + `failed.legacy-hold` | `finishedAt` cleared; `autoResumeAt` set | none | D |
| resume | waiting → running | 4 | nothing | none | D by exit; C by enclosing commit (`commitOutcome` at `sendAgentInput`) |
| succeed, succeed-review | running, waiting → done, review | 1 (`commitOrdinarySuccess`) | Settled, `autoResumeAttempts` and `activity` cleared, live steps done but the one the caller keeps (a worker's re-entry step, hearsay-tools/cezarion#1620) (B5) | none | D by exit; `succeed` only: C by record (completion option), since only `done` takes the record rule |
| succeed-root, succeed-root-review | waiting → done, review | 1 (`settleSuccessWork`) | as succeed, in one commit | root with a pending Finish intent; else no write, returns false | C by exit |
| accept-review | review → done | 1 | Settled (B6) | none | D by exit; C by record |
| draft-pr | review, done, failed, cancelled → done | 1 | Settled (B6); `pullRequestUrl` is the route's extra. The route refuses a usage-limit hold (B13) | none | D by exit; C by record |
| fail-start | queued, running → failed | 7 | Settled; `error` is the caller's; running steps failed, each keeping its own error, else the run's; a waiting step stays waiting, as the cursor a Continue resumes (B11) | none | D |
| fail | running, waiting → failed | 4 | as fail-start | none | D |
| fail-continue | running, waiting, cancelled → failed | 1 | as fail | none | D |
| fail-interrupted | queued, running, waiting → failed | 1 + `live.read-only` | as fail-start, with a fixed `error` | none | D |
| fail-crash | queued, running, waiting → failed | 2 | as fail-start | none | D |
| withdraw-hold | waiting → failed | 1 + `hold.archive` | as fail-start; `autoResumeAt`, `autoResumeAttempts` cleared | usage-limit hold | C |
| cancel | queued, running, waiting → cancelled | 10 + `queued.orphaned` | Settled; live steps cancelled (B10); one `run cancelled` lifecycle event when it moves the run into cancelled, its text the caller's when it names one (B12) | none | D by exit |
| cancel-root | waiting, cancelled → cancelled | 2 (`cancel`, `reconcileFamilyPass` repair) | as cancel, in one commit | root with a pending Finish intent; else no write, returns false | C by exit |
| stop-worker | all but cancelled → cancelled | 2 | as cancel (B4: keeps an existing `finishedAt`) | role worker | C |
| cancel-late | queued, running, waiting, done, review, failed → cancelled | 1 + `live.stopping`, `settled.stopping` | as cancel; the load-time Stop writes its event once the transcripts are readable | none | D |

Every exit also passes the store's status-driven rules: the stale-resume rule clears
`autoResumeAt` off a run that is not `waiting`, and a completion action is retired off a run that
is not `done` or not opted in.

### Table B: differences between sites of one exit

S5 keeps every row as it is (owner, 2026-11-03). S7 normalizes them (§ Table B targets). "Today" is the behavior at shipped defaults before S7.

| # | Exit | Today | Sites |
|---|---|---|---|
| B1 | fail-start | 4 of 7 sites clear `currentStepId`; 3 leave it | leave: `checkpointQueuedWorker`, `reviveQueuedRun`, `reviveQueuedWorker` |
| B2 | fail-crash | neither site clears `currentStepId` | `failCrashedContinuation`, `launchQueuedRun` |
| B3 | cancel | 5 of 10 `move` sites leave `currentStepId`; no `move` site retires the Finish intent (`reconcileFamilyPass` repairs it later) | leave: `cancelQueuedRun`, `cancelRunWithoutSession`, `settleStoppedContinuation`, both in `startExecution` |
| B4 | `finishedAt` on a settling exit | overwritten with now: `commitWorkerCancellation`, `commitAutoResumeWithdrawal`, `commitRootFinishSuccess`, every `move` but Draft PR; kept (`??=`): `commitRootFinishCancellation`, every store load-time writer, Draft PR | as listed |
| B5 | succeed | `commitRootFinishSuccess` clears `activity` and settles steps in its commit; `commitOrdinarySuccess` does neither in its patch (steps by side calls) | both |
| B6 | accept-review, draft-pr | Finish sets no `finishedAt` and retires the intent; Draft PR (its own exit since S4a) sets `finishedAt ??= now` and no SRF | `finish`, `POST /runs/:id/pr` |
| B7 | continue-line | the usage-limit Continue writes it twice: `acceptResumedContinuation`, then `dispatchAcceptedContinuation` | both |
| B8 | park | step → waiting is in the commit at one site (`parkOnWaits` without a slot), a side call at five, set earlier at two (`settleIdleClosedRun`, `settleIncompleteStep`), absent at six | side calls: `completionGate`, `handlePermissionRequested`, `handleNativeAskRequested`, `parkForUser`, `parkOnWaits` with a slot |
| B9 | requeue, park, continue-line, cancel | four requeue sites, six park sites, `acceptUntouchedContinuation` and `cancelQueuedRun` call `store.flush()` right after a debounced write: a second save, not atomic with the write | as listed |
| B10 | every exit to cancelled | Only `settleCancelledRun` (no step `finishedAt`) and `settleCancelledSuccess` (`finishedAt ??= now`) settle running and waiting steps to cancelled, and so does the store's load-time Stop `settleLoadedStop` when `run.stopping` is set (no step `finishedAt`). `settleCancelledContinuation` and `settleContinuationPrelaunchCancel` cancel only their own step. `cancelRunWithoutSession`, `settleStoppedContinuation` and both `startExecution` sites settle none | as listed |
| B11 | every exit to failed | Open steps settle per site: `recoverInterruptedRun`, `failRecoveredInvalidAsk` and `settleIdleClosedWorker` fail every running or waiting step; the Continue failure paths fail only their own step; the rest leave steps to the caller or settle none | as listed |
| B12 | cancel, cancel-root | The `run cancelled` lifecycle event is written by `settleCancelledRun`, `settleCancelledSuccess`, `settleCancelledContinuation`, `acquireContinuationRepoRoot` and the late Stop; `cancelQueuedRun` writes `cancelled while queued`; `cancelRunWithoutSession`, `settleStoppedContinuation`, `settleContinuationPrelaunchCancel`, both `startExecution` sites and `commitRootFinishCancellation` (`cancel-root`) write none | as listed |
| B13 | draft-pr | the route accepts a usage-limit hold no `RunManager` holds and writes waiting → done, an undeclared transition; the cockpit never offers it there | `POST /runs/:id/pr` |

### Table C: writers outside the table

| Writer | Writes | Condition | Exit | Trigger row |
|---|---|---|---|---|
| `store.ts:clearPendingAutoResume` (since S6 `record-write-rules.ts:withdrawHold`) | failed, `finishedAt ??= now` | archiving a usage-limit hold | withdraw-hold | `hold.archive` |
| `store.ts:settleLoadedStop` | cancelled, steps cancelled | `run.stopping` on load, **no status check** | cancel-late | `live.stopping`, `settled.stopping` |
| `store.ts:restoreLoadedUsageLimitHold` | waiting, `finishedAt` cleared | schema-7 row: failed with `autoResumeAt` | hold | `failed.legacy-hold` |
| `store.ts:failLoadedInterruptedRun` | failed, fixed error, steps failed | store opened without `keepLive`, engine-owned row | fail-interrupted | `live.read-only` |
| `store.ts:settleOrphanedRun` | cancelled | untouched queued run whose process is gone | cancel | `queued.orphaned` |
| `store.ts:setLiveStatus` | running→waiting, waiting→running | legacy wait rows (`upgradeLegacyWaits`) | park, resume | `running.legacy`, `plain.legacy` |
| `server.ts` `POST /runs/:id/pr` | done, `finishedAt ??= now`, `pullRequestUrl` | publish succeeded; **no status check in the route** | draft-pr | `review.draft-pr`, `settled.draft-pr` |

Two rows have no status check today: `settleLoadedStop` and the Draft PR route. S4 must show the
status each can meet. A status outside the exit's `from` becomes a recorded violation under
Decision 3, not a refusal. S4a found:

- **`settleLoadedStop` meets every status.** `stopping` is set while the engine still holds the
  run (`cancelActiveRun`, a starting run in `cancelRunWithoutSession`, `settleOrphanedRun`), and
  it is cleared only after the run leaves the active set. A Stop accepted during a Continue's final
  autosave meets review, done or failed (`settled.late-stop`, `failed.late-stop`), and a worker
  Stop records cancelled first (`stop-worker`). A process exit in that window leaves `stopping` on
  any status, so the writer takes `cancel-late`, whose `from` is every status but cancelled
  (cancelled to cancelled is a repeated write).
- **Draft PR meets review, done, failed and cancelled.** Task changes offers Create PR on every
  status but queued, running and waiting. Not landed offers Create draft PR on a done, failed or
  cancelled run's branch, and reclaimed rows are done. Both treat a usage-limit hold as live and
  do not offer it there. The exit is `draft-pr` (review, done, failed, cancelled → done). The route
  itself refuses only a run `RunManager.isActive` holds, so a raw `POST /runs/:id/pr` on a hold,
  which no `RunManager` holds, writes waiting → done. That write is not declared and records a
  violation under Decision 3, on purpose (B13).

### Transitions out

The state table does not change. `RUN_TRIGGERS` keeps every row; each row's `exit` names an exit
from `runs/run-exits.ts`, and its `via` names the store's exit entry point instead of
`transitionVia` or a bypass writer. `run-states.test.ts` keeps checking that every non-final
state has an automatic exit or a recorded human-only reason.

### Table B targets (S7)

S7 commits one row (or row group) at a time, each with a regression test that fails without it
(`runs/run-exits-settle.test.ts`). The S7 column marks the rows that landed.

| # | Target rule | Reason | S7 |
|---|---|---|---|
| B1, B2, B3 | Every settling exit (one that writes done, review, failed or cancelled) clears `currentStepId` and retires the root's Finish intent. `review` is not final (it has `accept-review` and Continue exits); `succeed-review` already does both | A settled run points at no step; a Finish intent has no meaning once the run settled. The family reconciler stops being the repair path for cancel | done |
| B4 | A settling exit keeps an existing `finishedAt` (`??=`); `continue-*` and `hold` clear it | The first settlement time is the fact; a later writer on a settled run only repairs | done |
| B5 | Both success paths clear `activity` and settle running or waiting steps in the same write | One exit, one result | done |
| B6 | accept-review and draft-pr set `finishedAt ??= now` and retire the Finish intent | As B3 and B4 | done: the Finish intent with B1-B3 |
| B7 | The usage-limit Continue writes `continue-line` once | The second write repeats the first | done |
| B8 | `park` settles the current step to waiting in the same write | As B5 | done, `park-release` too |
| B9 | Kept; recorded only. The follow-up `flush()` stays until S6 gives each exit its durability | S6 decides it | no change |
| B10 | Every exit to cancelled settles running and waiting steps to cancelled, with `finishedAt ??= now` | A cancelled run has no live step. The load-time repair (hearsay-tools/cezarion#2590) reuses this rule | done. Kept as written in S7 review: a Stop also cancels a waiting step, so a Continue after a Stop runs no remaining workflow step, as the live-session Stop already did before S7 |
| B11 | Every exit to failed settles running steps to failed. A waiting step stays `waiting`, for a root and an owned worker alike (decided in S7: the first text failed a root's waiting step too) | A failed run has no live step. A waiting step is the cursor a Continue resumes: a root's earlier workflow step (`settleIncompleteStep`), so a failed Continue does not lose the workflow's remaining steps, and an owned worker's re-entry step (hearsay-tools/cezarion#1620) | done |
| B12 | The cancel exits write the `run cancelled` event once, at every site | The web header (hearsay-tools/cezarion#2589) and the timeline read one event for one cancellation | done: the exit writes it when it moves a run into cancelled; a queued run's Stop keeps its text `cancelled while queued` |
| B13 | S7 decides whether the Draft PR route refuses a usage-limit hold, or `draft-pr` declares it | Until then the raw route records a violation; the cockpit offers no Draft PR on a hold | done: the route refuses a hold with 409 before any write; `draft-pr` keeps its `from` (owner review) |

## Open decisions

- **Refusing an undeclared transition in production** (ADR 0056) — after the S1 warnings have run
  on the dev channel.

## Coordination

Epic hearsay-tools/cezarion#2487 slice 4.1 (hearsay-tools/cezarion#2520) groups `ActiveRun`
fields in `workflows/run/*`. S2 and S5 shrink the patch literals in those files but do not touch
`ActiveRun`. The epic's planner gets each slice's PR number.
