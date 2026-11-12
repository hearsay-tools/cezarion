# Hold a run on a provider error instead of failing it

Issue: hearsay-tools/squawk#3337 (friction group CJ). Baseline: `main` at `cc3cead4b`. Designed
with the owner on 2026-11-12 in task 9986e564 (design track, `friction-design`).

## Goal

A provider error ends a run today and cancels its live workers, and `worker resume` refuses the
cancelled workers. Six runs lost about 4.9 hours to this. After this change:

1. A provider error holds the run and retries it with back-off. The run shows why it waits.
2. A failed parent leaves its live workers running.
3. `worker resume` restarts a cancelled worker, or a worker with no recorded session, from its
   worktree and branch.
4. `collect` on a failed worker names the runner failure.

## Evidence

- `workflows/run/auto-resume.ts`: a usage limit with a reset time already holds the run
  (`waiting` with `autoResumeAt`, hearsay-tools/cezarion#1236). Any other provider error fails it.
- `workflows/run/run-settlement.ts`: `settleFailedRun` wrote `fail`, and `afterDropActive` then
  moved the run to the hold. Between the two writes the family reconciler
  (`family-reconciler.ts`, `endStoppedParent`) saw a settled parent and cancelled its workers.
- Parity row R2 pinned "fails the run on a provider failure instead of parking it".
- `delegation/conversation-send.ts` refused `--resume` of a `cancelled` worker;
  `continuation-admission.ts` refused a worker with no session ("no agent session to resume").
- `delegation/results.ts` reported a failed worker's summary as `no-assistant-output`; the error
  was only in the separate `error` field.
- A root with live workers opens a monitoring timer at each turn end
  (`turn-settler.ts`, `monitoring-line`). A later step failure parks on that timer, and its wake
  delivery retries 3 times (15 s, 30 s) before the run fails. The hold below takes that last
  failure too.

## Product decisions (owner, 2026-11-12)

| # | Question | Answer |
|---|---|---|
| 1 | Which errors hold the run | Rate or spend limit (429, or limit wording with no reset time), credit balance, overloaded/529, HTTP 5xx, proxy 404 on the model endpoint, model access denied (401/403, model not available). A 400 request error, and every other error, still fails |
| 2 | How long it retries | 1 minute, doubling to 30 minutes, at most 12 retries (about 4 hours). Then the run fails with the last reason and the note `provider retry limit reached (12) — continue this task manually` |
| 3 | What a held run shows | The usage-limit hold UI with the reason, the retry time and the attempt: `provider error (rate limit: …) — retrying automatically at <time> (attempt n of 12)`. Rows read `provider error, resumes in 12m` |
| 4 | Live workers of a failed parent | They keep running. A human Stop of the parent, and a parent that ends `done` or `review`, still cancel them |
| 5 | `worker resume` of a cancelled worker | Allowed when its worktree and branch exist. A worker with no session starts a fresh one; its instruction says the earlier session is lost and the work is in the worktree. Destroyed workers are refused |
| 6 | `collect` on a failed worker | Summary source `failure`, text `Runner failure: <reason>`, before any assistant text |
| 7 | No-progress kill | A held run has no session, so the kill cannot fire. When the kill fires after the runner reported a provider retry in the turn, the error names that provider error and the run holds |

## Plan

### Classification

`core/provider-error.ts` `classifyProviderError(message)` reads the failure text every runner
already emits and returns a kind (`rate-limit`, `credit`, `overloaded`, `server`,
`proxy-not-found`, `access`) and a one-line detail, or `null`. A credit-balance text wins over a
400; any other 400 or `invalid_request_error` is `null`. `parseUsageLimit` still wins when the
text states a reset time. Shared code reads no runner id.

### The hold

The hold stays one state: `waiting` with `autoResumeAt` (`isUsageLimitHold`). A new optional
record field `autoResumeReason` (`usage-limit` | `provider-error`) says which kind. Absent reads
as `usage-limit`, so rows an older version wrote still parse and show as before.

`AutoResumeScheduler.holdFor(runId, error)` decides. `RunSettlement.settleFailedRun` and
`settleFailedContinuation` call it before their failure write. A hold is written by the new exit
`hold-failure` (running or waiting → waiting, steps as `fail`), in the failure's own write. No
reader sees a transient `failed`: the worker cascade does not run, and a parent's worker wait does
not resolve on a worker that is held. `afterDropActive` arms the timer (`armHeldResume`) before
it releases the slot, as before.

A provider-error hold blocks no account: `deriveAccountHolds` and `resumeInFlight` skip it, since
its error may be one model's, and a run that meets an account-wide limit holds by itself. A
usage-limit hold still blocks its account until its reset time.

`holdFor` returns no hold when: auto-resume is off (`autoResumeOnUsageLimit`, on by default), the
run is archived, a root asked to Finish, the error is neither kind, a usage limit has no session
to resume, or `autoResumeAttempts` reached 12 (it writes the cap note then).

The fire continues the run with the provider-retry prompt. A provider-error hold with no recorded
session sets `freshSession`, which admission accepts in place of a session, and the prompt
carries the task. A usage-limit hold with no session is still withdrawn at fire time.

### Workers

`endStoppedParent` returns before the child loop when the parent is `failed`. Its worker waits
and routed questions close as before, so a worker message reads "Not delivered: parent is
failed". The parent sees its workers after a Continue (`worker list`, `collect`). Restart
recovery does the same (`recoveryLeavesWorkerToRoot`), and a worker's Continue is admitted
beside a failed root, so a held worker's retry still runs.

An exact retry of an accepted `--resume` returns its stored receipt before the workspace check.

`--resume` of a `cancelled` worker is accepted (`assertSendResume`, `parentMessageRefusal`).
`DelegationService.assertResumableWorkspace` proves the worktree and branch with
`verifyOwnedWorkspace` before anything is accepted, for a cancelled or session-less worker. A
session-less worker's resume starts a fresh session (`sessionRefusal`'s `freshAllowed`), and its
instruction starts with `FRESH_SESSION_NOTICE`. A worker whose private execution checkpoint is
missing is still refused: that checkpoint is the proof no earlier process holds the worktree
(hearsay-tools/cezarion#469), and a checkpoint stuck in `starting` is already finalized by the orphan check when its
processes are gone.

### Collect

`collectWorkerEvidence` returns `{ source: 'failure', text: 'Runner failure: <error>' }` for a
`failed` worker with an error. The contract's `summary.source` gains `failure` (additive).

### No-progress kill

`startManagedSession` remembers the last runner `note` that classifies as a provider error, and
forgets it on any other event. When the kill fires with one remembered, its error ends with
`; the provider was failing: <note>`, which classifies, so the run holds. The Claude runner maps
its `system`/`api_retry` frames to such a note; Codex already emits one for `willRetry`.

## Case tables

### Transitions out

Rows live in `RUN_TRIGGERS` (`workflows/run-states.ts`); this table is the design view.

| State | Trigger | Who or what fires it | Behavior at shipped defaults |
|---|---|---|---|
| running | A step fails with a provider error, nothing owed | runner | `hold-failure` → waiting:usage-limit, reason `provider-error`, retry at now + 1 min (2, 4, 8, 16, 30 … min by attempt). Workers untouched (running.provider-error) |
| running | A usage limit with a reset time | runner | `hold-failure` → waiting:usage-limit, reason `usage-limit`, at reset + 30 s; no transient failed (running.usage-limit) |
| running | A step fails with any other error | runner | `fail` → failed; live workers keep running (running.fail) |
| running, waiting:capacity | A Continue's session fails with a provider error or a usage limit | runner | `hold-failure`, as above (running.continue-hold) |
| running, waiting:capacity | A Continue's session fails otherwise | runner | `fail-continue` → failed (running.continue-fail) |
| waiting (closing wakes owed) | A step fails | runner | Parks as today; at the delivery cap, the provider-error check above runs before `fail-continue` |
| waiting:usage-limit | The retry time passes | timer | `continue-line` → queued; a fresh session when no session is recorded (hold.fires) |
| waiting:usage-limit | The retry of a failed workflow step succeeds | runner | The hold saved that step as `workflowResumeStepId` (the current failed step; an earlier recovered one keeps its failed status and is not chosen), so the workflow's later steps run (`settleResumedWorkflowStep`). A provider retry runs on that step's own recorded runner (`retryRunner`, not an override, so the run's runner stays) and carries that step's rendered prompt |
| waiting:usage-limit | The retry fails again with a provider error | runner | Back to the hold, attempt + 1, the next delay |
| waiting:usage-limit | 12 retries ran | runner | `fail-continue` → failed, with `provider retry limit reached (12)` |
| waiting:usage-limit | Auto-resume off, window missed by a day, or refused at fire | engine | `withdraw-hold` → failed with the kept error and a note (hold.withdrawn) |
| waiting:usage-limit | Human Continue or message | human | `continue-line` → queued; resets the attempt count (hold.continue) |
| waiting:usage-limit | Stop with open waits, per-task cancel, archive | human | `withdraw-hold` → failed, as today (hold.stop, hold.cancel, hold.archive). A Stop also cancels a root's live workers |
| failed (root) with live workers | Stop | human | Accepted: its live workers are cancelled, the root stays failed (`cancelRunWithoutSession`) |
| waiting:usage-limit | One of its waits resolves | watcher | Stays held; the retry delivers it (hold.wait-resolves) |
| waiting:usage-limit | Restart, no session in memory | recovery | Re-armed from `autoResumeAt` and `autoResumeReason`; an older row without the reason reads as `usage-limit` (hold.restart) |
| failed (root) | Its live worker runs on and settles | worker | No cancel. The worker's result waits for `collect` after the parent's Continue |
| failed (root) | Restart | recovery | Its workers' routed questions close; its workers recover and run on (`recoveryLeavesWorkerToRoot`) |
| any worker state | A Continue (human, retry, recovery) while the root is failed | human, timer, recovery | Admitted: a failed root is not a settled parent for `settledParentRefusalError`. A `done`, `review` or `cancelled` root still refuses |
| cancelled (worker) | `worker resume` by its parent | parent | queued; same session if one is recorded, else a fresh one. Refused when destroyed, being destroyed, or its worktree or branch is gone |

Recovery with no session: a hold carries no session and no slot, so restart rebuilds it from the
record alone (`reconcileAutoResumes`). A provider-error hold whose run never recorded a session
retries in a fresh session instead of being withdrawn.

### Both ends: a held worker and its parent

| Worker state | Parent's worker wait | Parent settlement |
|---|---|---|
| running → hold (provider error) | Stays open: the worker is `waiting`, not settled | None; the parent's own turn goes on |
| hold → queued → running (retry) | Stays open | None |
| hold → failed (cap or withdrawal) | Resolves with the worker failed | The parent wakes as for any failed worker; `collect` names the failure |
| hold, then the parent fails | Closed with the parent | The worker keeps its hold and retries |
| hold, then the parent is stopped by a human | Closed | The worker is cancelled with its parent |

### Reader sweep

| Name or value | Readers changed |
|---|---|
| `autoResumeReason` (new) | contract `runRecordSchema`, `runSummarySchema`, summary keys; store schema; `withdraw-hold`, `withdrawHold`, `commitAutoResumeWithdrawal`, `clearAutoResume` clear it; cockpit hint and row meta; CLI attention label |
| `failed.hold` trigger | Removed: the settlement writes the hold directly. `failed.legacy-hold` keeps the load path for older rows |
| R2 parity row | Keeps "a request error fails the run"; a new row pins the hold |
| `mock:auth-error` as "a failing provider" in engine tests | Now a hold (401 is model access). Tests that need a failed run use `mock:request-error` |

## Older specs that disagree

- `2026-09-06-owned-workers-isolated-worktrees.md` § parent cancellation: a failed parent no
  longer cancels its workers. The rule line is edited there.
- `2026-10-17-unified-waits.md` worker-question table: "The parent finishes, stops or fails" no
  longer cancels workers when it fails. The row is split there.
- `2026-08-03-auto-resume-after-usage-limit.md`: the hold is written in the failure's own write,
  not after a `failed` write.
