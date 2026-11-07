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

A per-runner parity file loads only its own adapter: it picks its runner with
`useRunners(onlyRunner(...))`, and a testkit it imports never imports
`runner-factory.ts`, `fixture-cleanup.testkit.ts` or `worker-wait.testkit.ts`. A wait
parity file also loads the Claude adapter for its workers.
`core/runner-closure.test.ts` enforces it (hearsay-tools/cezarion#2939).

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

## Native mock wire evidence

Build the service once (`npm run build -w @wjarka/cezarion`), then run:

```sh
npm run mock:wire -- .ai/qa/wire-a
npm run mock:wire -- .ai/qa/wire-b
diff -ru .ai/qa/wire-a .ai/qa/wire-b
```

The collector drives the real runners through `HARNESS_ADAPTERS`. Its explicit
recipes live in `.ai/scripts/mock-wire-evidence.ts`; they use direct native mock
tokens, not the parity catalog's aliases. Optional trailing arguments select a
runner and a scenario, for example `npm run mock:wire -- .ai/qa/wire claude untokened`.
Its separate Vitest config keeps it out of the default unit suite.

Each runner/scenario pair produces normalized NDJSON. `summary.json` lists the
transcript count per runner and every unsupported recipe with its reason. The
collector overwrites the selected transcripts; use a fresh directory for each
comparison. Transcripts are PR evidence, not committed fixtures. This recorder
slice compares two runs on its head. Later encoder slices record on their base
and head and explain every difference.

`CEZ_MOCK_WIRE_FILE` enables recording in the native mocks. With it unset, no
recorder import runs. Records name stdout, stderr, SSE or the HTTP response
(status and body). Normalization replaces process-local identities, timestamps,
temporary paths, pids and allocated ports. It keeps frame and write order.
The evidence endpoint uses the real cezar tool definitions with stable
unavailable receipts; it creates no waits and makes no GitHub requests. Parity
tests continue to verify tool effects through the real workflow controller.

A recipe ends on its last expected record. Child-after-park recipes release the
park gate after the parent's turn end and consume the late child output.
OpenCode delayed-ack recipes consume the HTTP acknowledgement after the SSE
turn events. Stalled recipes stop after the native acknowledgement, or after the pid file
and every frame the mock sends before it stalls. Gated recipes release
`input-ack.release` after the pid file, then consume the acknowledgement and
opening frames.
Terminating crash recipes record the leader's exit code or signal; clean crash
diagnostics end on the native turn end. Held-pipe children keep their inherited
stdio; only the mock's own writes and its leader exit enter that transcript.
