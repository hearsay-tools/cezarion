# Shared harness parity test matrix

> Issue: hearsay-tools/cezarion#68 · Depends on: `2026-07-14-cockpit-ui-redesign.md` (protocol v2 and its backend-parity requirement)

## TLDR

`ui-parity.test.ts` pins one thing: every mapper emits every v2 UI capability. Everything else a
runner owes cezar — session lifecycle, provider-failure surfacing, `sendMessage`, ask routing, park
declarations — is asserted per runner, ad hoc, in per-runner test files. Nine recent fixes
(hearsay-tools/cezarion#2, hearsay-tools/cezarion#3, hearsay-tools/cezarion#4, hearsay-tools/cezarion#5, hearsay-tools/cezarion#6, hearsay-tools/cezarion#46, hearsay-tools/cezarion#48, hearsay-tools/cezarion#53, hearsay-tools/cezarion#54) each repaired a failure mode that no shared contract
covered, so the next one repeats on the next backend.

This spec adds a second executable matrix beside the first: one criterion catalog, two tiers, every
`RUNNER_IDS` backend, and an exemption table the test itself validates. Adding a runner becomes "make your mock
answer the shared scenario catalog and pass every row".

## Resolved assumptions

| # | Question | Applied default | Why | Confirm? |
|---|---|---|---|---|
| Q1 | Where do rows assert? | Two tiers: the `AgentRunner`/`AgentSession` seam, and a real `RunManager` run. | `ask.requested` is emitted by the RUNNER for codex, opencode and cursor, and by `workflows/run.ts` for claude and pi. Groups 1, 3 and 6 are only uniform above the seam; a seam-only matrix would exempt the marker-based ask paths on exactly the rows the recent fixes were about. | confirmed by owner |
| Q2 | A cell a backend cannot satisfy? | A declared `PARITY_EXEMPTIONS` entry carrying a reason, asserted INVERTED so a stale exemption fails. | An `it.skip` is invisible; an inverted assertion is a ratchet. AC #6 needs exemptions to be data the suite validates, not a comment. | confirmed by owner |
| Q3 | What transport drives a row? | Each backend's real runner class against its own existing mock binary, selected by the `CEZ_*_BIN` var it already reads. | A test-owned fake transport would be a second wire-shape source of truth, drifting from the mocks. `AGENT_PROTOCOL.md` §7 names that drift as PR open-mercato/cezar#443's root cause. | ok |
| Q4 | Shared scenario names, or shared markers? | Shared NAMES; the adapter maps each to that backend's own `mock:` spelling. | Renaming `mock:turn-failed` or `mock:auth-error` would churn passing runner tests for no gain, and the existing markers are already wire-faithful. | ok |
| Q6 | S3 — every backend echoes a `session` event? | No: the criterion is a RESUMABLE id, from the v1 `session` event or the settled `AgentRunResult`. | Codex, opencode and pi mint their own id and echo it; claude pins the id cezar supplied (`--session-id`) and returns it. Both are how `resumeCommand()` gets an id, and demanding the event would have failed claude for conforming to its own documented wire. | applied during implementation |
| Q7 | S7 — every backend emits `session.error`? | No: v2 must signal the failure, and the CHANNEL is per-wire. | opencode and pi have a session-level error frame, codex reports a failed turn, claude has only the result envelope's stop reason. What hearsay-tools/cezarion#53 and hearsay-tools/cezarion#54 both WERE is the run looking finished, so that is what the row pins. | applied during implementation |
| Q8 | R1 — does a clean run reach a terminal status? | Only when the agent DECLARES completion, so R1 needs its own `done` scenario. | A markerless turn-end parks as `waiting` on every backend, and that is correct cezar behaviour. R1's first draft asserted a terminal status off `baseline` and failed every backend for the wrong reason. | applied during implementation |
| Q5 | New env var for the matrix? | None. | The mock selectors in `HARNESS_ADAPTERS` already exist and are documented. Zero-config: never trade a working default for a knob. | ok |

## Problem Statement

The runner seam has one hard, executable rule and it covers one axis. `AGENT_PROTOCOL.md` §6 demands
that every v2 UI capability is emitted by every backend, and `ui-parity.test.ts` asserts exactly that
over the golden fixtures' expected output. Nothing asserts the rest of the contract in
`agent-runner.ts`.

The consequence is visible in the fix history. Every one of these was found in production, on one
backend, after the same class of bug had already been fixed on another:

| Group | Issues | The failure mode |
|---|---|---|
| 1. Provider / auth failure surfacing | hearsay-tools/cezarion#53 (opencode), hearsay-tools/cezarion#54 (pi) | A runtime provider rejection parked the run as "Needs You" instead of failing it. |
| 2. Turn / session liveness | hearsay-tools/cezarion#4 (opencode) | undici's 300s headers timeout ended a healthy long turn; the runner took turn-end from an HTTP response instead of the backend's own idle signal. |
| 3. Native ask / question bridge | hearsay-tools/cezarion#6 (opencode) | The native question tool never became an `ask.requested` card. |
| 4. Sub-agent / child session binding | hearsay-tools/cezarion#5 (opencode), open-mercato/cezar#600 (codex) | A child session's `turn/completed` ended the PARENT turn. |
| 5. Text coalescing / message boundaries | hearsay-tools/cezarion#2, hearsay-tools/cezarion#3 (pi) | One v1 `text` per token, so a trailing `CEZ:ASK` marker never matched its regex. |
| 6. Monitoring / wake / auto-continue | hearsay-tools/cezarion#46, hearsay-tools/cezarion#48 (claude) | A park declaration was missed, or produced overlapping wakes. |
| 7. Baseline `AgentSession` contract | — | Never asserted uniformly at all. |

Groups 1, 3 and 6 share a structural property that decides this spec's shape: **their uniform
behavior does not exist at the seam.** `ask.requested` comes from the runner in
`codex-app-server-runner.ts`, `opencode-server-runner.ts` and `cursor-acp-runner.ts`, and from `workflows/run.ts`
for claude and pi. Whether a provider failure fails the run or parks it is decided in
`workflows/run.ts`, not in the runner. A seam-only matrix would have to exempt claude and pi, or
codex, opencode and cursor, on precisely the rows the last nine fixes were about.

## Research

The mechanism this spec needs already exists and is unused as a contract. Every backend ships a mock
binary that the runner selects from an env var it already reads, and each mock is driven by
`mock:<scenario>` markers found in the prompt text:

| Backend | Mock binary | Selector | Scenarios today |
|---|---|---|---|
| claude | `packages/cezar/scripts/mock-claude.mjs` | `CEZ_CLAUDE_BIN`, or `CEZ_DRY_RUN=1` | `done`, `monitoring`, `ask`, `ask-bad`, `ask-invalid`, `ask-near`, `refs`, `slow`, `auth-error`, `limit`, `md`, `subagents`, `schedule-wakeup` |
| codex | `packages/cezar/scripts/mock-codex-app-server.mjs` | `CEZ_CODEX_BIN` | `turn-failed`, `subagent-activity`, `child-turn`, `native-codex-ask` |
| opencode | `packages/cezar/scripts/mock-opencode-serve.mjs` | `CEZ_OPENCODE_BIN` | `ask`, `ask-reply-late`, `resume-done`, `done`, `provider-error` |
| cursor | `packages/cezar/scripts/mock-cursor-acp.mjs` | `CEZ_CURSOR_BIN` | `ask`, `plan`, `resume-done` |
| pi | `packages/cezar/scripts/mock-pi-rpc.mjs` | `CEZ_PI_BIN`, or `CEZ_DRY_RUN=1` | `monitoring`, `backend-resume`, `backend-resume-text` |

`workflows/run.test.ts` already proves the second tier is reachable offline: its open-mercato/cezar#565 suite points
`CEZ_CODEX_BIN` at the codex mock, inits a temp git repo, and drives a real `RunManager` run to a
parked state. The matrix generalizes that one suite across `RUNNER_IDS` instead of inventing a
mechanism.

The scenario markers are also, usefully, already wire-faithful — they were written alongside the
golden fixtures and cross-checked against the real CLIs, which is the standard `AGENT_PROTOCOL.md` §7
demands and the standard the new scenarios must meet.

## Proposed Solution

Three artifacts, plus docs.

### 1. `packages/cezar/src/core/harness-parity.testkit.ts`

The shared declaration. `*.testkit.ts` is the repo's existing suffix for test helpers that are
typechecked but excluded from `dist` (`packages/cezar/tsconfig.json`'s `exclude`), so the matrix's
scaffolding never reaches the published tarball.

It exports:

- `SCENARIOS` — the shared scenario-name catalog. A name, not a marker.
- `HARNESS_ADAPTERS: Record<RunnerId, HarnessAdapter>` — per backend, the env var and mock path that
  make it offline, plus a scenario-name → prompt-text map and `askResumeCases` naming
  every exposed human ask kind and its answer.
- `PARITY_EXEMPTIONS: ReadonlyArray<{ criterion: string; backend: RunnerId; reason: string }>`.
- `driveSeam()` — start a real session against the mock, collect v1 `AgentEvent[]`, v2 `UiEvent[]`
  and the settled `AgentRunResult`.
- `driveRun()` — a real `RunManager` run in a temp git repo, returning the final `RunRecord` plus the
  observed status transitions and v2 events.

### 2. `packages/cezar/src/core/harness-parity.test.ts`

The matrix. One file, looping `RUNNER_IDS × CRITERIA` the way `ui-parity.test.ts` loops `BACKENDS` —
which is what makes "one shared matrix names each criterion once for every harness" literally true of
the source.

### 3. Mock-binary extensions

Each mock grows the scenarios it does not answer yet, in its own real wire shape.

### Docs

`AGENT_PROTOCOL.md` gains a section for this matrix directly after the §6 UI-parity rule, each
cross-referencing the other, and §9's new-runner checklist gains a harness-parity item. `AGENTS.md`'s
"Agent runners / backends" routing row points at both.

## Architecture

### Scenario names are shared; spellings are not

The matrix names a scenario once. The adapter maps it to whatever that backend's mock already calls
it:

```ts
claude:   { 'provider-error': 'mock:auth-error',      'ask': 'mock:ask' }
codex:    { 'provider-error': 'mock:turn-failed',     'ask': 'mock:native-codex-ask' }
opencode: { 'provider-error': 'mock:provider-error',  'ask': 'mock:ask' }
pi:       { 'provider-error': 'mock:provider-error',  'ask': 'mock:ask' }
```

This is the whole reason the change lands without churning the passing per-runner test files: no existing
marker is renamed, and the criterion catalog stays free of backend vocabulary.

The catalog:

| Scenario | The mock must | Rows it serves |
|---|---|---|
| `baseline` | one text, one tool call and result, usage, then the backend's terminal turn signal | the seam contract rows |
| `done` | the same, with a trailing `CEZ:DONE` | R1 |
| `hold` | delay the terminal turn signal ~250 ms AFTER the last content event | S2 |
| `split-text` | stream the reply as three or more token-sized deltas, ending with a trailing `CEZ:MONITORING` | S8, R5 |
| `provider-error` | a runtime provider rejection in the backend's native error shape | S7, R2 |
| `ask` | an ask — native where the wire has one, a `CEZ:ASK` marker otherwise | R3 |
| `ask-resume` / `plan-resume` | accept one human answer and finish with `CEZ:DONE`, without another prompt | R26 |
| `ask-reply-late` | native ask whose reply acknowledgement can lag the resumed turn | R9 |
| `ask-bad` | a malformed ask, and then still end the turn | R4 |
| `subagent` | child work attributed to a parent, and a child terminal signal | S9 |

`baseline` is every mock's existing default turn, so it costs nothing. A second turn needs no
scenario either: the mocks for every `RUNNER_IDS` backend already loop on their transport, so `sendMessage` reuses `baseline`.

### Tier 1 — seam rows

Driven by `driveSeam()`: the real runner class, a real child process, the real mock.

| Row | Scenario | Asserts | Group |
|---|---|---|---|
| S1 | `baseline` | exactly one v1 `done`, and it is the last event | 7 |
| S2 | `hold` | the turn ends on the backend's own terminal signal, after the last content event; exactly one `turn.completed` | 2 |
| S3 | `baseline` | a resumable session id, from the v1 `session` event or the settled result (Q6) | 7 |
| S4 | `baseline` | v1 `token-usage` above zero AND a v2 `usage.updated` | 7 |
| S5 | `baseline` ×2 | `sendMessage` returns true while `open`, and a second turn completes | 7 |
| S6 | `baseline` | `interrupt()` settles `result` with no v1 `error` and no `turn.completed` carrying `stopReason: 'error'` | 7 |
| S7 | `provider-error` | a v1 `error` with a non-empty message, a v2 signal of the failure, and never a clean `end_turn` (Q7) | 1 |
| S8 | `split-text` | the deltas coalesce into ONE v1 `text` holding the whole string, with the trailing marker intact under `/CEZ:MONITORING\s*$/` | 5, 6 |
| S9 | `subagent` | the parent turn ends exactly once, after the child's content — a child terminal signal never ends the parent | 4 |
| S10 | `baseline` | `session.pid` is a number while the session is open | 7 |

S8 is group 5 and group 6 in one row on purpose. hearsay-tools/cezarion#2's real damage was not split text as such — it was
that a cezar marker assembled across deltas stopped matching its anchored regex (`CEZ:ASK` there,
`CEZ:MONITORING` here; the two are the same integrity property, and `CEZ:MONITORING` is the one R5
also needs). Splitting that into two scenarios would let a backend pass the coalescing row while
still dropping the marker. One scenario keeps the cause and the symptom in the same cell.

### Tier 2 — run rows

Driven by `driveRun()`: a real `RunManager` run in a temp git repo, the shape
`workflows/run.test.ts` already uses.

| Row | Scenario | Asserts | Group |
|---|---|---|---|
| R1 | `done` | a declared-complete run reaches the review gate, never `waiting` (Q8) | 7 |
| R2 | `provider-error` | the run reaches `failed`, and `waiting` is never observed on the way | 1 |
| R3 | `ask` | status `waiting`, and exactly one `ask.requested` carrying at least one question | 3 |
| R4 | `ask-bad` | the run reaches a terminal status and emits no `ask.requested` | 3 |
| R5 | `split-text` | status `running` with `activity: 'monitoring'` — not `waiting` | 6 |

| R26 | `ask-resume`, plus `plan-resume` for Cursor | every exposed ask kind reaches completion after one human answer; no later `waiting` or second human prompt | hearsay-tools/cezarion#398 |

R26 loops `RUNNER_IDS` and each adapter’s `askResumeCases`: native question wires
for Codex/OpenCode, question and plan wires for Cursor, and `CEZ:ASK` for Claude/Pi.
The total-coverage guard requires a live prompt and nonempty inventory or a named
exemption. A native-answer `end_turn` is a wire boundary, not a human handoff;
Cursor must resume work after it. R6 keeps its markerless owned-input drain contract.
A prose guard rejects counted runner rosters in `AGENT_PROTOCOL.md`, this spec and
harness-parity comments; use `RUNNER_IDS` or explicit backend names instead.

R2 and R5 are the two rows that would have caught hearsay-tools/cezarion#53, hearsay-tools/cezarion#54 and hearsay-tools/cezarion#48 on any backend rather than on the
one that shipped the bug.

### Exemptions are data the suite validates

```ts
{
  criterion: 'S9',
  backend: 'pi',
  reason: 'pi task tools are plain tool calls; the RPC has no child session to end a parent turn',
}
```

**Two kinds, because inversion is not always meaningful.** The first draft had one, and pi/S9 broke
it: pi's RPC has no child session, so an unrelated baseline turn satisfies S9 by accident and the
inverted assertion fails for a backend that is behaving correctly. So an entry declares which case
it is:

- `capability-absent` — the scenario IS constructible; the backend just does not produce the signal.
  Pinned by the inverted assertion below.
- `scenario-unconstructible` — the wire cannot create the situation at all. Pinned by requiring the
  adapter to declare NO prompt for that scenario, so the day a mock answers it the exemption fails
  and the row must go live.

A guard asserts the kind and the declared prompt agree, so a contradictory entry cannot land.

Three rules, each executable:

1. **Inverted assertion** (`capability-absent`). An exempt cell still produces a named test, which
   asserts the capability really is absent. A mock that later grows it fails its own exemption,
   forcing the entry's removal. A stale exemption cannot sit green.
2. **Total coverage.** A guard test asserts every `(criterion, backend)` pair is either a live row or
   an exemption. A new id in `RUNNER_IDS` therefore fails the suite until every row is addressed,
   which is AC #6 made mechanical rather than procedural.
3. **No skips.** `it.skip` and `it.todo` are never used in this file; a guard test reads the file's
   own source to keep it that way. An exemption must be visible in the table, with a reason.

### Error handling and offline guarantee

Every row runs offline. Each adapter sets its backend's `CEZ_*_BIN` to the mock path and restores the
prior value afterwards, following the existing save/restore shape in `pi-runner.test.ts` and
`workflows/run.test.ts`. No row reaches a real vendor CLI, no row needs a login, and no row opens a
network socket beyond loopback (the opencode mock's own HTTP server). `CEZ_DRY_RUN` is not the
mechanism — an explicit per-backend bin keeps a row's transport visible in the adapter rather than
implied by a global.

### Testing

The matrix IS the test. Two things about it need their own proof:

- **The guard tests must fail for the right reason.** Adding a fake fifth id to a local copy of
  `RUNNER_IDS` must fail the total-coverage guard; removing a real exemption's target capability from
  a mock must fail the inverted assertion. Both are checked by hand during implementation, per
  AGENTS.md's "prove the regression test fails without the fix".
- **Each new mock scenario must be wire-faithful.** Every addition cites the fixture or runner test it
  was derived from, as `AGENT_PROTOCOL.md` §7 requires. A scenario invented from assumption is the
  open-mercato/cezar#443 failure repeating inside the very suite meant to prevent it.

## Cost

Tier 2 runs each run criterion against every `RUNNER_IDS` backend, with an additional
cell for each exposed ask kind in R26. Keep these offline child-process runs bounded.
That keeps the suite inside AGENTS.md's "no server, no browser" fast-gate rule — a spawned mock CLI is
what `workflows/run.test.ts` already does — but it is the change's whole runtime cost and it is
deliberate: the owner chose the orchestrator tier precisely because groups 1, 3 and 6 are not uniform
below it.

## What the matrix found

Authoring it turned up one real defect, which is the point rather than a side effect.
`resultStopReason` in `claude-ui-mapper.ts` matched on the result subtype first, so `success`
returned `end_turn` and never consulted `is_error` — and Claude Code reports a revoked credential in
an `is_error: true` result whose subtype is still `success`. v1 emitted the error correctly, so the
run failed, but the cockpit was told the auth failure was a clean end of turn. That is group 1 on
claude's wire, unfixed after hearsay-tools/cezarion#53 and hearsay-tools/cezarion#54 fixed it on opencode and pi, and no test covered it. Row S7
is what found it; the fix ships in the same branch, with its own `resultStopReason` case.

Every row was verified red by reintroducing the defect it pins — ending the opencode turn on its
`prompt_async` ack (hearsay-tools/cezarion#4), publishing each delta as its own v1 `text` (hearsay-tools/cezarion#2), suppressing pi's provider
error (hearsay-tools/cezarion#54), letting any `session.idle` close the parent turn (open-mercato/cezar#600), ignoring a malformed codex
`requestUserInput` (a wedge), and reverting the claude fix above. The three guard tests were verified
red the same way.

## Out of Scope

- **Shipping new runners.** Every existing `RUNNER_IDS` backend, including Cursor, is in scope
  for parity; new runner implementations belong in their own issues.
- **Live network E2E against real vendor CLIs in default CI.** Mock children only.
- **Changing `ui-parity.test.ts`.** It keeps mapper parity unchanged; it gains a pointer comment to
  its sibling and nothing else.
- **A new `CEZ_*` env var.** The mock selectors in `HARNESS_ADAPTERS` already exist.
- **Reworking the per-runner test files.** They keep their backend-specific cases; the matrix
  adds the shared floor beneath them rather than absorbing them.
