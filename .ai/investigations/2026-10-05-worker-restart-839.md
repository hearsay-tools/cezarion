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
until it exits. No public API, dependency or user configuration was added. The
private optional abandonment field leaves old checkpoints valid; an older version
that cannot read it fails closed.

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
