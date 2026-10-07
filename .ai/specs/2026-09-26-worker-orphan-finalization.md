# Finalizing a crashed worker's execution proof (hearsay-tools/cezarion#469)

Status: approved design (2026-09-26), revised with human approval for hearsay-tools/cezarion#738 (2026-10-04) and
for hearsay-tools/cezarion#889 (2026-10-07), which reverses #738's rule that an unreadable cwd is a possible holder. Extends
`2026-09-06-owned-workers-isolated-worktrees.md` ("destroy awaits proven termination").

## Problem

A worker's private `<id>.execution.json` moves `queued → starting → complete`. Only the live
manager writes `complete` (`finishWorkerExecution` → `persistWorkerCompletion`). When the
controller process exits mid-worker, the proof stays `starting` forever:

- `awaitRunTermination` returns false, so `worker destroy` reports
  `Worker termination is not proven; retry cleanup later` on every retry and the owned
  worktree and branch leak;
- `commitWorkerExecutionStart` refuses to replace an incomplete generation, so recovery,
  `worker send --resume` and a parent's reply to a routed question all fail with
  `worker execution checkpoint unavailable` (comment on hearsay-tools/cezarion#469, reproduced on v0.14.9);
- `collect` stays `settled: false`.

The conservative rule is right while a process of that generation lives: in the hearsay-tools/cezarion#469
reproduction both a Claude and a Cursor agent outlived a SIGTERM'd cockpit by minutes. The
bug is that nothing ever proves the opposite, so the state has no exit.

## Goal

When cezar can prove that every process of a stuck generation is gone, it completes that
generation's proof. Recovery, resume, message delivery, `collect` and `destroy` then work
through their existing paths. When `destroy` finds a surviving orphan it can identify
exactly, it terminates it first.

Never: complete a generation while one of its processes runs, delete a worktree a live
process holds, or signal a process cezar cannot tie to that generation.

## Design

### 1. Durable process record — `<id>.processes.json`

A second private file next to `<id>.execution.json`, written with the same discipline
(`0600`, `O_NOFOLLOW`, tmp + fsync + rename, strict zod, size cap):

```json
{ "generation": "<uuid>",
  "controller": { "pid": 1234, "startToken": "..." },
  "processes": [{ "pid": 5678, "startToken": "..." }] }
```

- `commitWorkerExecutionStart` writes it fresh with the new generation and the current
  process as `controller`, before it returns.
- Both session-start sites that call `registerRunProcess` (`workflows/run.ts`, the fresh
  and continuation paths) append `{ pid, startToken }` for a worker run, bound to the
  current generation. A write failure is logged and ignored: the working-directory scan
  below still covers that process.
- `processes` is capped (32). Past the cap, the generation cannot be proven by record and
  falls back to the working-directory scan. It never drops an entry.
- Reading is tri-state. Only `ENOENT` is **absent** (legacy: scan only). A record that is
  present but unreadable, has the wrong mode or size, fails the schema, or names another
  generation is **unknown**: no finalization and no reap. Destroy then reports
  `worker process record is unreadable; termination cannot be proven`.

`startToken` identifies one process incarnation, so a reused PID never matches:

- Linux: `<boot_id>:<starttime>`, from `/proc/sys/kernel/random/boot_id` and field 22 of
  `/proc/<pid>/stat` (parsed after the last `)`). The prefix rules out a match across a
  reboot. If `boot_id` is unreadable, the token is the start time alone. For liveness only,
  a token that has the prefix and one that lacks it are compared by start time; reaping
  requires an exact match;
- macOS: `ps -o lstart= -p <pid>` with `LC_ALL=C TZ=UTC`, so locale and zone cannot change
  the token;
- elsewhere, or on failure: absent. A token-less entry counts as alive while the PID
  exists.

### 2. Liveness probe — `src/delegation/process-liveness.ts`

A synchronous, dependency-free module (a sync probe lets `continueRun` stay sync):

- `processStartToken(pid)` as above.
- `processesWithCwdUnder(dirs)`: the worker's worktree and every agent tmp dir location
  (`agentTmpDirLocationEvidence` supplies both candidates and discovery completeness). Independent
  cleanup can delete terminal-task scratch; execution settlement cannot. Live tasks retain
  scratch across finalized process generations and restart (hearsay-tools/cezarion#515). Linux reads `/proc/*/cwd`.

  **An unreadable cwd is no evidence (hearsay-tools/cezarion#889, approved reversal of the
  hearsay-tools/cezarion#738 rule that uncertainty never authorizes cleanup).** A cwd that cannot be read, for
  any reason, is skipped: a process that vanished (`ENOENT`), another user's (`EACCES`), and a
  non-dumpable process of our own user (`systemd --user`, the login `sshd`, `sd-pam`,
  `gpg-agent`, which every host has). Under #738 the last kind was a possible holder, and three
  carve-outs followed, each excusing one member of the same class: an age cutoff
  (hearsay-tools/cezarion#858), a foreign-ancestor walk (hearsay-tools/cezarion#874) and a proposed third
  (hearsay-tools/cezarion#877). Workers still sat in destroy's 60-second retry loop (hearsay-tools/cezarion#879), and the
  same false positive kept interrupted reviewers in `starting` at the wait layer
  (hearsay-tools/cezarion#855). The cutoff, the ancestry walk, the candidate/uncertain machinery
  and same-boot abandonment (hearsay-tools/cezarion#839) are gone. A process blocks destroy, reuse,
  admission, scratch cleanup and history deletion only when one of these holds:

  - its cwd is readable and under the worktree or a scratch location;
  - it is a live, token-verified recorded process of the generation;
  - it is a live foreign controller.

  A scan that cannot list processes at all (`/proc` unreadable, `lsof` failing or missing)
  stays `unknown`. Accepted risk: a worker descendant that made itself non-dumpable (an agent it
  started, a setuid helper) while working inside the worktree is not seen, and destroy may delete
  the directory under it; a recorded process still blocks whatever its cwd. Signalling a worker's
  own leftover children is hearsay-tools/cezarion#890.

  **Execution and resource proofs are separate.** A valid Linux controller boot UUID different
  from the current readable boot UUID proves old descendants cannot survive, but only after
  checking that neither the controller nor any recorded process is live.
  `inspectExecutionGeneration` uses this fast proof without scanning paths. Unknown, malformed
  and legacy boot identities keep the descendant scan. Unknown scratch locations prevent a clear
  partial scan from returning `gone`; readable holders still report their live PIDs. This
  completeness check follows the known-reboot fast proof, so uncertainty in cleanup metadata
  cannot reintroduce a holder scan into reboot settlement. A same-boot crash whose recorded
  processes exited settles as `gone`, however many unreadable processes remain: execution is
  never abandoned. Checkpoints an older cezar wrote with `abandoned: true` still parse, keep the
  flag and refuse a new generation.

  `inspectGeneration` is the independent **resource** proof. It always scans every protected
  worktree/scratch path with no boot exclusion and no age exclusion. Readable holders and live
  recorded processes block, and the incomplete destroy error names their PIDs. Only a fresh clear
  scan plus generation/resource ownership permits deletion or reuse. A readable holder exiting or
  leaving the protected paths clears it; elapsed time or reboot cannot. Unknown evidence is
  retained, never silently dropped.

  macOS uses `lsof -a -d cwd -Fpn` with a bounded timeout. A process `lsof` cannot read is
  omitted from its output, and that omission is no evidence either; there is no second process
  table. It excludes `process.pid`, compares realpaths, and matches a dir itself or anything
  beneath it. cezar's own `git` children in the worktree make the scan read `alive` for a moment;
  that is conservative, and it clears on the next probe.

  win32 has no cwd scan and answers no holders. Recorded processes decide, judged by PID alone
  since win32 has no start token, and the checked `git worktree remove` is the proof: Windows
  refuses to delete a directory that is a process's current directory, and a failed removal
  leaves destroy `incomplete` for the next retry. Any other platform returns `unknown`.
- `inspectGeneration({ record, paths }) → { liveness: 'gone' | 'alive' | 'unknown', controller?, pids }`
  (`probeGeneration` returns only `liveness`):
  - `alive` when the controller is live and is not this process, when any recorded
    process is live with a matching token, or when any process has a working directory
    under the worktree;
  - `unknown` when the scan cannot run;
  - `gone` otherwise.

  A missing record (legacy, as in the toolkit-dev incident) relies on the scan alone.

**The controller rule.** A generation whose controller is this same process is never
finalized by this mechanism. The in-memory execution map owns it, and a disposed manager's
still-running sessions look like orphans. This keeps same-process reopen behaviour (the
existing surviving-process tests) unchanged. A live foreign controller means a second cezar
owns the worker, and that makes it `alive`.

### 3. One finalizer on the manager

`RunManager.settleOrphanedWorkerExecution(runId): boolean` (sync, no signals). It applies
only when all of these hold: the run is an owned worker, the manager is not disposed, it
has no `executions` entry, the run is not active, and the execution proof is readable with
`phase: 'starting'`. `queued`, `complete`, missing and malformed proofs are untouched. A
missing or malformed proof stays unproven, as the existing tests pin. On `gone` it:

1. calls `store.commitWorkerExecutionComplete(runId, generation)`, which rechecks the
   generation;
2. appends a lifecycle event:
   `the interrupted worker's processes are gone; its execution was finalized`;
3. schedules independent terminal scratch cleanup, as `persistWorkerCompletion` does. No
   synchronous resource probe or deletion runs on the collection/Finish settlement path.

A result other than `gone` is cached per run and generation for 2 s, so polling callers
(`collect`, inspect, the re-probe timer) do not rescan: a scan on macOS runs `lsof`
synchronously. Callers that act once pass `fresh`: admission, and each step of the destroy
reap.

Callers:

- **`recover()`** runs it for every worker before computing `retained` and before the
  live loop, so an interrupted worker re-launches through the ordinary `continueRun` path.
- **`beginWorkerExecution`** runs it first (`fresh`) when no execution exists. This one
  site covers Continue, `--resume`, parent replies (hearsay-tools/cezarion#505) and queued revival. Over a live
  orphan, the refusal names the process:
  `a process of the previous execution is still running (pid N)`, or
  `the worker is still controlled by a live cezar (pid N)` when a foreign controller lives.
- **`collect` / inspect** in `DelegationService` run it before computing `settled`, so an
  orphan that died after recovery settles without a destroy.
- **`awaitRunTermination`** runs it when there is neither an execution nor a
  `finalizedWorkers` entry.
- **The re-probe timer** is what fires when a survivor dies after recovery. `recover()`
  arms one unref'd timer for each orphan it could not finalize (`alive`, `unknown`, or a
  failed commit). It probes every 15 s for the first 15 minutes, then every 60 s with no cap,
  so a survivor that lives for hours is still noticed when it exits. It skips a tick while the
  run is queued or active, and it stops on finalization, a changed generation, a deleted run,
  an unknown record, or dispose. Finalization emits `run`,
  which reconciles the parent's worker waits, so a parked parent wakes.

### 4. Reaping on destroy

`awaitRunTermination(runId, timeoutMs, { reapOrphans: true })` is passed only by
`destroySerialized`. It applies when the finalizer's preconditions hold, the probe says
`alive`, and the controller is dead or unrecorded (legacy). A legacy generation has nothing to
signal, so it skips step 1 and still waits in step 3:

1. For each recorded process whose token still matches: SIGTERM. Poll for up to 10 s,
   **re-verify the token**, then SIGKILL, all inside the caller's timeout (30 s).
2. Processes found only by the working-directory scan are **never signalled**. The probe
   waits for them until the deadline.
3. Poll every 500 ms, re-probing, and finalize on `gone`. Otherwise it returns false,
   and destroy stays `incomplete` with `process` remaining. The error names the blocker:
   `process N still holds the worker's worktree or scratch` (plural: `processes N, M still
   hold`), or `the worker is still controlled by a live cezar (pid N)`. A
   `destroy blocked: …` lifecycle event is appended only when the blocker set changes, so
   a retry loop does not flood the history.

A live controller, or a controller that is this process, is never reaped from. The first
belongs to another cezar. The second is the ordinary `cancel` path.

### 5. Durable independent cleanup and admission fencing

The private execution checkpoint records terminal scratch-cleanup intent (resource identity and
workspace path) atomically alongside the completed generation. An intact terminal worker record
can reconstruct this optional field for older checkpoints; no new configuration is needed. Starting
a new generation drops the prior intent. `WorkerScratchCleanup` discovers
private sidecars independently of the run index, so corrupt/missing `runs.json` and quarantined
worker rows cannot make local or fallback scratch eligible for the generic orphan sweep. Even
unreadable/malformed sidecars reserve those locations. Missing terminal intent is uncertainty,
not permission to remove a legacy worker's scratch; restoring usable evidence permits retry.

Recovery and project reattach reconstruct timers. The first attempt is deferred; each incomplete
attempt retries after the same 60-second cadence as pending destroy, without an agent slot, age
limit or force deletion. Disposal/detach cancels timers, including failed evidence-discovery retries.
A timer stops when resources are removed or a known task ceases to be terminal. A changed
generation/resource invalidates the captured operation; the new completed generation supplies
its own intent. Unknown execution/process evidence and path permission errors retain files and
keep periodic rechecks alive. If the private evidence directory itself cannot be enumerated, the
sweep retains all scratch and retries discovery; once readable, ordinary orphan sweeping resumes
and terminal worker scratch again requires fresh holder proof.

A saved fallback location remains a holder candidate even when its `.cez-owner` cannot be read.
Unknown/malformed pointers or ownership block deletion and reuse; they never become an empty
location list. Fallback directories are removed before the local pointer. Before recursive removal,
an atomic private receipt under local scratch binds previously verified ownership to that fallback's
device, inode and birth time. This survives an interrupted removal that already deleted the owner
marker. A missing marker may use only the matching receipt; unreadable/foreign ownership still
blocks, and the receipt cannot authorize a replacement directory. Failed fallback removal retains both pointer and receipt, so
restart and the ordinary 60-second retry can finish after permissions and holders clear. The local
pointer/receipts are removed only after every fallback is proven absent.

Pointer and removal-receipt reads are independent: neither failure discards a candidate discovered
by the other. Malformed/unreadable evidence marks the list incomplete, which also blocks legacy
execution settlement after known holders exit. The orphan reprobe keeps its existing 15-second,
then 60-second uncapped cadence; evidence restoration permits settlement on a later probe. A
known-reboot execution proof remains independent, but incomplete discovery always refuses cleanup
or reuse. Removal receipts continue to require exact directory identity; their location value alone
never authorizes deletion.

Destroy remains an explicit persisted request for worktree/branch removal. Collection alone never
requests it. Existing authorized retention after parent Finish keeps its behavior, with the same
fresh holder proof and preserved parent result required. Destroy retains the immutable parent
result before destructive work and returns settled-but-cleanup-incomplete when holders remain.
The ordinary 60-second destroy timer rearms after recovery and retries until independently safe.

Cleanup and execution admission exclude one another. Scratch's fresh ownership/generation/probe
and deletion are synchronous with no yield; asynchronous workspace cleanup holds the manager's
admission claim and rechecks generation, resource, attachment and holders immediately before Git
removal. Every new worker generation passes the store's fresh resource guard, including Continue,
resume, replies and pump admission. A stale retry cannot delete a newer execution's resources.
History deletion checks holders before removing evidence, removes scratch while process/generation
evidence still exists, and refuses to forget an intent whose scratch removal failed.

The original hearsay-tools/cezarion#738 acceptance criterion that cleanup always succeeds after reboot is explicitly
narrowed: **execution settlement, collection and parent Finish unblock once execution is proven
terminated; eventual cleanup requires independent fresh proof that no readable holder, live
recorded process or live foreign controller remains. If that proof never becomes available, files
remain indefinitely.** An unreadable cwd never withholds that proof (hearsay-tools/cezarion#889).

## Not changing

- Shutdown still leaves sessions running (`dispose()` contract); reaping at SIGTERM is out
  of scope.
- `commitWorkerExecutionStart`'s refusal to replace an incomplete generation is unchanged.
  The finalizer completes the old generation first, through the existing
  `commitWorkerExecutionComplete`.
- No new env var, no config, no HTTP or contract change. An unsupported platform keeps
  today's behaviour.

## Known limitations

- Legacy process records without a controller boot ID, or an unreadable current Linux
  boot ID, cannot use the hearsay-tools/cezarion#738 reboot proof. Those generations keep the
  descendant scan, where only readable cwds and live recorded processes block
  (hearsay-tools/cezarion#889).
- A non-dumpable worker descendant inside the worktree is invisible to the scan, and destroy may
  delete the directory under it (hearsay-tools/cezarion#889). On win32 the recorded processes and
  the checked Git removal are the only proof.
- Reaping signals only the recorded session leader. Runners do not spawn detached, so there
  is no process group to kill. A descendant that survives the leader keeps its cwd in the
  worktree, and the scan keeps destroy `incomplete` (naming the PIDs) until it exits.
- The scan sees only same-user processes in this PID namespace. A process in another
  container that holds the worktree is invisible to it.

## Tests

- `process-liveness.test.ts`:
  - token parsing (a comm with spaces and `)`);
  - a real child in a temp dir is found by the working-directory scan and not found
    after it exits;
  - an unsupported platform returns `unknown`;
  - PID reuse (token mismatch) counts as gone.
  - hearsay-tools/cezarion#889: an unreadable cwd (`EACCES`, `EPERM`, `ENOENT`, any other error)
    is no evidence, on Linux and on macOS (`lsof` alone), and a real `PR_SET_DUMPABLE=0`
    process never blocks either proof; readable holders and matching live process records
    still block. win32 answers no holders; an unlistable `/proc` is `unknown`. Legacy/missing
    tokens and unknown boot IDs keep the readable-holder descendant scan.
- `worker-reboot-parity.test.ts` (registered harness row R43): every `RUNNER_IDS` backend
  launches and exits through its `HARNESS_ADAPTERS` native mock wire. Both collect-first and
  destroy-first restore prior-boot interrupted evidence beside a successful collected twin.
  A real Linux Python process uses `PR_SET_DUMPABLE=0` while holding worktree or scratch;
  kernel cwd reads are genuinely denied. Those settlement paths never call the strict resource
  probe. Since hearsay-tools/cezarion#889 the process is no evidence: after restart, automatic
  production-cadence retries release both resources while it still runs, and nothing signals
  it. Completed cleanup cannot bypass the fresh history-deletion probe over a readable holder.
  Native continuation tests refuse reuse while a readable holder runs, then admit a new
  generation on real exit and prove stale retry cannot remove that generation's scratch. Only reboot evidence and enumeration scope are synthetic;
  permissions, tokens, runners, stores, Git and deletion are real.
- `worker-destroy.test.ts`, with a crash simulated by a dead controller written into the
  record and the `starting` proof restored:
  - dead child → `recover()` completes the proof, the worker re-launches or settles, and
    `destroy` is `complete` with the worktree and branch removed. **Must fail without the
    fix.**
  - recorded child ignoring SIGTERM → `destroy` reaps it (it exits by signal) and
    completes.
  - survivor found only by the working-directory scan (no record) → `destroy` stays
    `incomplete` with `process` remaining, the worktree is kept, and the child is not
    signalled.
  - live foreign controller → nothing is finalized or signalled.
  - legacy (no record) + no process in the worktree → finalized; this is the toolkit-dev
    class.
- The existing same-process pins (`terminal status without a private completion
  checkpoint…`, `refuses %s recovery and Continue over a surviving prior process…`,
  `cannot replace %s private execution evidence…`) stay green unchanged.
- `service.test.ts`: `collect` becomes settled after finalization.
- `worker-questions.test.ts`: the hearsay-tools/cezarion#505 "parent reply answers the worker after a restart"
  case also passes with the worker's pre-cancel `starting` proof restored and a dead
  controller.

## Implementation order

1. `process-liveness.ts` + tests.
2. Store: the process-record read/write, the write inside `commitWorkerExecutionStart`,
   and `appendWorkerProcess`.
3. Manager: record at both session sites, `settleOrphanedWorkerExecution`, and the callers.
4. Destroy reaping + service `collect` hook.
5. Regression tests, each shown red without the fix (`git stash push -- <sources>`).

## Verification of the approved hearsay-tools/cezarion#738 revision (2026-10-04)

- Baseline `d2c66da2`, production sources temporarily restored, native R43 filter
  `clears parent Finish`: **10 behavioral failures** (five collect cases deleted held scratch;
  five destroy cases incorrectly returned complete). Implementation source bytes restored exactly.
- Focused nine-file run: **265 passed** across `process-liveness`, `worker-reboot-parity`,
  `worker-destroy`, delegation `service`/`workspace`, workflow and run `agent-tmpdir`,
  `retention-enforce`, and `git-worktree-release`.
- `scratch-cleanup.test.ts`: **4 passed**, including unreadable execution/process sidecars
  becoming readable, a real denied path becoming accessible on the default retry cadence,
  and fresh absent-resource admission despite ambient denial while retained-path reuse is refused.
- Harness registration guard (`every criterion is a live row`): **1 passed**.
- `npm run build:server`, `npm run typecheck:server`, `git diff --check`: passed.
- R43 scopes only `/proc` enumeration to its explicit real holder PIDs and, for continuation,
  recorded native child PIDs. Other focused lifecycle fixtures enumerate their own process tree
  and previously observed descendants, excluding ambient daemons and parallel test workers.
  Real kernel cwd denial is asserted; the holder writes after settlement/probes and is never
  signalled by cleanup. Prior boot evidence is synthetic. Linux-only permission cases do not
  claim macOS permission coverage; injected-reader tests retain its conservative policy checks.
- Full repository/browser gate, independent review, PR changes and integration remain with the
  parent task by assignment.

### Index-loss review follow-up (2026-10-04)

- Baseline `e8b73436`, four changed production sources restored temporarily: filter
  `index recovery` in `scratch-cleanup.test.ts` produced **six behavioral failures**.
  Corrupt, missing and quarantined index cases each deleted held local and owned fallback
  scratch. Every failure was the retained-file assertion, not a missing helper or mock.
  All implementation source bytes were restored exactly in `finally`.
- Focused seven-file run: **186 passed** across scratch cleanup, run/workflow temp directories,
  native R43, worker destroy, delegation service and retention. The finalized scratch fixture
  additionally reran **18 passed**, using production fallback creation/ownership markers.
- The reviewer's standalone real-Linux reproduction passed all three index-loss shapes:
  actual `EACCES`, strict probe `alive`, retained files and successful relative writes after
  recovery, with both private sidecars intact. No filesystem/process enumeration mocking in
  that reproduction. Regression fixtures narrow enumeration to the test's real process tree;
  actual cwd denial, writes and exit remain unmocked.
- New scratch guards also cover unknown execution/process evidence and legacy missing cleanup
  intent at both local/fallback locations, unreadable evidence discovery followed by automatic
  retry, ordinary orphan reclamation after discovery recovers, and stripped role metadata.
  Real holder exit releases resources through the unchanged 60-second retry. The existing
  native stale-generation guard passes for all five runners.
- Server build, server test typecheck and `git diff --check` passed. Full gate and independent
  incremental review remain with the parent task.


### Fallback retry review follow-up (2026-10-04)

- Baseline `2a59ae42`, the two changed production sources temporarily restored: filter
  `old fallback` in `scratch-cleanup.test.ts` produced **two behavioral failures**. A real
  unreadable owner marker incorrectly changed holder safety to true; a real unwritable
  fallback parent caused cleanup to erase the saved fallback pointer. Source restoration was
  verified byte-for-byte. No helper-import or spy-target failure counted as red.
- Focused seven-file run: **190 passed**, including all 15 native R43 cases and **22** scratch
  cleanup cases. New guards prove restart and ordinary 60-second retries after marker denial
  or partial removal, and that a saved removal receipt cannot delete an ownerless or foreign
  replacement directory. Temporary environment changes are restored explicitly.
- Both standalone reviewer reproductions now retain the old location and a pending retry.
  Extending only their final observation to 61 seconds (production timers unchanged, no fake
  timers) observed fallback removal and zero pending timers after permissions/holders cleared.
  Permission changes, holder cwd and filesystem removals are real; only process enumeration
  is scoped to the actual child. Tests remain Linux/unprivileged-user specific for EACCES.
- Server build, server test typecheck and `git diff --check` passed. Full gate and independent
  incremental review remain with the parent task.

### Receipt-liveness review follow-up (2026-10-04)

- Baseline `74bf1dcf`: the preserved four-case regression and both standalone reviewer scripts
  reproduced live readable fallback holders being falsely settled after receipt/pointer damage.
  With the finalized native tests and three production sources temporarily restored to baseline,
  `npx vitest run packages/cezar/src/workflows/worker-location-evidence.test.ts packages/cezar/src/delegation/process-liveness.test.ts`
  produced **27 behavioral failures / 11 guard passes**: twenty native cases falsely settled live
  holders; seven legacy/unknown-boot shapes returned `gone` for incomplete location evidence.
  All source bytes were restored in `finally` and verified exactly.
- The new native R43 matrix covers all five runners and four real malformed/permission-denied
  receipt/pointer shapes, post-probe holder writes, blocked collect/Finish, and settlement plus
  cleanup once holders exit and evidence recovers. Both reviewer scripts now retain the saved
  path and report `alive`, settlement `false`, phase `starting`, resource safety `false`.
- Focused lifecycle/tempdir/retention run: **212 passed** across eight files; separate scratch
  cleanup run: **22 passed**, including the prior index-loss, fallback-retry and replacement
  safety guards. The harness registration guard passed. The existing fifteen R43 cases remain;
  collect/destroy also test damaged cleanup metadata during known-reboot settlement, then restore
  metadata before the original holder-only deletion/reuse assertions. The final R43-only rerun
  passed all **15** cases after this fixture adjustment.
- Server build, server test typecheck and diff check passed. Linux/unprivileged permission tests
  use actual EACCES, readable holder cwd, writes and exits; enumeration is scoped to fixture
  processes. No production timer changes, liveness stubs or unrelated-process signals. The full
  gate and independent review remain with the parent task; no push or PR edits were performed.
