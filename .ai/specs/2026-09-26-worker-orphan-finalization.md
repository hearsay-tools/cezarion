# Finalizing a crashed worker's execution proof (#469)

Status: approved design (2026-09-26), revised with human approval for #738 (2026-10-04). Extends
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
  `worker execution checkpoint unavailable` (comment on #469, reproduced on v0.14.9);
- `collect` stays `settled: false`.

The conservative rule is right while a process of that generation lives: in the #469
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
  (`agentTmpDirLocations`). Independent cleanup can delete terminal-task scratch; execution
  settlement cannot. Live tasks retain
  scratch across finalized process generations and restart (#515). Linux reads `/proc/*/cwd`,
  skipping `ENOENT` (the process vanished) and `EACCES` on another user's process. An
  unreadable process of our own user is non-dumpable (`systemd --user`, `sshd`,
  `gpg-agent`). It counts as a possible holder, reported by PID and never signalled, unless it
  started before the worker's record was created (`since`, from `/proc/stat` btime plus
  starttime ticks). A process that old cannot be the worker's descendant, and every host has
  some. The cutoff is the worker's creation, not the current generation's start, because an
  earlier generation can leave a daemon holding the worktree.

  **Execution and resource proofs are separate (#738, approved revision).** A valid Linux
  controller boot UUID different from the current readable boot UUID proves old descendants
  cannot survive, but only after checking that neither the controller nor any recorded process
  is live. `inspectExecutionGeneration` uses this fast proof without scanning paths. Unknown,
  malformed and legacy boot identities retain conservative descendant handling. This proves
  execution settlement only; a same-user non-dumpable process can hold persistent paths after
  reboot and is indistinguishable from an ambient daemon whose cwd cannot be read.

  `inspectGeneration` is the independent **resource** proof. It always scans every protected
  worktree/scratch path with no age or boot exclusion. EACCES/EPERM (and unknown ownership)
  remain unresolved candidates; readable holders and live recorded processes remain blockers.
  Only a fresh clear scan plus generation/resource ownership permits deletion or reuse.
  A process becoming readable and outside the protected paths, or exiting, may clear the
  uncertainty; elapsed time or reboot cannot. Unknown evidence is retained, never silently dropped.

  macOS uses
  `lsof -a -d cwd -Fpn` with a bounded timeout. `lsof` silently omits processes it cannot
  read, so any process of our user (`ps -U <uid> -o pid=,lstart=`, minus `ps` itself) missing
  from its output is judged by the same rule. Without that `ps` list the scan is `unknown`.
  It excludes
  `process.pid`, compares realpaths, and matches a dir itself or anything beneath it. cezar's own
  `git` children in the worktree make the scan read `alive` for a moment; that is
  conservative, and it clears on the next probe. If
  `/proc` is unreadable, `lsof` is missing, or the platform is anything else, it
  returns `unknown`.
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
  site covers Continue, `--resume`, parent replies (#505) and queued revival. Over a live
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
can reconstruct this optional field for older checkpoints; no new configuration or separate journal
is needed. Starting a new generation drops the prior intent. `WorkerScratchCleanup` discovers
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

The original #738 acceptance criterion that cleanup always succeeds after reboot is explicitly
narrowed: **execution settlement, collection and parent Finish unblock once execution is proven
terminated; eventual cleanup requires independent fresh proof that no holder or unresolved
candidate remains. If that proof never becomes available, files remain indefinitely.**

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
  boot ID, cannot use the #738 reboot proof. Unreadable same-user cwd candidates may
  still block those generations; uncertainty never authorizes cleanup.
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
  - #738: denied cwd candidates remain possible resource holders even across boots; readable
    holders and matching live process records also block. Same-boot controllers for
    old-created workers, legacy/missing tokens, unknown boot IDs and scan errors retain
    conservative behavior.
- `worker-reboot-parity.test.ts` (registered harness row R36): every `RUNNER_IDS` backend
  launches and exits through its `HARNESS_ADAPTERS` native mock wire. Both collect-first and
  destroy-first restore prior-boot interrupted evidence beside a successful collected twin.
  A real Linux Python process uses `PR_SET_DUMPABLE=0` while holding worktree or scratch;
  kernel cwd reads are genuinely denied and the process still writes after collection/Finish.
  Those settlement paths never call the strict resource probe. Restart keeps both resources;
  automatic production-cadence retries release them after the actual holder exits. Completed
  cleanup cannot bypass the fresh history-deletion probe. Native continuation tests refuse
  reuse while uncertain, then admit a new generation on real exit and prove stale retry cannot
  remove that generation's scratch. Only reboot evidence and enumeration scope are synthetic;
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
- `worker-questions.test.ts`: the #505 "parent reply answers the worker after a restart"
  case also passes with the worker's pre-cancel `starting` proof restored and a dead
  controller.

## Implementation order

1. `process-liveness.ts` + tests.
2. Store: the process-record read/write, the write inside `commitWorkerExecutionStart`,
   and `appendWorkerProcess`.
3. Manager: record at both session sites, `settleOrphanedWorkerExecution`, and the callers.
4. Destroy reaping + service `collect` hook.
5. Regression tests, each shown red without the fix (`git stash push -- <sources>`).

## Verification of the approved #738 revision (2026-10-04)

- Baseline `d2c66da2`, production sources temporarily restored, native R36 filter
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
- R36 scopes only `/proc` enumeration to its explicit real holder PIDs and, for continuation,
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
  native R36, worker destroy, delegation service and retention. The finalized scratch fixture
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
