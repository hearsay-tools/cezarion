# Worker wake capacity observation proof

Subject: hearsay-tools/cezarion#1856. Parent plan approval: worker request
`0b7158a8-a10e-4251-9f85-04b9b7706b2f`, reply
`b73e01fc-9484-4a17-9325-a9544d894892` on 2026-10-27.

## Cause and preserved guarantee

`proof_base`: `6c92bf4d85ec0cc73d58bf0dab3f25b5fcd407c1`.
Original evidence: [run 40235842772, attempt 1, job 121297235529](https://github.com/hearsay-tools/cezarion/actions/runs/40235842772/attempts/1#job-121297235529),
head `42d9f108c1beac248f3841cdaf44f8d849d60afe`.

The late/check cell failed with `AssertionError: expected +0 to be 1 // Object.is equality`
at the wake's `expect(semaphore.busy()).toBe(1)`. Its diagnostic state already showed
parent `status: waiting`, the original session open, and `turn.completed turn=turn_2`
followed by `turn-end`. The worker was cancelled with execution complete.

The test waits for worker shutdown before it reads the durable lifecycle delivery.
That delivery remains recorded after the wake turn ends. Claude's ordinary native
follow-up response ends after its 150 ms delay. If the observer runs later, the
parent has already parked for human input and correctly holds no capacity slot.
`RunManager.busySlots` excludes that park. This is an observation race, not evidence
that the parent lost its slot while its wake was running.

The old assertion pins **one slot for the admitted parent while its wake is in
progress**, plus the same open session and no following step before explicit done.
The change retains all old assertions. It uses existing `withHeldResponse` before
parent startup, matches only `Worker wait`, and waits for both the native hold
marker and durable delivery before reading capacity. It checks the same session
and pending next step there. After release it waits for a new turn-end and human
park, then checks the same session and pending next step again. Only explicit done
can advance the workflow. Early and late registration remain separate cells for
both agent and check successors. No product, mock, shared testkit, timeout, or
baseline changes are included.

## Observations

All probes ran on CPU0 with one Vitest worker. The host has 24 logical CPUs;
`nproc` inside the affinity scope prints 1. Each probe was bounded by GNU timeout
at 120 seconds with a five-second kill grace. Traps stopped and reaped its own
busy loops. Another worker used bounded load on CPUs1–23 during the scheduled
probes; none of those loops belonged to this task.

| Probe | CPU0 loops | Observer schedule | Result | Host load average at start |
| --- | --- | --- | --- | --- |
| Unchanged late/check | 2 | Unmodified | 1/1 passed, 36 skipped | 18.03, 18.32, 17.87 |
| Unchanged late/check | 4 | Unmodified | 1/1 passed, 36 skipped | 16.78, 17.83, 17.73 |
| Unchanged late/check | 6 | Unmodified | 1/1 passed, 36 skipped | 17.15, 17.77, 17.71 |
| Unchanged late/check | 8 | Unmodified | 1/1 passed, 36 skipped | 13.02, 16.61, 17.32 |
| Old late/check | 2 | 1000 ms observer yield | 1/1 failed, 36 skipped; busy 0 expected 1 | 51.95, 30.56, 22.33 |
| Fixed late/check | 2 | Same 1000 ms observer yield | 1/1 passed, 36 skipped | 42.55, 31.87, 23.30 |
| Fixed with slot-release mutant | 2 | Same 1000 ms observer yield | 1/1 failed, 36 skipped; same busy assertion | 51.28, 35.62, 24.98 |

The four load-only passes do not reproduce the failure. The scheduled probe does:
its old-test failure state matches the original CI state (open parent session,
completed wake turn, waiting parent, completed worker). The yield is proof-only,
independent of wake completion, and identical in both versions. It does not enter
the committed test. One initial scratch setup failed to resolve a workspace
package before registering tests; it is excluded from all proof counts.

The negative mutant inserts the following **only in scratch**, after the native
hold and delivery wait and before the unchanged slot assertion:

```typescript
(manager as unknown as { waiting: Set<string> }).waiting.add(run.id);
```

This wrongly exempts the admitted parent from `busySlots` during its held wake.
The test fails at `expect(semaphore.busy()).toBe(1)`, not at setup or a timeout.
No production source is changed to implement the mutant.

## Reproduce

Use the ignored scratch recipe in `docs/sdlc/regression-proof.md`. Extract the
owned test from `proof_base` for the old run and this change for the fixed run.
Rewrite relative imports to their original absolute locations. Rewrite the two
scratch imports of `@open-mercato/cezar-contract/{delegation,runs}` to the matching
absolute `packages/contract/src/*.ts` paths because the scratch directory is
outside that package's pnpm dependency scope. Retain the server configuration,
setup file, assertions and original test name. Include only the scratch test in
an explicit config under `.ai/qa/issue-1856-proof/`.

For the scheduled probes, insert this after the first worker termination assertion
and before the lifecycle-delivery wait in both scratch versions:

```typescript
// Proof only: postpone the observer, without waiting on wake completion.
await new Promise(resolve => setTimeout(resolve, 1000));
```

Use the one-CPU recipe in `docs/sdlc/ci.md` with `cpu=0`, `LOOPS=2` and this command:

```bash
npm test -- --config .ai/qa/issue-1856-proof/vitest.config.ts \
  -t "following 'check' behind 'late'" --maxWorkers=1
```

The enclosing command is `LOOPS=2 timeout --kill-after=5s 120s taskset -c 0 bash
.ai/qa/issue-1856-proof/load.sh`, where `load.sh` contains the documented loop
cleanup traps and the focused npm command above. For the load-only probes omit
the inserted observer yield and use each recorded loop count. For the negative
probe add only the mutant above to the fixed scheduled scratch test.

Save the runner output before deleting the scratch test and config. The original
CI log excerpt and all seven completed probe logs are also published as this
task's evidence artifact. Squeal validates the real owned test separately; these
focused probes do not claim a full-file or full-suite pass.
