# Same-boot interrupted worker settlement — hearsay-tools/cezarion#839

Evidence collected read-only on 2026-10-05 from the archived task for
hearsay-tools/cezarion#830. Archived state, processes and shared Git claims were
not modified. hearsay-tools/cezarion#837 is outside this change.

Sources are flat files under `/home/agent/projects/cezar/.ai/cezar/runs/`:
worker `02454220-6ab1-49e4-8208-a09c8edd1041`, former parent
`8dc5707d-f7ca-4d81-933d-b6535923c71b`; selected sanitized snapshots and inspection
report are in `/tmp/cezar-839-evidence/`. Times below are UTC.

- The worker's execution checkpoint remains `starting`, generation
  `e59b1100-4de5-4cda-bb6e-aca341073818`. Its process ledger records controller
  PID 2103504 and runner PID 1249775 with boot/start tokens; both were absent at
  investigation.
- Worker event **seq 62, 11:49:42.616** refuses restart as if PID 1269002 were
  a surviving execution process. Inspection identifies it as systemd, parent 1,
  started **11:49:31**. An unreadable same-user cwd does not establish worker
  membership. It remains a possible resource holder.
- **Seq 63, 12:14:41.800**, through **seq 77, 12:53:59.327**, report candidate
  processes as confirmed holders. Destruction remains `terminating`, with
  process/worktree/branch remaining.
- Parent **seq 1843, 12:33:40.016**, blocks completion on that worker. The saved
  wait input at **12:43:49.570** reaches its deadline without an outcome. Saved
  collect at **12:51:27.936** remains `partial=true`, `settled=false`, cleanup
  incomplete. These wait/collect observations come from the inspection report;
  selected event snapshots contain seq 62–77 and parent seq 932/1843.
- Separately, parent handoff entries at **11:35:41** and **11:55:33** record
  mutation-lock acquisition failures. At 11:55:33, live keeper children of
  replacement controller PID 1269014 were queued. No evidence proves their
  claims stale. They must not be stolen.

## Cause and bounded recovery

The execution scanner merged verified cwd matches with unreadable cwd candidates.
The restart path then treated both as live execution evidence, preventing result
settlement and parent Finish. Destroy retried candidates for up to 30 seconds,
although it cannot signal them. Owned-resource cleanup also inherited the normal
120-second mutation-lock wait, exceeding command transport deadlines.

Same-boot Linux recovery now distinguishes execution abandonment from exit proof.
It requires a valid same-boot token ledger, an exited controller and all recorded
incarnations exited, complete location discovery, and a successful scan with only
known-user permission-denied candidates of known eligible age. It cancels task
intent and writes a private `abandoned=true`, `phase=complete` checkpoint. It
reports abandonment rather than claiming those unknown processes exited. Parent
collection retains partial evidence and requires the latest settled collection
before Finish. Restart preserves cancellation and the original generation. An abandoned checkpoint refuses new execution admission even after holders clear; follow-up work needs a new worker. Contradictory abandonment/no-materialization evidence fails closed.

Abandonment never grants deletion or reuse. Worktree, branch and scratch continue
to require the existing fresh strict resource proof. Live recorded processes,
foreign controllers and readable cwd holders still block settlement. Missing,
malformed or unreadable ledgers, unknown boot/token/ownership/time, unexpected
scan errors and incomplete locations do not qualify for abandonment. Legacy
unverified candidates refuse destroy promptly with an honest retained reason;
verified readable holders retain their existing bounded wait and reprobe behavior.

Owned cleanup gives the existing mutation keeper a 1-second acquisition budget.
Its timeout withdraws only its own queued claim before returning; no queued
operation can run later. Creation and other normal mutations keep their 120-second
budget. An admitted Git command retains the existing keeper/process-group exclusion
until it exits. The 1-second bound applies to lock acquisition, not the entire
cleanup request: existing read-only HEAD/diff evidence commands before the lock
can each take up to 30 seconds when Git is degraded. This existing timing limit
does not leave a queued mutation running after refusal. No public API, dependency
or user configuration was added. The private optional abandonment field leaves
old checkpoints valid; an older version that cannot read it fails closed.

## Verification

All test/build commands run in child environments with inherited `CEZ_*` removed
and `TMPDIR=/tmp`; this worker's own controller environment remains intact. `npm ci`
was run in this worktree before tests.

Initial red against unmodified production source:

```sh
npx vitest run packages/cezar/src/workflows/worker-restart-parity.test.ts packages/cezar/src/delegation/process-liveness.test.ts packages/cezar/src/git-worktree-lock.test.ts -t 'R47|same-boot|withdraws timed-out' --maxWorkers=1
```

Seven expected failures: all five native runner cells remained unsettled, the
same-boot process test returned `alive` with the unrelated daemon PID, and the
lock test ran its queued callback instead of rejecting. The final R47 cell also
checks real recorded unreadable survivors, stale-PID incarnation exclusion,
stale partial collection, parent Done, restart, reuse/history refusal, retained
locked resources and successful explicit cleanup only after blockers clear.

A separate red test for candidate-only refusal used:

```sh
npx vitest run packages/cezar/src/workflows/worker-destroy.test.ts -t 'refuses unreadable unverified' --maxWorkers=1
```

Before that fix it waited out the 1.5-second test deadline and claimed the
unrelated PID held the worktree; afterward it returned promptly with an
unreadable/unverified reason. The unchanged readable scan-only survivor tests
continue to exercise waiting and eventual settlement.

Two additional red checks extended R47's safety boundary: its native Claude cell
initially admitted a new generation once the ambient process exited; the final
admission guard rejects abandoned task intent. The contradictory-abandonment
worker-destroy test initially granted a no-materialization cleanup capability;
its final private-checkpoint validation rejects that contradictory evidence.

Final green:

```sh
npx vitest run packages/cezar/src/workflows/worker-restart-parity.test.ts packages/cezar/src/workflows/worker-reboot-parity.test.ts packages/cezar/src/workflows/worker-location-evidence.test.ts packages/cezar/src/workflows/worker-destroy.test.ts packages/cezar/src/delegation/process-liveness.test.ts packages/cezar/src/git-worktree-lock.test.ts packages/cezar/src/delegation/destruction-results.test.ts packages/cezar/src/delegation/scratch-cleanup.test.ts packages/cezar/src/delegation/workspace.test.ts --maxWorkers=2
npx vitest run packages/cezar/src/core/harness-parity.test.ts -t 'harness parity — the matrix itself' --maxWorkers=1
npm run build:server
npm run typecheck:server
```

The focused run passed **243 tests in nine suites**; the matrix guard passed
**seven tests** (other matrix scenarios filtered). Server build and typecheck
passed. Initial typecheck identified one test typing error and missing prebuild
`dist/application-update` declarations; the typing was fixed and server build
provided the declarations before the passing typecheck. No failures remain in
these checks. The parent owns all six final repository gates and Astra review.

Limits: same-boot abandonment is Linux-only and needs complete, trustworthy
ledger/location/scan evidence. Unverified resource holders can retain files
indefinitely. Abandoned task intent requires a new worker for further execution.
Native tests use offline backend wires and synthetic crash PID/enumeration scope,
with real process tokens, kernel permission denial, filesystem, Git keeper and
cleanup. This is not a live-provider or archived-host recovery experiment.

## Review follow-up

Astra identified that the original negative ledger cases omitted
`pathsComplete: true`, bypassing the same-boot abandonment gate. The follow-up
adds 16 otherwise-qualifying negative cases. Every case first qualifies with a
valid controller/process ledger, complete locations and a real non-dumpable
same-user process, then changes one input: absent ledger; missing, legacy or
malformed controller/process tokens; foreign process boot; unknown/malformed
current boot; unknown ownership/start time; unexpected cwd error; unreadable
process enumeration. Resource proof remains conservative and the candidate
remains writable.

Mutation verification used this focused filter, restoring production source after
each mutation:

```sh
npx vitest run packages/cezar/src/delegation/process-liveness.test.ts -t 'rejects otherwise-qualifying abandonment' --maxWorkers=1
```

- Validating only the controller and omitting recorded-process token validation
  caused **five expected failures**.
- Replacing the valid same-boot ledger predicate with `true` caused **12 expected
  failures**, including absent/invalid controller and boot evidence.
- Removing scan certainty (`!scan.uncertain`) caused **three expected failures**
  for unknown ownership/start time and unexpected cwd errors.

Final green with all production guards restored:

```sh
npx vitest run packages/cezar/src/delegation/process-liveness.test.ts --maxWorkers=1
npm run typecheck:server
```

The complete focused process-liveness suite passes **35 tests**, and server
typecheck passes. This follow-up changes tests and this note only; the parent
owns full repository verification and triage of its loaded-host test failures.

## Mixed-holder polling follow-up — hearsay-tools/cezarion#842

The [confirmed automated-review finding](https://github.com/hearsay-tools/cezarion/pull/842#discussion_r4185182113)
identified a stale candidate-only check in `reapOrphanedWorker`: a verified
readable holder could exit during polling while an unreadable candidate remained,
but absent/incomplete ledgers prevented abandonment and cleanup waited until the
termination deadline. The predicate now reads the latest probe for the same
execution generation after each fresh settlement attempt. Recorded-process
TERM/KILL policy, unknown-evidence safety and strict resource proof are unchanged.

R47 extends every `RUNNER_IDS` native `HARNESS_ADAPTERS` wire with both absent
and incomplete ledgers. After native cancellation, it restores the interrupted
checkpoint, observes a real readable worktree holder across a poll, and lets that
holder exit normally while a real non-dumpable scratch candidate remains. The
result must name only the unreadable candidate, retain the starting generation
without abandonment, preserve worktree/branch/scratch, and leave the candidate
writable. Enumeration and the crash checkpoint are synthetic; readlink/token
reads, permission denial, process exit, stores and Git are real.

Red proof was run before changing production source:

```sh
npx vitest run packages/cezar/src/workflows/worker-restart-parity.test.ts -t 'mixed-holder cleanup' --maxWorkers=1
```

All ten cells failed only on elapsed time: **4004–4008 ms** against the
**<2500 ms** assertion with a 4000 ms termination budget. The verified-holder
exit, honest candidate reason and retained-resource assertions passed against
the bug. With the minimal loop fix, the same command passes all ten cells.
Test subprocesses remove inherited `CEZ_*` and use `TMPDIR=/tmp`; the worker CLI
retains its controller environment. `npm ci` ran before tests.

Final green: the nine-suite focused command listed in Verification above passes
**269 tests in nine suites**, including all 15 R47 cells. The registered native
matrix guard passes **seven tests**; `npm run build:server` and
`npm run typecheck:server` both pass. `git diff --check` is clean. The parent
owns the full repository gates, review and PR updates. This follow-up changes
only the polling predicate, R47 coverage and its registration/documentation.
