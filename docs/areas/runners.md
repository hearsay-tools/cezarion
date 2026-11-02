# Agent runners and backends

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`AGENT_PROTOCOL.md` (the contract and the new-runner checklist), then `packages/cezar/src/core/agent-runner.ts`, `packages/cezar/src/core/runner-factory.ts` and the changed backend's `packages/cezar/src/core/*-runner.ts`

## Rules

Every backend implements `AgentRunner`/`AgentSession` and must pass both parity matrices: `ui-parity.test.ts` (mappers) and `harness-parity.test.ts` (runners, including each runner's `specSupport`). Runner prose never counts runners. `CEZ_DRY_RUN=1` must keep working. The zero-config default includes unrestricted `Bash`, and each runner's `specSupport.toolGrant` says whether its wire honors the list (open-mercato/cezar#430).

## Runner regressions ship with shared coverage

When fixing runner lifecycle, input delivery, Needs You, monitoring, ASK or
completion behavior, add or extend an exhaustive `RUNNER_IDS` regression in the
same PR. Use each runner's own native mock wire through `HARNESS_ADAPTERS`;
a backend-only test or injected normalized event does not cover the other
runners. Register new cells in the parity guard and give genuine wire gaps
named executable exemptions. Prove the relevant regression fails without the
fix. See `AGENT_PROTOCOL.md` §7 for the contract and examples. Do not defer this
coverage to a separate issue.

Keep each parity test file under about 300 s on an idle host, so that it stays
inside Squeal's per-file cap (`runner.timeoutMs` in `squeal.config.json`) on a
loaded host. When a parity suite grows past that, run its `RUNNER_IDS` cells
from one file per runner, defined once in a `*-cells.testkit.ts`, and add a
guard that every runner has its file. Split a runner's file again by row group
when one runner alone is too slow.
`core/harness-parity-cells.testkit.ts` and
`workflows/waits-parity-cells.testkit.ts` are the examples
(hearsay-tools/cezarion#1288). Vitest 4 fails a suite that registers no test,
so the file that runs the guard and the single-runner cells must not register
a `describe` whose body holds only runner cells; `describeRunners` in
`core/harness-parity-cells.testkit.ts` is the example
(hearsay-tools/cezarion#1375).
