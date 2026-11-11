# AGENT_PROTOCOL.md — the cezar agent protocol

cezar runs every coding-agent CLI behind one seam, `AgentRunner`, and renders every backend
through one event vocabulary. This file holds the rules for that seam that code, types, tests
and lint rules do not state. When this file and the code disagree, the code wins.

Every runner emits two event streams together: v1 `AgentEvent` (§2) and v2 `UiEvent` (§3).

---

## 1. The runner seam (`packages/cezar/src/core/agent-runner.ts`)

The types in `agent-runner.ts` and their doc comments are the contract: `AgentRunner`,
`AgentSession`, `SessionOptions`, `AgentRunSpec`, `InputDelivery` and `SystemPromptOnResume`.
`RUNNER_FACTS` in `core/runner-facts.ts` holds what each runner's wire can do, one row per
runner id. Each runner's `*_SPEC_SUPPORT` constant, next to its class, says which
`AgentRunSpec` fields its wire honors.

- `.ai/scripts/probe-steering.ts` probes the `inputDelivery` of a real CLI. It spends a paid
  session, so run it by hand.
- The delegation CLI (`cez worker`, `cez message`) is agent-facing and has no compatibility
  window: change or remove a verb without an alias. This does not apply to human commands
  such as `cez task send`.

---

## 2. v1 `AgentEvent` — the flat stream

`AgentEvent` in `packages/cezar/src/core/agent-runner.ts` is the v1 stream. Every runner
emits it beside v2: `cezar run` renders it and saved runs hold it. New consumers read runner
output from v2. A Cezar-owned run event, such as `provider-auth-required`, has no v2 form
and arrives as `run-event` (§9). The v1 `type` strings are additive-only (§ Compatibility).

---

## 3. v2 `UiEvent` — the normalized protocol (`packages/cezar/src/core/ui-events.ts`)

`ui-events.ts` holds the vocabulary and imports no runtime code.
`packages/api-client/src/protocol/ui-events.ts` is a hand-kept copy for the browser;
`packages/cezar/src/server/api-types.test.ts` holds the two equal on the wire.

Where a name is an arbitrary choice (tool status, tool kind, plan entry, diff shape, stop
reason), use the ACP name.

---

## 4. Per-backend mapping (summary)

Each backend's mapper is `packages/cezar/src/core/<backend>-ui-mapper.ts`
(`cursor-print-ui-mapper.ts` for Cursor). Its golden fixtures (§8) are the wire-to-event
table.

<a id="cursor-acp-264"></a>

### Cursor print

`packages/cezar/src/core/__fixtures__/cursor/README.md` holds the limits that a user meets
on Cursor, with their evidence.

<a id="codex-managed-permissions-708"></a>

### Codex managed permissions

`packages/cezar/src/core/codex-permissions.test.ts` holds the rules: when Cezar selects its
own sandbox, and when Codex's managed permissions stay.

### Codex approval routing

`packages/cezar/src/core/codex-approvals.test.ts`, `codex-permission-recovery.test.ts` and
`packages/cezar/src/workflows/permissions.test.ts` hold who can answer a native approval and
what recovery does with one.

#### MCP tool approvals

`packages/cezar/src/core/ci-tools.testkit.ts` holds how Codex treats Cezar's own MCP server.
`.ai/scripts/probe-approvals.ts` checks that routing against the installed Codex in one paid
turn. CI never runs it.

---

## 5. The tool display model (`packages/contract/src/tool-display.ts`)

`toolDisplay(name, input)` computes a tool's kind, title and subtitle. Call it for every
tool title and never build one in a component: the thread, the activity groups and the
notifications must show the same line.

---

## 6. Backend parity — the hard rule (`packages/cezar/src/core/ui-parity.test.ts`)

`ui-parity.test.ts` holds the matrix and its rule: every backend emits every capability, so
the GUI degrades per capability, never per backend. It asserts each capability over each
backend's golden-fixture expected output. A real upstream gap takes a named exemption in
that file, with the version surveyed and an inverse assertion. A missing implementation is
never a wire gap.

§6 covers what a mapper emits. §7 covers what a runner does. A backend satisfies both.

<a id="waits"></a>
<a id="ci-wait-tool-contract-474"></a>

## Waits (hearsay-tools/cezarion#1233, hearsay-tools/cezarion#1234; CI since hearsay-tools/cezarion#474)

A run keeps its waits in one list on its record. The agent opens and closes them with the cezar
tools. Read each fact from its owner:

- `packages/contract/src/waits.ts`, `ci-wait.ts` and `ask-schema.ts`: the stored wait shapes, and
  each tool's request, answer, limits and error codes.
- `WAIT_KINDS` in `packages/cezar/src/workflows/run/wait-kinds.ts`: one typed row for each wait
  kind, with its deadline, slot, wake budget, resolvers, cancel paths and texts. A new kind is a
  new row ([ADR 0061](docs/adr/0061-one-wait-engine-executes-wait-kind-rows.md)).
- `cezarTools` in `packages/cezar/src/ci-wait/tools.ts`: the one list of cezar tools, with the
  descriptions that the agent reads. Every runner's adapter, extension and allow-list read
  it, and `cezarToolEnvNames` lists the environment names a harness forwards. A new tool is
  one entry there. `errors.ts` beside it and `workflows/completion-policy.ts` hold the refusal
  messages.
- The `CI_*` constants in `packages/cezar/src/ci-wait/supervisor.ts` and `github.ts`: the PR
  watcher bounds. `packages/cezar/src/workflows/run/constants.ts`: the wake and delivery bounds.
- `.ai/specs/2026-10-17-unified-waits.md`: the model (the turn-end rule, waking, slots and
  liveness bounds).

A wait result is an observation. It grants no merge, review-acceptance or task-completion
authority.

### Private transport and required harness evidence

- A memory-only session capability binds project, run and generation. The capability, not the
  model, names the calling run. `CEZ_TOOL_TOKEN` and `CEZ_TOOL_SOCKET` exist only in the child
  environment: never write them to a prompt, a record, a descriptor snapshot or a setting.
- This is cooperative same-user authorization, not isolation from an unrestricted shell.
- An explicit tool denial stays a denial.
- Before a runner ships, the parity rows must list and call the tools through its native mock
  wire and the real bundled adapter or extension, on fresh, Continue and recovery paths. An argv
  or configuration snapshot is not transport proof.
- A wire limitation needs owner review and a named exemption. Do not skip the row silently,
  widen a permission, or fall back to a marker or to model polling.
- Record the installed interface and version that you checked in
  `packages/cezar/src/ci-wait/__fixtures__/README.md` or in the runner's fixture README.

## 7. Harness parity — session and lifecycle (`packages/cezar/src/core/harness-parity.test.ts`)

The harness matrix drives each real runner class through its native mock. Every criterion
holds for every runner, or carries a `PARITY_EXEMPTIONS` entry whose reason names the wire
limitation. A row that tests Cezar's shared logic above the seam runs on the derived runner
set instead.

Print every row with its exemptions:

```bash
node packages/cezar/scripts/parity-rows.ts
```

`--row R39` prints one row. `--runner pi` prints only the rows that the runner is exempt
from, not the rows that run on it. `--json` prints the index as JSON.

Owners. Paths are relative to `packages/cezar/src/`.

- **Rows** (`{ id, name, scenario }`): the kit modules that `KITS` in
  `packages/cezar/scripts/parity-rows.ts` names. The largest are the `*_CRITERIA` tables in
  `core/harness-parity-core.testkit.ts`, the row lists in
  `core/harness-parity-rows.testkit.ts` and `WAIT_CRITERIA` in
  `workflows/waits-parity.testkit.ts`.
- **Cells:** `core/harness-parity-cells.testkit.ts`,
  `workflows/waits-parity-<part>-cells.testkit.ts` (one module per wait part, registered
  together in `workflows/waits-parity-cells.testkit.ts`) and the testkit of each other family.
  `PARITY_FILES` in `core/parity-classes.testkit.ts` maps every parity test file to its
  family.
- **Exemptions and their kinds:** `PARITY_EXEMPTIONS` and `ExemptionKind` in
  `core/harness-parity-core.testkit.ts`. The wait rows use the same table, except the
  subagent wait rows: `SUBAGENT_EXEMPTIONS` in `workflows/waits-subagents-rows.testkit.ts`.
- **Tiers:** `driveSeam` (`core/harness-parity-core.testkit.ts`) drives a real runner class
  against its own offline mock. `driveRun` (`core/workflow-parity-core.testkit.ts`) drives a
  real `RunManager` run in a temp git repo.
- **Scenario catalog:** `SCENARIOS` and `HARNESS_ADAPTERS` in
  `core/harness-parity-core.testkit.ts`. The steps of each scenario are in
  `packages/cezar/scripts/mock-scenario.mjs`.
- **Row classes and the derived runner set:** `SHARED_RUNNERS` in
  `core/parity-classes.testkit.ts`.
- **Spec-support rows:** `SPEC_FIELD_PROBES` in `core/harness-parity-cells.testkit.ts`.
- **Per-runner files:** `core/harness-<runner>-<part>-parity.test.ts`
  (`harnessParityFile`) and `workflows/waits-<runner>-<part>-parity.test.ts`
  (`WAIT_PARITY_FILES`, `WAIT_PARITY_FAMILIES` in `workflows/waits-parity-catalog.testkit.ts`).
- **Matrix guards and single-runner cells:** `core/harness-parity.test.ts` and
  `workflows/waits-parity.test.ts`.

[docs/areas/runners.md](docs/areas/runners.md) holds the rules for a parity row, for a
per-runner file and for regression coverage. Rules that no check holds:

- A red cell is a runner bug until proven otherwise. Fix the runner. Do not weaken the row.
- A new mock scenario is wire-faithful, as §8 requires of a fixture.
- A native mock matches `mock:<scenario>` over all the native user text it receives. That text
  includes what Cezar adds: in-thread system instructions, resume context and
  `<cezar-context>` blocks. A change that adds text to an opening message strips that text
  before the mock matches, in `packages/cezar/scripts/mock-session-context.mjs`. The mock
  still records the raw text, because tests assert what Cezar sent.

Autosave process attribution is observation, not OS containment: `autosave-holders.ts` and
`autosave-windows.ts` say what it cannot see.

### Continue: session and step (hearsay-tools/cezarion#2991)

`continuedSessionId` and `resumableSessionId` in `workflows/run/launch-read-resolver.ts` own
which step a Continue continues and which session it resumes.
`workflows/native-session-continue.test.ts` drives every runner through them.

### Governed delegation controls (D1)

The `restrictCrossSessionMessaging` doc comment in `core/agent-runner.ts` says what a governed
session is and what its launch turns off. The same row of each runner's `*_SPEC_SUPPORT` names
that runner's control. The D1 entries in `PARITY_EXEMPTIONS` name, for each runner without a
control, the reason and the version inspected. The Owned workers part of `README.md` states
the limits that a user meets, and § 11 of
`.ai/specs/2026-10-27-task-communication-protocol.md` holds the probe evidence.

A control adds no tool grant and writes no harness configuration file. The controls are
cooperative same-user supervision, not isolation.

### Native cross-session messaging at shipped defaults (D3)

A runner's native cross-session messages bypass Cezar's recorded conversations, so Cezar tasks
talk through `cez message`. The "Messaging other tasks" text of `handoffInstructions`
(`packages/cezar/src/handoff.ts`) tells every session so. The D3 cells and the D3 entries in
`PARITY_EXEMPTIONS` hold each runner's control at shipped defaults; § 11 of the same spec
holds the probe evidence.

Cezar changes no MCP server, plugin or tool setting of the user.

<a id="codex-retrying-stream-errors-550"></a>

### Codex retrying stream errors

`core/codex-startup.test.ts` holds the retry rules, and
`core/__fixtures__/codex/stream-retry.md` records the probe.

---

## 8. The golden-fixture testing contract

`packages/cezar/src/core/__fixtures__/<backend>/` holds pairs: `<name>.ndjson` is the
backend's wire output, and `<name>.expected.json` is the exact `UiEvent[]` that its mapper
must produce. `<backend>-ui-mapper.test.ts` replays each pair the way the runner drives the
mapper. §6 reads the same expected files.

- Take every fixture from the upstream wire: a live capture, or the upstream schema or
  source. Never encode a shape that you assume.
- Cite the upstream source and version in the fixture directory's `README.md`. Label each
  constructed frame as constructed, and say what you could not run live.

## 9. Persistence & transport

Each run has one append-only NDJSON event file that holds v1 and v2 events together
(`docs/areas/runs-store.md`). Never rewrite, reorder or renumber it. The per-run SSE route
replays it, then streams live, under the event names `run-event` (v1) and `ui-event` (v2).
The multiplex route has its own envelope: `packages/cezar/src/server/live-routes.ts` holds
it. A Cezar-owned event such as
`provider-auth-required` never carries vendor error text or credentials.

---

<a id="10-adding-a-new-runner-the-387-pi-checklist"></a>

## 10. Adding a new runner (the open-mercato/cezar#387 `pi` checklist)

A new backend is one class behind the seam, its mapper, its fixtures and its rows in both
parity matrices. No backend-specific type leaves `packages/cezar/src/core/`.

Add the id to `RUNNER_IDS` (`agent-runner.ts`) first. The compiler and the guard tests
then name most of the missing pieces. The items below are the steps that they do not
force, or force only in part. The item numbers are stable: code cites them.

1. **Runner** — `core/<runner>-runner.ts` implements `AgentRunner` / `AgentSession`.
   Declare `specSupport` and the `RUNNER_FACTS` row from what the wire does, not from a
   similar runner. Probe mid-turn input live for `inputDelivery`. Probe a resumed session
   for `systemPromptOnResume`; when you cannot, declare `resent`. Use
   `prependSystemPrompt` when the backend has no system-prompt channel. For a fork of an
   existing runner's wire, read the fork's own protocol documents for the turn boundary,
   the session id and the tool flags before you copy code.
2. **Factory** — the compiler and the guard tests name each place: the `case` in
   `createRunner`, `runnerSchema` (`packages/contract/src/health.ts`), and `UiBackend` in
   `ui-events.ts` and in its api-client copy (§3).
3. **Detection** — add the runner's probe to `RUNNER_PROBES` (`core/backend-detect.ts`).
   An absent CLI never fails the boot.
4. **Mapper** — `core/<runner>-ui-mapper.ts` emits the v2 stream (§4).
5. **v1 alongside v2** — emit v2 through `SessionOptions.onUiEvent` and keep the v1
   stream.
6. **Golden fixtures** — follow §8, and cover every §6 capability that the wire supports.
7. **Parity** — every §6 row passes or carries a named exemption.
8. **Harness parity** — add the runner to `HARNESS_ADAPTERS`
   (`core/harness-parity-core.testkit.ts`) and make its offline mock a wire encoder over
   `packages/cezar/scripts/mock-scenario.mjs`. That module owns scenario selection and scripts; the mock
   emits the backend's native frames. A wire gap is a `PARITY_EXEMPTIONS` entry; the guard
   tests of the matrix hold what an entry may say.
   Choose the ask path: `cezar_ask` alone, or also a native bridge onto `ask.requested`. A
   native bridge keeps its pending request in the session and routes the next human answer
   back through it. It answers a malformed native request with an error and never leaves
   the turn blocked. Each native ask kind that a human can answer needs an entry in
   `askResumeCases`. Prove the Cezar tools as
   [Waits](#ci-wait-tool-contract-474) requires.
9. **Plumbing** — Settings → Agent config ships with the runner: the doc comment of
   `packages/web/src/routes/settings/agent-descriptors.ts` holds the rules. Add the composer
   presets and the Settings → Agents entry. Keep every change additive, so that old run
   records still parse.
10. **Model selection** — `BACKEND_MODEL_MAP` and `core/model-identity.test.ts` hold the
    rules.
11. **Host model discovery** — ships in the runner's PR. `model-discovery-guard.test.ts`
    forces the contract enum, the adapter module and the catalog registration, or a
    `MODEL_DISCOVERY_EXEMPTIONS` entry with the wire reason. It does not force these
    rules. The adapter calls the CLI's own model-listing surface under the runner's child
    environment, with bounds, and throws when it cannot read the model list. It never
    reads the CLI's config or cache files and never runs a model turn. Add the runner to
    `models-api.test.ts`, which also holds what a failure may report.
12. **Credentials** — the runner's entry in `BACKEND_ALLOW_PREFIXES` (`core/agent-env.ts`)
    lists a prefix for every provider that its model ids can name. Never widen another
    backend's entry.

<a id="11-the-plan-channel-pr-443"></a>

## 11. The plan channel (PR open-mercato/cezar#443)

`plan.updated` is a full replacement (`UiPlanUpdatedEvent`). In a new mapper, find the
backend's real plan channel on its wire: it is not always a todo tool. The mapper tests of
the existing backends hold their channels.

---

## Compatibility

v1 `AgentEvent` `type` strings, v2 `UiEvent` dotted types and the names `run-event` and
`ui-event` (§9) are additive-only: saved runs and shipped clients read them. A
test pins the shipped type strings. To remove or rename one, or to break the parity
requirement (§6, §7), is a breaking change under `BACKWARD_COMPATIBILITY.md`.

## Related documents

- `docs/areas/runners.md` — how a runner change is tested.
- `.ai/specs/2026-09-04-harness-parity-matrix.md` — design record of the harness parity
  matrix (§7).
- `.ai/specs/2026-07-14-cockpit-ui-redesign.md` and
  `.ai/analysis/cockpit-ui-redesign/agent-event-protocols.md` — design record of protocol
  v2.
- `.ai/specs/2026-10-02-omp-runner.md` and
  `packages/cezar/src/core/__fixtures__/omp/README.md` — OMP design record and wire
  evidence.
