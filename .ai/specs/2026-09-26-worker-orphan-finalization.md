# Finalizing a crashed worker's execution proof (#469)

Status: approved design (2026-09-26). Extends
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
  (`agentTmpDirLocations`), because finalization deletes that scratch. Linux reads `/proc/*/cwd`, skipping `ENOENT`/`EACCES`
  per entry. macOS uses `lsof -a -d cwd -Fpn` with a bounded timeout. It excludes
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
3. removes the run's agent tmp dir, as `persistWorkerCompletion` does.

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
  arms one unref'd timer (every 15 s) for each orphan it could not finalize (`alive`,
  `unknown`, or a failed commit). It skips a tick
  while the run is queued or active, and it stops on finalization, a changed generation, a
  deleted run, an unknown record, dispose, or after 15 minutes. Finalization emits `run`,
  which reconciles the parent's worker waits, so a parked parent wakes.

### 4. Reaping on destroy

`awaitRunTermination(runId, timeoutMs, { reapOrphans: true })` is passed only by
`destroySerialized`. It applies when the finalizer's preconditions hold, the probe says
`alive`, and the controller is dead:

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

## Not changing

- Shutdown still leaves sessions running (`dispose()` contract); reaping at SIGTERM is out
  of scope.
- `commitWorkerExecutionStart`'s refusal to replace an incomplete generation is unchanged.
  The finalizer completes the old generation first, through the existing
  `commitWorkerExecutionComplete`.
- No new env var, no config, no HTTP or contract change. An unsupported platform keeps
  today's behaviour.

## Known limitations

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
