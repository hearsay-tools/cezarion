# Agent runners and backends

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`AGENT_PROTOCOL.md` (the contract and the new-runner checklist), then `packages/cezar/src/core/agent-runner.ts`, `packages/cezar/src/core/runner-factory.ts` and the changed backend's `packages/cezar/src/core/*-runner.ts`

## Rules

Shared code outside `packages/cezar/src/core/` reads a runner's declared facts (`RUNNER_FACTS`, `inputDelivery`, `systemPromptOnResume`; `AGENT_PROTOCOL.md` §1) to decide what a runner can do, never a runner id. Every backend implements `AgentRunner`/`AgentSession` and must pass both parity matrices: `ui-parity.test.ts` (mappers) and `harness-parity.test.ts` (runners, including each runner's `specSupport`). Runner prose never counts runners. `CEZ_DRY_RUN=1` must keep working. The zero-config default includes unrestricted `Bash`, and each runner's `specSupport.toolGrant` says whether its wire honors the list (open-mercato/cezar#430).

## Runner regressions ship with shared coverage

A lifecycle, input delivery, Needs You, monitoring, ASK or completion fix ships
with a parity row in the same PR, on the native mock wires through
`HARNESS_ADAPTERS`. Prove that the row fails without the fix. Do not defer this
coverage to a separate issue. Where the fix lives decides where its row runs
(hearsay-tools/cezarion#2991):

- **A fix inside a runner class** extends the seam contract suite
  (`core/seam-contract.testkit.ts`) or that runner's own rows. These run on every
  runner. Give a genuine wire gap a named executable exemption.
- **A fix above the seam**, in Cezar's shared code, extends a shared row. A
  shared row runs on the derived runner set: the smallest set that shows every
  declared value of each turn-path fact (`inputDelivery.mode`, `.consumption`,
  `.acknowledgement`, `.humanInputAtTurnEnd` and `systemPromptOnResume`).
  Nobody picks these runners by hand.
- **A new runner** declares its facts in `RUNNER_FACTS`. When it adds a value
  that no member of the set has, the set takes it in.

`core/parity-classes.testkit.ts` holds the one classification table. Each parity
family is `every-runner`, `shared` or `no-session`, from a trace of its cells.
A family whose cells branch on a runner's own code, or read a narrow fact (native
ask, native subagents, the native timer tool, cumulative cost), is
`every-runner`. A shared row also runs on every runner when its family lists it
in `everyRunner`, when any runner is exempt from it, or when its cell title
carries no row id. A `no-session` family runs once, on the first runner of the
set. R1 and U1 stay on every runner as smoke rows. When unsure, choose
`every-runner` and say why in the table.

Three guards hold the rule:

1. `core/parity-classes.test.ts` fails when the derived set misses a declared
   value of a turn-path fact.
2. The `cez/runner-fact-combination` lint rule fails when one function in
   `packages/cezar/src/workflows/` reads two different declared facts. Such a
   function needs a combination row that runs on every runner, named in the
   rule's `COMBINATION_ROWS`.
3. `core/parity-classes.test.ts` fails when a parity test file belongs to no
   classified family, or a family has no file.

A per-runner parity file loads only its own adapter. It picks its runner with
`useRunners(onlyRunner(...))`. The testkits it reaches import a kit's `-core` file, never
`runner-factory.ts` or a kit's plain name (`fixture-cleanup`, `worker-wait`, `harness-parity`,
`workflow-parity`), which chooses every adapter. A wait parity file also loads the Claude
adapter for its workers, and an owned-workflows file the next runner for R14's mixed chain. `core/runner-closure.test.ts` enforces this
(hearsay-tools/cezarion#2939).

Keep each parity test file under about 300 s on an idle host, so that it stays
inside Squeal's per-file cap (`runner.timeoutMs` in `squeal.config.json`) on a
loaded host. When a parity suite grows past that, run its cells from one file per
runner, defined once in a `*-cells.testkit.ts`, and add a guard that every runner
with rows has its file. Split a runner's file again by row group when one runner
alone is too slow. A runner that runs no row of a part has no file for it, so the
file guards compute the expected files from the class table, never from
`RUNNER_IDS` alone. Fold files that were split only for the cap once the derived
set fits in one.
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
