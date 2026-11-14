# Shared parity rows run on one runner

A parity row that tests Squawk's shared logic above the runner seam runs on one runner,
`SCENARIO_RUNNER` (claude, the default runner), in `core/parity-classes.testkit.ts`. Rows that
test a runner's own code still run on every runner: the seam tier and the seam contract
(S36–S44), the families classed `every-runner`, each row a family lists in `everyRunner`, and
each row with an exemption. Shared code sees a runner through five turn-path facts
(`inputDelivery.mode`, `.consumption`, `.acknowledgement`, `.humanInputAtTurnEnd` and
`systemPromptOnResume`). The scenario runner shows one value of each. Every other declared value
names the unit tests that drive shared code with it, in `FACT_VALUE_TESTS`.

Before this record, a shared row ran on a derived set of three runners (claude, cursor, omp): the
smallest set that showed every declared value of each turn-path fact (hearsay-tools/cezarion#2991).
Parity files were about 40% of Vitest file time in CI (3,495 s of 8,811 s in merge-queue run
43512639120).

## Evidence

CI shard logs from 2026-09-02 to 2026-11-14: 1,345 failed CI runs, 726 failed Vitest shard jobs,
91 runs with a failed parity cell. Seven shared regressions (about 30 runs) each failed on every
runner that ran the row. About 22 runs failed on one runner. One of them was a real adapter bug:
the claude T3 row, new at the time, found that a signal exit left `exitCode` null in
`claude-cli-runner.ts`, and the fix added adapter unit tests too. Two were faults in a runner's
mock or test kit. The rest were flakes: timeouts, hook timeouts and partial reads, many on `main`
pushes and in the merge queue, which recur on unrelated branches. More runners per row gave more
flakes, not more catches.

A full `server` project run with V8 coverage, before and after this change, covers 52,871 and
52,868 of 56,431 statements. The three lost statements are process-record warnings and a `/proc`
race path, not a fact branch. Shared code reads two turn-path facts directly: `consumption`
(`workflows/input-acknowledgement.ts`, `workflows/run/input-receipts.ts`) and
`systemPromptOnResume` (`workflows/run/launch-read-resolver.ts`). It sees `mode`,
`acknowledgement` and `humanInputAtTurnEnd` only through the session: when it acknowledges a
write, and whether it holds a human message at turn end (`holdsHumanInput`).
`workflows/turn-path-fact-values.test.ts` drives those paths with each value, and fails when a
read site ignores its value.

## Consequences

- A fix above the seam extends a shared row, which runs on the scenario runner. A fix whose
  behavior depends on a turn-path fact value adds or extends that value's unit test.
- A new runner that declares a new value adds its unit tests to `FACT_VALUE_TESTS`.
  `core/parity-classes.test.ts` fails a declared value with no test, a stale or scenario-runner
  value, and a named file that is missing, is a parity file or does not spell its value.
- `cez/runner-fact-combination` still fails a function that combines two facts, which one test
  per value cannot show; a real combination still names a row that runs on every runner.
- The wait parity files of every runner but the scenario runner are fold files (`WAIT_FOLDS`).
  The cap splits that cursor needed as a shared-set runner (`WAIT_PARITY_FAMILIES`) are gone.
- Each runner's adapter keeps its own tests: the seam tier, the seam contract and its unit tests.
  The T3 case shows the gap this leaves. A scenario row no longer finds a latent bug in another
  runner's adapter. A seam row or an adapter unit test must find it instead.

Implementation: [parity-classes.testkit.ts](../../packages/cezar/src/core/parity-classes.testkit.ts),
[waits-parity-catalog.testkit.ts](../../packages/cezar/src/workflows/waits-parity-catalog.testkit.ts),
[docs/areas/runners.md](../areas/runners.md).

Coverage: [parity-classes.test.ts](../../packages/cezar/src/core/parity-classes.test.ts),
[turn-path-fact-values.test.ts](../../packages/cezar/src/workflows/turn-path-fact-values.test.ts),
[launch-system-prompt.test.ts](../../packages/cezar/src/workflows/launch-system-prompt.test.ts),
[waits-parity.test.ts](../../packages/cezar/src/workflows/waits-parity.test.ts).
