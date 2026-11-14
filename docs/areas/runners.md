# Agent runners and backends

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`AGENT_PROTOCOL.md` (the contract and the new-runner checklist), then `packages/cezar/src/core/agent-runner.ts`, `packages/cezar/src/core/runner-factory.ts` and the changed backend's `packages/cezar/src/core/*-runner.ts`

## Rules

Shared code outside `packages/cezar/src/core/` reads a runner's declared facts (`RUNNER_FACTS`, `inputDelivery`, `systemPromptOnResume`; `AGENT_PROTOCOL.md` §1) to decide what a runner can do, never a runner id. Every backend implements `AgentRunner`/`AgentSession` and must pass both parity matrices: `ui-parity.test.ts` (mappers) and `harness-parity.test.ts` (runners, including each runner's `specSupport`). Runner prose never counts runners. `HSQ_DRY_RUN=1` (`CEZ_DRY_RUN` fallback) must keep working. The zero-config default includes unrestricted `Bash`, and each runner's `specSupport.toolGrant` says whether its wire honors the list (open-mercato/cezar#430).

## Runner regressions ship with shared coverage

A lifecycle, input delivery, Needs You, monitoring, ASK or completion fix ships
with a parity row in the same PR, on the native mock wires through
`HARNESS_ADAPTERS`. Prove that the row fails without the fix. Do not defer this
coverage to a separate issue. Where the fix lives decides where its row runs
(hearsay-tools/cezarion#2991):

- **A fix inside a runner class** extends the seam contract suite
  (`core/seam-contract.testkit.ts`) or that runner's own rows. These run on every
  runner. Give a genuine wire gap a named executable exemption.
- **A fix above the seam**, in Squawk's shared code, extends a shared row. A
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
carries no row id and its kit passes no row key to `parityRunners`. A kit that
passes a key (for example a mode name) runs that cell as a shared row. A `no-session` family runs once, on the first runner of the
set. R1 and U1 stay on every runner as smoke rows. When unsure, choose
`every-runner` and say why in the table.

Three guards hold the rule:

1. `core/parity-classes.test.ts` fails when the derived set misses a declared
   value of a turn-path fact.
2. The `cez/runner-fact-combination` lint rule fails closed. It tracks no value:
   it flags a function in `packages/cezar/src/workflows/`, nested callbacks
   included, that touches any fact source (`.inputDelivery`, `.facts`,
   `.systemPromptOnResume`, `RUNNER_FACTS`, `inputDeliveryOf`, or the
   `InputDelivery` or `RunnerFacts` type) and reads two or more different fact
   keys from any object. Renamed imports and a source touched at module level
   count; its Limits list in `docs/sdlc/lint.md` names what it cannot see. The
   keys come from the declared types. A real
   combination needs a parity row that runs on every runner. Each reported
   function goes in the rule's `COMBINATION_ROWS` with a reason; a real
   combination also names its row as `<family> <row>`, and a false positive
   (an unrelated object with a same-named key) names none.
   `core/parity-classes.test.ts` fails an entry with no reason, or with a row
   that is not registered in that family or does not run on every runner.
3. `core/parity-classes.test.ts` fails when a parity test file belongs to no
   classified family, or a family has no file. It also fails when a registered
   row whose scenario runs runner code (`provider-error`, a native ask scenario,
   native subagents) does not run on every runner. A scenario is `shared` only when
   a seam contract row holds the runner's part of it on every runner, as S44 does
   for `provider-error-controlled`.

A per-runner parity file loads only its own adapter. It picks its runner with
`useRunners(onlyRunner(...))`. The testkits it reaches import a kit's `-core` file, never
`runner-factory.ts` or a kit's plain name (`fixture-cleanup`, `worker-wait`, `harness-parity`,
`workflow-parity`), which chooses every adapter. A wait parity file also loads the Claude
adapter for its workers, and an owned-workflows file the next runner for R14's mixed chain. `core/runner-closure.test.ts` enforces this
(hearsay-tools/cezarion#2939).

The binding limit on a parity test file is CI's per-file cap: `FILE_DURATION_LIMIT_MS`
(60 s) in `.github/scripts/vitest-file-duration.mjs`. CI enforces it on every Vitest
file when `VITEST_FILE_DURATION_CAP=1` (`.github/workflows/ci.yml`), with coverage on,
which runs about 1.8 times slower than an idle local host. Keep each file at most
about 25 s on an idle host. Measure a file the way CI does with
`VITEST_FILE_DURATION_CAP=1 npx vitest run --project server --coverage <files>`.
Squeal's per-file timeout (`runner.timeoutMs` in `squeal.config.json`) is a looser,
secondary bound. When a parity suite grows past the cap, run its cells from one file per
runner, defined once in a `*-cells.testkit.ts`, and add a guard that every runner
with rows has its file. Split a runner's file again by row group when one runner
alone is too slow. A runner that runs no row of a part has no file for it, so the
file guards compute the expected files from the class table, never from
`RUNNER_IDS` alone. Fold files that were split only for the cap once the derived
set fits in fewer files, and measure each folded file against the CI cap first:
`WAIT_FOLDS` in `workflows/waits-parity-catalog.testkit.ts` groups the parts of a runner
outside the shared set into files of about 3–12 s locally.
`core/harness-parity-cells.testkit.ts` and
`workflows/waits-parity-cells.testkit.ts` are the examples
(hearsay-tools/cezarion#1288). Squeal re-runs a test file when any file it imports changes, so
keep each part's cells in its own module and let a per-runner file import only its part's or
fold's module. The wait parity cells do this: `workflows/waits-parity-<part>-cells.testkit.ts`,
`workflows/waits-parity-<fold>-fold.testkit.ts`, one shared fixture and a catalog, and the full
registry for the guard file only (hearsay-tools/cezarion#3242). Vitest 4 fails a suite that registers no test,
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
The evidence endpoint uses the real Squawk tool definitions with stable
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

Dry-run backend version banners use the release identity's environment prefix:
`mock (HSQ_DRY_RUN=1)`.
This display change does not change the accepted environment aliases.
