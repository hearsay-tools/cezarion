# Slot release marking the pump due: slice 4.2 case table

Slice 4.2 is excluded. Row C5 changes stored messages and events. Each C1–C15 call
can also change auto-resume state before return when no workspace sweep is active
and the first sorted participant is live, is not recovering and owns an unarmed
hold that reconciliation arms or withdraws. A valid hold's timer set then differs
at return. A microtask drain does not meet the behavior-neutral condition for
hearsay-tools/cezarion#2521.

This is evidence and a design decision, not an implementation plan. It supports
phase 4 of hearsay-tools/cezarion#2487. No product code or skill change ships with it.

## Baseline and scope

Main read: `8c165fd9249caa274a30383d1bc4f18cfaebb529`, fetched on 2026-11-04.
The branch was fast-forwarded to that SHA before the investigation. The relevant
release, pump and auto-resume paths match the coordinator's earlier `3db328447`.
Run exits already belong to `runs/run-exits.ts`. `RunStore.move` applies them, as
[ADR 0056](../../docs/adr/0056-let-the-run-store-own-run-exits.md) requires.

The issue's “32 calls in 11 files” counts textual occurrences, not calls.
`rg -n 'releaseSlot\(\)|releaseSlot:' packages/cezar/src/workflows/run/ -g '*.ts'
(with tests and comments removed) finds 15 direct calls in nine caller modules,
eight forwarding calls in `compose.ts`, eight host declarations and the
`RunLine.releaseSlot` declaration. That is 32 occurrences across 11 files.
The earlier worker's 17 direct calls and nine adapters do not match this SHA.

## What happens before return today

`RunLine.releaseSlot` (`workflows/run/run-line.ts:179`) calls
`void this.context.semaphore.release()`. The `void` discards the promise. It does
not defer the function's synchronous prefix.

`WorkspaceSemaphore.release` (`workspace/semaphore.ts:227`) does this:

1. If a sweep is active, set `pendingRelease = true` and return. This call does
   not enter any pump before returning.
2. Otherwise set `broadcasting = true` and clear `pendingRelease`. Read each
   participant's `oldestWakeAt` and `oldestQueuedAt`. Sort wakes first, then queue
   age. Stable ties retain registration order. These reads include live account
   holds and store rows through `RunLine.oldestWakeAt`.
3. Enter the first sorted participant's `pump` before the first await yields.
   Later participants run only after the previous pump promise settles.
4. After all participants, repeat if another release set `pendingRelease`.
   Clear `broadcasting` in `finally`.

The manager adapter calls `RunLine.pump`. Its `pumpWork()` argument is evaluated
before `work.track('pump', promise)`. `pumpWork` first checks disposal and recovery.
If either holds, it returns without reconciliation. Otherwise it synchronously
calls `AutoResumeScheduler.reconcileAutoResumes`, even when `pumping` is already
true. It then sets `pumpAgain` on an active local pump, or sets `pumping = true`
and reaches `await getRepoInfo(...)`. Cached repository promises still yield.
No queue entry is dequeued and no run starts in this synchronous prefix.

At shipped defaults auto-resume is on. Reconciliation scans durable holds:

- A valid unarmed deadline calls `armAutoResume`: apply the `hold` exit, publish
  `autoResumeAt`, create an unref'ed timeout and add it to `autoResumeTimers`.
  A deadline due now creates a zero-delay timer. It does not fire inline.
- An unarmed archived, unreadable-deadline or exhausted hold is withdrawn. A hold missed
  by more than 24 hours is withdrawn with an expiry note. The store commits the
  withdrawal to `failed` and clears deadline and attempt fields before clearing
  its timer. The note follows the commit. Store notifications can run listeners
  synchronously. The settling exit also settles the fields ADR 0056 assigns it.
- An already armed valid hold is unchanged. The on path does not generally clean
  stale timer-map entries whose records are no longer holds.
- With the optional switch off, reconciliation withdraws every published or
  armed appointment, including stale deadlines. This branch is not needed for
  the exclusion verdict.

After the await, the pump discovers repository/config state, checks workspace and
project caps and account holds, selects eligible wakes before fresh tasks, removes
queue entries, checkpoints workers and launches jobs or continuations. Participant
pumps remain sequential within each workspace sweep. The timer callback later
rechecks its row, accepts a queued continuation or withdraws it, writes its resume
counter and lifecycle event, then pumps. These are distinct later boundaries.

## Exact scratch proposal

The approved spike adds one workspace-local `releaseDue` boolean, initially false,
and a synchronous `requestRelease(): void`. A request that sees false sets true
and queues one `queueMicrotask` callback. Another request while true does nothing.
The callback clears the bit and calls the existing `release()` once. The old
`broadcasting` and `pendingRelease` logic still handles requests during a sweep.
`RunLine.releaseSlot` calls `requestRelease` instead of `release`. Other direct
`release` callers, including `refresh`, keep their existing semantics.

“The current operation” here means the current synchronous JavaScript stack, up
to the next microtask checkpoint. It does not mean a `TrackedWork` operation, a
whole async method or the end of a public `RunManager` call. The semaphore owns
the drain. It has no new persistent state, timer, configuration or manager owner.
Several releases in one stack coalesce. Requests arriving after the bit clears
can schedule another drain; this is not a claim of one drain for all async work.

The drain reads the participants still registered when it runs. A disposed manager
unregisters and clears its local timers and queue. Its pending due request may
still pump other projects. With no participants, the drain does nothing. A manager
in recovery returns before reconciliation; recovery already rearms waits,
reconciles auto-resumes and pumps when its own recovery finishes. If recovery or
disposal begins between request and drain, the old synchronous prefix is lost.
A manager registered in that interval can join the new sweep. This differs from
today's participant snapshot. No promise from `requestRelease` makes a work-tracker
wait include the scheduled callback before that callback calls `pump`.

## Case table

Paths below are under `packages/cezar/src/`. Each row names a direct call, not an
interface declaration or adapter. **R** means the first sorted live, non-recovering
manager's synchronous reconciliation described above, when no workspace sweep is
already active. **D** means only the due bit is set; no release-induced
reconciliation runs before return. If a sweep is active today, the old call only
sets `pendingRelease`; R does not apply. Local writes and timers listed before a
release stay in place under the proposal.

Tests in the last column pin their named outcome. They do not prove return-time
timer equality unless explicitly stated. A coverage gap is not a passing cell.

| Row · Caller | Trigger | Reads or reliance after release | Timer and state at return today | Same under proposal | Observable outcome at shipped defaults | Pin or gap |
|---|---|---|---|---|---|---|
| C1 · `run/repo-root-lease.ts:acquireRepoRoot:51` | Wait for exclusive root lease | Await previous lease or cancel; then restore interrupt and unpark | Run already parked in line; interrupt hooked; R | Same lease state; D | Lease exclusion stays. An unarmed hold's timer or withdrawal is delayed; no start occurs inline today either | `run-lease.test.ts`: “does not let a lease-blocked run consume a parallel slot”; return-time gap |
| C2 · `run/turn-settler.ts:parkForUser:432` | Turn ends for user input | `queueWaitWake` reads row, holds and wake state | Waiting flushed; line parked; idle armed unless subagents hold pool; R | Same park/idle state; D | The following wake decision can see an unreconciled hold; timer set differs | `run/turn-settler.test.ts`: “user park updates and flushes waiting before line, pool, idle bound, release and wake”; mocked release, not timer proof |
| C3 · `run/worktree-autosave.ts:saveWorktreeWork` finalizer `:126` | Detached autosave cleanup ends with blocker | `onBlocked` already resolved `entry.settlement` at `:96`, so the run can settle while cleanup still holds the tree. Finalizer calls `settle()` again; it grants no new settlement | Maintenance release attempted; retained evidence cleared only if cleanup confirmed; reuse allowed only without a remaining blocker; scratch reap requested; R | Same cleanup and reuse conditions; D at the finalizer's release | Early run settlement stays independent of later cleanup. Reuse permission and slot release follow cleanup, while auto-resume reconciliation moves past that release | `core/harness-autosave-settlement*.test.ts` detached-holder rows; no return-time pin |
| C4 · `run/session-events.ts:handlePermissionRequested:311` | Runner requests permission | Return through event handler; ordinary input stays blocked | Permission flag and park written; idle/unread/held-input timers cleared; R | Same local flags and timers; D | Permission behavior stays for isolated case; unrelated hold withdrawal/timer healing moves | `permissions.test.ts`: “parks concurrent requests until their exact IDs resolve and blocks all ordinary input” |
| C5 · `run/session-events.ts:handleNativeAskRequested:336` | Runner asks a structured question | `routeWorkerQuestion` immediately reads parent status | Human alias and park exist; idle cleared; R can withdraw an expired parent hold before routing | Same alias/park; D leaves parent waiting during routing | **Changes messages and events**: expired parent closes question today; proposal can commit a request and parent input before withdrawal | `worker-questions-routing.test.ts`: active-parent routing; `auto-resume.test.ts`: missed-window expiry; combined boundary covered by scratch probe below |
| C6 · `run/run-finish.ts:completionGate:114` | Completion blocked by human ask, with active state | Return `held`; settlement callers preserve question | Warning, waiting write/flush, idle clear, pool leave and park complete; R | Same completion state; D | Held result stays; pending hold timer/state can differ at public return | `worker-wait-settlement.test.ts`: “readiness Finish preserves pending parent human questions”; `completion-gate-entry.test.ts` |
| C7 · `run/inbox-claims.ts:acknowledgeInbox:72` | Provider acknowledges receipt | Return acknowledgement through synchronous manager method; service returns receipt | ACK durable; expiry rearmed; waits/input/idle boundary settled; R | Same ACK; D | Receipt stays; caller can read old hold state before drain | `worker-inbox-liveness.test.ts` ACK action; `worker-wait-progress-inbox.test.ts` |
| C8 · `run/inbox-claims.ts:releaseInbox:82` | Provider releases receipt | Return `released` through manager/service | Claim released; expiry rearmed; waits reconciled and input delivery attempted; R | Same claim; D | Claim outcome stays; auto-resume state at return differs | `worker-inbox-liveness.test.ts` release action |
| C9 · `run/inbox-claims.ts:armInboxClaimExpiry.expire:104` | Claim timer expires | Exit callback's try; write failure uses existing retry | Expired claims cleared; waits/delivery/rearm complete; R | Same expiry; D | Claim expiry stays; auto-resume timer/withdrawal moves past callback tail | `worker-inbox-liveness.test.ts` expiry action; no return-time pin |
| C10 · `run/run-settlement.ts:afterDropActive:521` | Active execution leaves registry | Start retention; reap terminal scratch | Slot freed; usage-limit schedule already published and armed; family waits reconciled; R | Same newly scheduled hold; D for other unarmed holds | Publishing the failed run's hold before admission remains. Other hold withdrawals and events move after retention/reap requests | `run-settlement.test.ts`: “publishes a usage-limit resume before releasing a failed run with an open wait” |
| C11 · `run/wake-admission.ts:parkOnWaits:182` | Park session on nonhuman waits | Return true; caller treats park as complete | Park/park-release applied; line/pool set; worker/peer idle armed; wake requested; R unless an earlier nested release owns sweep | Same local park; D | Pool and park writes stay; timer equality is not preserved for unrelated holds | `worker-wait-capacity-wake-checkpoint.test.ts`: actual session-close case; capacity tests |
| C12 · `run/wake-admission.ts:leaveMonitoringPool:196` | Pool membership removed | Caller may arm idle, enqueue wake or release again | Pool removed; R may precede caller's idle arm | Pool removed; D; caller idle arm precedes reconciliation | Idle timer stays, but order relative to auto-resume timers changes | `workspace-semaphore.test.ts` (workflows): configured monitoring exemption; `run/turn-settler.test.ts` |
| C13 · `run/wake-admission.ts:queueWaitWake:227` | Existing wake needs another attempt | Return immediately | Wake remains in line; retry already requested; R | Same wake; D | No duplicate wake added; eligible project snapshot/reconciliation moves later | `worker-wait-inbox-boundaries.test.ts`: claimed message cannot acquire wake admission; exact drain boundary gap |
| C14 · `run/wake-admission.ts:queueWaitWake:233` | New live or sessionless wake | Return after queue/deferred continuation acceptance | Live wake queued, or sessionless `park-for-wake` and continuation accepted; R | Same accepted wake; D | Continuation remains scheduler-owned; auto-resume state differs at return | `worker-wait-capacity-restart.test.ts`; `worker-wait-terminal-ordering.test.ts`: older child before expired parent wake |
| C15 · `run/worker-executions.ts:finishWorkerExecutionWork:71` | Sessions, turns and deliveries settle | Resolve tracked worker finish; parent can observe completion | Completion checkpoint attempted; execution deleted/resolved; wake requested; stopping cleared; R | Same completion steps; D | Worker attestation stays; reconciliation may occur after worker completion is observed | `worker-wait-settlement.test.ts`; `worker-wait-disposal.test.ts`; no timer-at-return pin |

All eight `compose.ts` adapters forward directly to `modules.line.releaseSlot`:
session helpers `:322`, autosave `:336`, worker execution `:350`, inbox `:378`,
root lease `:384`, wake admission `:437`, settlement `:466`, turn settler `:506`.
`RunFinish` holds `RunLine` directly. The adapters add no await or timer boundary.

| Row · Additional case | Trigger | Reads or reliance after release | Timer and state at return today | Same under proposal | Observable outcome at shipped defaults | Pin or gap |
|---|---|---|---|---|---|---|
| X1 · Project A frees slot; B has oldest eligible queue | A parks or settles | Next pump must account for B's claim before another participant checks capacity | Sorted snapshot already captured; B entered R; queue not dequeued yet | D; snapshot and B reconciliation wait until drain | With stable participants/queues, same oldest run wins. Same-stack queue/hold changes can alter winner; neutrality is not proved | `workflows/workspace-semaphore.test.ts`: “a freed slot goes to the longest-waiting run across projects”; `workspace/semaphore.test.ts` ordered sequential pumps |
| X2 · Release during recovery | First participant is recovering | Recovery owns rearming and final pump | First pump returns without R; later participants follow after await | Drain can see recovery still active or already finished | Recovery's explicit reconciliation remains; intervening recovery completion changes which release prefix runs | `auto-resume.test.ts` waiting-hold restart; `worker-wait-capacity-restart.test.ts`; exact interval gap |
| X3 · Release after dispose, or dispose before drain | Late callback or same-stack shutdown | Disposed manager must not write/rearm; other projects still need capacity | Disposed participant already unregistered, or old R ran before disposal | Drain omits unregistered manager; other managers still pump | Strictly-after-dispose request with stable peers stays harmless. Request then dispose can suppress an old withdrawal/event | `worker-wait-disposal.test.ts`; gap for queued drain after unregister |
| X4 · No live session | Durable hold or resolved wait exists without active state | Scheduler-owned continuation and stored row drive next step | R reads store, not active map; timer heals or hold withdraws | D leaves timer missing or hold waiting at return | Absence of session does not remove the discrepancy; timer probe covers it | `auto-resume.test.ts`: missing-timer healing; sessionless wake restart tests |
| X5 · Two releases in one stack | Pool leave plus park/wake release | Second release must not lose capacity notification | First can run R and capture participant order; second sets pendingRelease and forces another sweep | One due bit and one initial sweep; later requests during drain retain existing resweep logic | Event/reconciliation count and snapshot point differ; unchanged queue start order is conditional on stable inputs | `workspace/semaphore.test.ts`: mid-sweep release reruns; no coalesced-stack pin |
| X6 · Usage-limit resume due now | Valid unarmed deadline at or before now, within missed window | Timer must exist when caller returns; callback later accepts continuation | R arms zero-delay timer before return; hold remains waiting until timer callback | No timer at return; drain arms it later | Acceptance rule fails even if eventual continuation is the same. Ordering against other timers can change | `auto-resume.test.ts`: timer healing, restart; future-timer probe plus `armAutoResume` code; due-now boundary gap |

The future-hold probe is also a deciding instance of X4: the caller has no live
session, but the timer set at return changes. X6 extends that reasoning to a due
appointment; it does not claim a separately measured due-now run.

## Decisive boundary

Use the first manager in an idle semaphore. Give it a durable parent root on a
usage-limit hold missed by 25 hours, with no process-local timer. Auto-resume is on
by default. Give its worker a pending native ask. The native-ask handler parks the
worker, releases a slot, then calls `routeWorkerQuestion` synchronously.

Today R commits the parent withdrawal first. `question-routing.ts:30` rejects a
failed parent as `parent-stopped`. Under D the parent still says waiting during
routing. With steer permission and space in the conversation and inbox, the
worker question commits a request and recipient input, then writes routing events
(`run/worker-questions.ts:84–98`). A later withdrawal cannot make that history
equal to never having admitted the request.

The scratch probe calls the real native-ask handler, composition, semaphore,
reconciler, routing and store. It builds the durable rows and ask directly. It
uses the normal active-state factory but launches no runner and calls no recovery.
It tests this boundary, not a full provider/restart scenario. Missing-timer healing
without recovery is already a supported path (`auto-resume.test.ts`: “never leaves
a deadline behind: a record with no armed timer heals on the next sweep”). The
same timer loss can affect a valid hold instead: baseline arms its timer before
return and the spike does not. That alone fails the explicit timer-set acceptance
rule, regardless of the routing example's reachability in a particular session.

## Spike evidence

The scratch branch was `scratch/2521-pump-due`, based on the main SHA above.
The spike changed only `workspace/semaphore.ts` and `workflows/run/run-line.ts`.
It was never committed or pushed. Its diff is kept locally at
`.ai/qa/2521/spike.diff` (ignored). Source was restored, then the task returned to
`cez/115618f4`. The final PR contains only this spec.

The two scripts below also live in ignored `.ai/qa/2521/`. They use the real
`RunStore`, `RunManager`, module composition and `RunLine.releaseSlot`. Each probe
uses a fresh temporary root and pins `CEZ_HOME` there. No process account or
credential value is read or printed. A `queueMicrotask` observation is taken after
the immediate return observation. Managers are disposed and tracked work settles
before their temporary roots are removed.

`probe.ts` creates one failed row, then applies `hold` with a future deadline
(60 seconds ahead), or a missed deadline (25 hours ago). It records status,
deadline presence and timer-map membership before release, at return and at the
next microtask. Each case has its own manager and semaphore, so the second case
cannot be masked by an earlier broadcast. No live session is present.

`native-ask-probe.ts` creates a root with spawn/wait/steer permissions, no inbox
inputs and no conversation messages. It puts the root on a 25-hour-missed hold.
It creates a running worker row with that parent, a work step and an
`ask.requested` event with one question. It creates state through `createActiveRun`
and calls `handleNativeAskRequested` through the manager's actual session-helper
host. It reads the parent's row/messages/inputs and the worker's routing/close
events immediately and after the microtask. It synthesizes the stored boundary;
it does not launch a provider or prove every restart interleaving.

| Probe command, run on unchanged main and then on spike | Baseline at return | Spike at return | Spike after drain microtask |
|---|---|---|---|
| `node --import tsx .ai/qa/2521/probe.ts` — future hold | waiting; deadline present; timer **present** | waiting; deadline present; timer **absent** | waiting; deadline present; timer present |
| Same command — expired hold | **failed**; deadline absent; timer absent | **waiting**; deadline present; timer absent | failed; deadline absent; timer absent |
| `node --import tsx .ai/qa/2521/native-ask-probe.ts` | Parent failed; **0 messages, 0 inputs**; worker `human-ask-closed` with `parent-stopped` | Parent waiting; **1 request, 1 input**; worker `worker-question-routed` | Parent failed; **1 request, 1 input remain**; worker also gets `human-ask-closed` with `parent-stopped` |

Both probe commands exited 0 on both versions. The first draft of the timer probe
shared a semaphore between cases and called a nonexistent work-settlement method.
It was corrected before the recorded comparison: use a fresh manager per case and
await the actual tracked promises. Those initial results are not evidence here.

The baseline parity command ran to its existing bound. It returned nonzero due to
missing verdicts, not a failing test. The coordinator accepted the two decisive
probes and instructed the worker to stop spike parity and focused waits, restore
source and finish this excluded spec. The stopped spike commands are not passes.
No test expectation, skip, retry, timeout or baseline changed.

| Check | Result and tested inputs | Host evidence (`/proc/loadavg`; `nproc`) |
|---|---|---|
| Baseline `npm run test:parity` | Squeal mode, 290 files; at the configured 900,000 ms + 300,000 ms bound: **91 PASS, 199 PENDING, 0 FAIL, 0 UNKNOWN**; exit 1. Not a suite pass. Persistent session 19722, node PID 4020574. Log `.ai/qa/2521/baseline-parity.log` | Start `33.72 26.09 21.88`; after result `14.51 15.87 17.14`; 24 CPUs |
| Baseline focused Squeal read (command below) | Revision 1, unchanged main source: **11 files current/pass, 4 pending** at the recorded read. Pending: autosave settlement success, worker question routing, worker wait settlement, wake checkpoint. Not a full focused pass. Log `.ai/qa/2521/baseline-focused.log` | Read start `10.11 20.66 20.95`; later sample `10.97 17.35 19.69`; 24 CPUs |
| Baseline probe commands above | Exit 0; observations in table. Final schema-shaped native-ask fixture repeated before spike | Nearby baseline probe sample `16.32 23.95 21.96`; 24 CPUs; no timing claim |
| Spike probe commands above | Exit 0; observations in table; uncommitted two-file diff | Run sample `14.51 15.87 17.14` before probes; `17.96 16.55 17.33` after; 24 CPUs |
| Spike `npm run test:parity` | Selected 290 files through Squeal; stopped before first verdict after coordinator exclusion decision. Persistent session 20633, node PID 303316; its owned child PID 303944 also stopped | Start `17.96 16.55 17.33`; stopped `24.79 18.42 17.93`; 24 CPUs |
| Spike focused Squeal read (same command below) | Stopped before a verdict, on coordinator instruction. Owned shell PID 307303 and child PID 307378 stopped. No full focused or parity pass claimed | Start `17.96 16.55 17.33`; stopped `24.79 18.42 17.93`; 24 CPUs |

The focused command uses Squeal's current results rather than duplicating its
Vitest runs. These files cover the caller outcomes named in the tables. The same
selection was requested for baseline and spike:

```sh
/home/agent/.codex/plugins/data/squeal-hearsay/bin/squeal status --wait 60000 \
  packages/cezar/src/workflows/auto-resume.test.ts \
  packages/cezar/src/workspace/semaphore.test.ts \
  packages/cezar/src/workflows/workspace-semaphore.test.ts \
  packages/cezar/src/workflows/run-lease.test.ts \
  packages/cezar/src/workflows/run-settlement.test.ts \
  packages/cezar/src/workflows/run/turn-settler.test.ts \
  packages/cezar/src/workflows/permissions.test.ts \
  packages/cezar/src/workflows/autosave-gate.test.ts \
  packages/cezar/src/core/harness-autosave-settlement-success.test.ts \
  packages/cezar/src/workflows/worker-inbox-liveness.test.ts \
  packages/cezar/src/workflows/worker-wait-disposal.test.ts \
  packages/cezar/src/workflows/worker-wait-capacity-restart.test.ts \
  packages/cezar/src/workflows/worker-questions-routing.test.ts \
  packages/cezar/src/workflows/worker-wait-settlement.test.ts \
  packages/cezar/src/workflows/worker-wait-capacity-wake-checkpoint.test.ts
```

A passing suite could not override either observed difference. Missing suite
verdicts also cannot establish neutrality. The exclusion rests on the paired
return-boundary and stored-message observations, not the partial parity result.

## Verdict and interactions

**Row C5 changes observable behavior. Exclude slice 4.2.** The timer-set acceptance
condition also fails for a first participant with an unarmed valid hold. Do not
create an implementation PR for this mechanism. No source, test, expected outcome,
configuration or skill text changes in this PR.

The existing `load-bearing-change/SKILL.md` paragraph **“List each handler's
side effects, in order, before you merge handlers into one.”** stays until slice
4.1 P5 pins the order this investigation found: park the worker, release with
synchronous reconciliation, then let `routeWorkerQuestion` read the parent's
status. P5 also needs tests for X4's future timer and X6's due timer at return.
Those tests are the input P5 needs before it deletes the handler-order block.
Excluding slice 4.2 does not block that separate replacement of prose with tests.

The paragraph **“Preserve queue-head reads when changing queue boundaries.”**
stays until slice 4.1 P6 supplies its queue-head tests. P6 owns its retirement;
this spec does not keep it forever. The paragraph protects the participant
snapshot and queue eligibility reads discussed here. Both paragraphs' current
expiry comments name hearsay-tools/cezarion#2520. There is no separate pump-specific
paragraph to delete for hearsay-tools/cezarion#2521. This exclusion adds no
workaround rule; it records why the approved cleanup cannot land.

Slice 4.1 (hearsay-tools/cezarion#2520) can group `ActiveRun` fields and queue/slot
ownership without changing this synchronous release boundary. Its spec must keep
the store-owned hold writes and the first-participant reconciliation order. An
owner move does not establish that a deferred drain is safe.

Commit the native-ask and future-hold probes as regression tests in the P5 PR
that deletes the handler-order paragraph. Use a real temporary `RunStore`, a real
`RunManager`, the existing active-state factory and normal composition. Launch no
runner. Keep a single first-sorted manager and no in-flight sweep so the boundary
is deterministic. Assert these outcomes before yielding:

- For C5, seed an unarmed 25-hour-missed parent hold, a running worker and its
  pending native ask. Call the native-ask handler. Assert parent status failed,
  deadline absent, zero parent conversation messages and zero parent inputs.
  Assert the worker has `human-ask-closed` with `parent-stopped`, and no
  `worker-question-routed` event. These assertions fail under the deferred drain.
- For X4, seed a valid future hold without a timer and no live session. Release
  the slot. Assert the timer exists immediately, before an await or a microtask.
  Assert the row remains waiting with its deadline. This fails under the drain.
- For X6, use the same fixture with a deadline due now. Use fake timeout control
  so the callback cannot run before the assertion. Assert a zero-delay timer is
  armed at return and the hold remains waiting. Then let the callback run and
  assert the ordinary queued continuation or documented refusal, as the fixture
  permits. Do not treat the future-hold probe as proof of this unmeasured row.

P5 must record red results under the deferred-drain spike and green results with
today's synchronous release. The current probes are investigation evidence, not
committed regression tests. P5 owns adding and maintaining those tests.

Slice 4.3 can remove `runInternals(` assertions on `line.pump`, `line.queue` and
`line.busySlots`, but it must keep their outcomes: workspace order and caps,
publication of holds before admission, wake ownership, recovery and disposal.
Replace internal reads with store rows, events and actual run-start signals. A
passing final-state assertion does not pin the timer set at a synchronous return.
Do not revise expected messages or events to accommodate the excluded drain.
