# AGENT_PROTOCOL.md — the cezar agent protocol

cezar runs coding-agent CLIs behind **one backend-agnostic seam** and renders
every backend through **one normalized event vocabulary**. This document is the
operational contract for that seam: what a runner must implement, what it must
emit, how the emissions are tested, and what a *new* runner (e.g. `pi`, PR #387)
has to satisfy to be a first-class backend rather than a second-class one.

It is the concise, load-bearing contract. The deep design record lives in
`.ai/analysis/cockpit-ui-redesign/agent-event-protocols.md` (§7 schema, §7.1 the
per-backend mapping tables) and the spec `.ai/specs/2026-07-14-cockpit-ui-redesign.md`
(§"Normalized agent-event protocol v2", §"Backend parity requirement"). The code
in `packages/cezar/src/core/` cites those two by section; this file cites the code. When the two
disagree, **the code wins** — the golden fixtures and the parity test are
executable, the prose is not.

The protocol has **two layers that ship together**:

- **v1 `AgentEvent`** — the original flat stream. Persisted in old NDJSON
  recordings and still consumed by `cezar run`'s console renderer. Never
  removed; old recordings must keep replaying forever.
- **v2 `UiEvent`** — the normalized, item-lifecycle protocol the redesigned
  cockpit renders. Emitted **alongside** v1, never replacing it. A mixed NDJSON
  file (v1 + v2 lines) is valid by design.

---

## 1. The runner seam (`packages/cezar/src/core/agent-runner.ts`)

Every backend is one class implementing `AgentRunner`, constructed through the
single factory `createRunner(backend)` in `packages/cezar/src/core/runner-factory.ts`. Nothing
outside `packages/cezar/src/core/` should ever `new` a concrete runner or branch on the backend
id — that is the whole point of the seam.

### Identity

```ts
const RUNNER_IDS = ['claude', 'codex', 'opencode', 'pi'] as const;  // the source of truth
type RunnerId     = (typeof RUNNER_IDS)[number];                   // user-selectable
type AgentBackend = RunnerId | 'claude-cli';                       // + legacy id, still parses
```

`RUNNER_IDS` is the tuple every other enumeration derives from — the zod schemas
(config, run store, workflow steps, the API bodies), the server-install
"at least one agent CLI" gate, and the CLI-handoff registry. Re-listing the ids
by hand is how a runner silently goes missing from one seam (#387 review); use
`RUNNER_IDS` / `isRunnerId()` instead.

`claude-cli` is a **legacy** backend id kept so old `runs.json` records and
NDJSON transcripts still parse; `createRunner` maps it onto `claude`. Follow that
precedent — never repurpose or remove a shipped id.

### `AgentRunner`

```ts
interface AgentRunner {
  readonly backend: AgentBackend;
  run(spec: AgentRunSpec, onEvent?: (e: AgentEvent) => void): Promise<AgentRunResult>;
  startSession(spec: AgentRunSpec, onEvent?: (e: AgentEvent) => void, opts?: SessionOptions): AgentSession;
  interrupt(): Promise<void>;
}
```

- `run()` is a one-shot convenience; `startSession()` is the real contract.
- Each backend runs as a **persistent process** so multi-turn follow-ups,
  `waiting`, interrupt and resume all work: claude = stream-json over
  stdin/stdout; codex = `codex app-server` JSON-RPC 2.0 (JSONL) over
  stdin/stdout; opencode = `opencode serve` over HTTP + SSE; pi =
  `pi --mode rpc` over JSONL stdin/stdout.

### `AgentSession`

A live session over one spawned process, alive between turns:

```ts
interface AgentSession {
  result: Promise<AgentRunResult>;   // resolves when the process exits
  readonly pid?: number;             // root of the run's process tree (resource telemetry, #348)
  sendMessage(content: ContentBlock[]): boolean;  // human input; false when closed
  sendAgentMessage(content: ContentBlock[]): false | Promise<void>; // reserve now, acknowledge asynchronously
  discardQueuedMessages(): void;     // drop mid-turn follow-ups; CEZ:ASK park calls this
  end(): void;                       // graceful: end input, SIGTERM→SIGKILL watchdog
  interrupt(): void;                 // hard stop (cancel)
  readonly open: boolean;
}
```

A termination the runner itself caused is **not** an agent failure (#703).
`end()` arms a SIGTERM→SIGKILL watchdog for CLIs that ignore EOF, and
`interrupt()` signals outright; the agent CLIs install their own handlers and
exit `128 + signal`. A runner MUST therefore record that it sent the signal and
settle such an exit on the normal path — `isSignalTerminationExit(exitCode)`
(`packages/cezar/src/core/agent-runner.ts`) plus a `note` — instead of throwing. Throwing makes
a finished run settle as `failed` and a cancelled run settle as `failed` too.

That watchdog MUST gate its SIGKILL escalation on real termination, never on
`ChildProcess.killed` (#844). Node sets `killed` when a signal is *delivered*,
so the watchdog's own SIGTERM flips it while the CLI — which handles the
signal — keeps running, and the escalation written for exactly that case is
skipped. Use `trackChildExit(child)` (`packages/cezar/src/core/agent-runner.ts`),
which seeds from `exitCode`/`signalCode` and listens for `exit`.

**Non-human input (owned workers, 2026-09-06).** `sendAgentMessage` must never
resolve a native question or a portable marker ask. False means the caller still
owns the input and must retry at a later safe boundary, NEVER fall back to
`sendMessage`. All four runners conservatively accept it at idle turn boundaries;
existing human mid-turn steering and native answer routing are unchanged. Already
queued human turns have priority: Claude counts outstanding prompt results and
OpenCode counts queued human prompts through their HTTP acknowledgements. Pi's
autonomously resumed turns are active too. OpenCode preserves its immediate v1
SSE-idle boundary; when a question-reply or queued-prompt HTTP acknowledgement
settles later, it emits an in-process readiness hint instead.

RunManager persists an attributed `AgentInput` before calling this seam, retains
it on false or rejection, and records `deliveredAt` only after the returned Promise
resolves. The method remains synchronous: false refuses without a write; a Promise
reserves one submission immediately, but is not a delivery receipt. Codex resolves
at the matching turn/start or turn/steer RPC result, OpenCode at successful prompt
HTTP acknowledgement, and Pi at the matching prompt response id. Claude has no
per-prompt RPC receipt: its write callback proves only successful pipe delivery,
not model execution. A transport rejection remains replayable; a successfully
accepted command followed by a provider failure retains its transport receipt.
OpenCode's provider-error SSE frame may overtake the independent HTTP ACK: the
runner holds v1 failure and subsequent SSE frames until that request settles,
with the teardown grace as an upper bound. An unresponsive ACK is aborted and
remains undelivered; explicit end/interrupt still abort immediately.
Human `sendMessage` keeps its existing synchronous semantics. The `agent-input` event
carries `{input: {id, source: 'agent'|'lifecycle', parentRunId, text, createdAt,
deliveredAt?, conversation?: {senderRunId, recipientRunId, kind, requestId?}}}`; it is not a `user-message`, does not resolve an ask card, and
never expands registry slash skills. The queue cap is 32 **undelivered** inputs, including the in-flight reservation.
Only one exact current state/session/input can be in flight. ACK merges into the
current durable queue, preserving concurrent enqueues; duplicate readiness hints
cannot submit it again. Synchronous steer reports queued until that checkpoint.
Finish, cancellation, disposal and replacement revoke callback authority; a late
ACK cannot stamp a replacement generation or reopen a stopped run. Pending delivery
bookkeeping settles before execution finalization; it is never process-exit proof.
Fresh, queued, starting, parked and continuation sessions read the same durable
queue. Owned workers with pending asks recover without synthetic answers; only
explicit human-answer Continue can reopen them. Bare Continue cannot consume an ask.
`user-message` remains the legacy transcript of human attempts, including refused
sends; ask recovery instead replays validated `human-input-delivered` checkpoints
with the answered `askSeq`. Live sends checkpoint only on true; continuation opening
answers checkpoint at their first successful, open-session turn boundary (never
a fatal, cancelled or shutdown boundary). A checkpoint for an older
ask cannot clear a newer question; absent checkpoints retain the ask conservatively.

Parent/worker conversations use the same `sendAgentInput` seam in both directions.
The root's durable conversation ledger is authoritative; `conversation-message`
`{message, delivery}` and `request-outcome` `{outcome}` events are replayable projections in
both participants' transcripts, keyed by message/request identity. Agent-input ACK
updates delivery display without creating a second conversation row. Replayed
projections never enqueue input or resolve a human ask. Attribution carries actual
sender and recipient IDs; the legacy `parentRunId` remains the ownership root.

Kinds are `request`, `progress`, `follow-up`, and `reply`. A request's message ID is
its obligation ID; follow-ups and replies name `requestId`. Exact message retries
reuse the existing durable input; changed payloads are rejected. Follow-ups and
progress cannot discharge obligations. Explicit reply and completed-without-reply
are distinct outcomes, alongside failed, cancelled, destroyed, timed-out, and
sender-closed. Late replies remain recorded without replacing a first settlement.
Both roles can wait on their own requests using the existing bounded scheduler wake
queue. An incoming message can interrupt that wait with reason `message`, retaining
unresolved obligations; there is no automatic re-wait or terminal continuation.

Messages are bounded to 100,000 characters, 32 undelivered inputs per recipient,
1,024 messages per family, and 32 pending obligations. Requests and waits expire
in 600 seconds by default (1–1,800 seconds accepted). One active wait per run.
Review/terminal delivery requires explicit human Continue; destroyed recipients
receive no input. Only a human can answer an outstanding human ask. Durable queue
insertion is atomic with acceptance, while provider acceptance and the local ACK
checkpoint retain the documented crash ambiguity below.

Already accepted input precedes automatic `CEZ:DONE` closure at a safe boundary,
not explicit Finish, cancellation, destruction or fatal failure. Empty queues
preserve ordinary completion. A completed turn with an outstanding ACK retains its
DONE intent and nonfinal auto-end hold; acknowledgement rechecks that exact idle
boundary, without requiring a phantom turn. Worker-wake reservation acquires real
capacity immediately, while only positive ACK plus checkpoint retires the durable
wait. A wake turn completed before ACK does not become running again at ACK. A temporary refusal during a late OpenCode HTTP ack
keeps accepted input queued even when the completed turn declares DONE. Rejected
OpenCode agent-input POSTs emit a fatal error before any synthetic turn boundary,
stop further delivery, and fail the run. Opening POST failure is also fatal before
its synthetic boundary, reported once; human follow-up rejection stays nonfatal.
Disk and stdin are not transactional: a failed
post-acknowledgement checkpoint interrupts the invocation and reports a persistence failure,
retaining the same input ID. Recovery may replay that identified context (at-least-once,
not exactly-once delivery); it must never silently drop it or claim success.

`SessionOptions`:

- `autoEndAfterFirstTurn?` — single-turn behavior for non-interactive workflow
  steps; interactive sessions control `end()` themselves.
- `shouldAutoEnd?: () => boolean` — internal synchronous veto checked when the
  auto-end timer executes, including waits accepted after it was armed. False
  holds that auto-end; a later turn may auto-end normally. RunManager holds the
  exact current session across accepted worker waits and the admitted wake's
  reply turn and pending delivery acknowledgement, including nonfinal agent steps. Explicit end/interrupt and provider
  failures keep their existing semantics; a timer is never termination proof.
- `onAgentInputReady?: () => void` — optional in-process retry hint, NOT delivery
  acknowledgement or completion. Only a successful late reply/prompt at an idle,
  open session with no queued human prompt emits it. The manager checks current session identity, pending asks,
  lifecycle and reentrant/duplicate drains; stale/disposed sessions are ignored.
- `onUiEvent?: (e: UiEvent) => void` — the **v2 channel**. It receives the
  normalized `UiEvent` stream emitted alongside the v1 `AgentEvent`s passed to
  `onEvent`. A runner that omits `onUiEvent` support degrades to v1-only — but a
  first-class backend MUST wire it (see §8).

### `AgentRunSpec`

The input to a run. Backend-agnostic; each runner translates it to its transport.
Notable fields (full doc-comments in the source):

- `userPrompt` (required), `systemPrompt?`, `images?` (first-message content
  blocks — pasted screenshots), `cwd` (the run dir and the only writable root),
  `model?`, `timeoutMs?`, `env?` (merged over `process.env` — carries
  `CEZ_HANDOFF_FILE` / `CEZ_TODOS_FILE` / `CEZ_TASK_ID`).
- `allowedTools?` / `bashAllowlist?` / `additionalDirectories?` — tool access.
  **Caveat (#430):** the zero-config default (`DEFAULT_ALLOWED_TOOLS`) includes
  unrestricted `Bash`, and Codex/OpenCode do not honor `allowedTools` at all.
  Treat the default `auto` permission mode as full shell access, not a
  sandbox: Codex uses `danger-full-access` with `approvalPolicy: never`, and
  OpenCode auto-approves every permission. Configurable restrictive modes are
  specified by `2026-07-17-permission-modes` (#475).
- `restrictNativeDelegation?` — optional per-invocation intent, mapped only inside
  adapters; absent preserves ordinary settings. Governed session provisioning
  supplies it on initial steps, Continue and recovery. See D1 below for precise
  controls and exemptions; this is not a shell sandbox.
- `sessionId?` / `resume?` — stable session id for interactive takeover and for
  `--resume` ("Continue" after a run ends).

**System prompt channel** — a backend without a dedicated system-prompt input
must deliver `spec.systemPrompt` as a leading block of the opening user message.
Use the shared helper so the mapping is uniform:

```ts
prependSystemPrompt(spec.systemPrompt, spec.userPrompt)
// claude:          --append-system-prompt   (native channel, do NOT prepend)
// codex / opencode: prepended here
```

`ContentBlock` mirrors the Anthropic wire format (`text` | `image` base64) so it
can be written to the claude CLI's stdin verbatim.

---

## 2. v1 `AgentEvent` — the flat stream

The original normalized stream. Still emitted by every runner, still persisted,
still rendered by `cezar run`. **Do not remove or rename a variant** — v1 event
`type` strings are part of the on-disk NDJSON format.

```ts
type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: string; tool: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; result: string; isError: boolean }
  | { type: 'image'; mediaType: string; data: string }        // base64; run manager re-emits a URL
  | { type: 'token-usage'; tokensUsed: number }
  | { type: 'cost'; usd: number }
  | { type: 'session'; sessionId: string }                    // backend's real session id, once known
  | { type: 'turn-end' }
  | { type: 'note'; message: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
```

Every v1 event stays **derivable** from the v2 stream, so a consumer can migrate
one panel at a time. New work should read v2; v1 exists for the console renderer
and old recordings.

### Cezar-owned run metadata events

`provider-auth-required` is not emitted by a backend runner. The server derives it
from an authoritative v1/v2 authentication error, persists a provider id, opaque
incident id, and optional `stepId`, and the cockpit renders recovery guidance. It
does not change backend parity or expose the raw error.

---

## 3. v2 `UiEvent` — the normalized protocol (`packages/cezar/src/core/ui-events.ts`)

Pure vocabulary: no runtime imports, no runner coupling. Mirrored into the
api-client package at `packages/api-client/src/protocol/ui-events.ts`; the mirror is **checked**,
not trusted — `packages/cezar/src/server/api-types.test.ts` asserts type-exactness between the
two, so drift fails `npm run typecheck` (the gate) rather than the UI at runtime.

### Design rules baked in

1. **Item-lifecycle model** (Codex/ACP style): one stable `id` per item with
   `started → delta → updated → completed` phases. Two of the three backends are
   natively item-shaped; claude maps trivially.
2. **ACP vocabulary** wherever a choice is arbitrary (tool status/kind, plan
   entries, diff shape, stop reasons) — ecosystem alignment.
3. **Per-capability degradation, never per-backend** — see §6.

### The item model (one id-keyed stream for text, reasoning and tools)

```ts
type UiItem = UiMessageItem | UiReasoningItem | UiToolItem;
```

- `UiMessageItem` — `kind:'message'`, `role`, `text`, `phase?:'commentary'|'final'`.
- `UiReasoningItem` — `kind:'reasoning'`, `text` (extended thinking / reasoning summary).
- `UiToolItem` — `kind:'tool'`, `name` (backend tool name), `toolKind`, `title`
  (human line computed once — see §5), `status`, `input?`, `output?`, `error?`,
  `diffs?: FileDiff[]`, `locations?`, `exitCode?`, `parentItemId?`.

`parentItemId` nests subagent work under the tool item that spawned it (claude
`parent_tool_use_id`, opencode `subtask` parts, Codex collaboration receiver
thread ids).

### Enumerations

```ts
type ToolStatus = 'pending' | 'running' | 'completed' | 'failed' | 'declined';
type ToolKind   = 'read'|'edit'|'delete'|'move'|'search'|'execute'|'think'|'fetch'|'task'|'plan'|'other';
type StopReason = 'end_turn'|'max_tokens'|'refusal'|'cancelled'|'timeout'|'error';
type PlanStatus = 'pending' | 'in_progress' | 'completed';
```

Supporting shapes: `PlanEntry` (`content`, `status`, `priority?`, `activeForm?`),
`TokenUsage` (raw `input`/`output`/`cacheRead?`/`cacheWrite?`/`reasoning?`/`total`,
`contextWindow?` — **never pre-weighted**; cost weighting is a presentation
concern), `FileDiff` (`path`, `oldText: string|null` where `null` = newly
created, `newText?`, `unified?`), `ToolLocation`, and the reserved
`PermissionOption`/`PermissionOptionKind`.

### The events

```ts
type UiEvent =
  | UiSessionStartedEvent    // 'session.started'  — sessionId, backend, model?, cwd?, tools?
  | UiSessionEndedEvent      // 'session.ended'    — reason: StopReason (replaces v1 done / fatal error)
  | UiSessionErrorEvent      // 'session.error'    — message, fatal (v1 note + error unified)
  | UiTurnStartedEvent       // 'turn.started'     — turnId
  | UiTurnCompletedEvent     // 'turn.completed'   — turnId, stopReason, usage?, costUsd?
  | UiItemStartedEvent       // 'item.started'     — item (tools usually pending/running)
  | UiItemDeltaEvent         // 'item.delta'       — itemId, field:'text'|'reasoning'|'output', delta
  | UiItemUpdatedEvent       // 'item.updated'     — item (status flips, streamed snapshots)
  | UiItemCompletedEvent     // 'item.completed'   — item (final snapshot, safe to persist)
  | UiPlanUpdatedEvent       // 'plan.updated'     — entries: PlanEntry[] (FULL replacement, ACP semantics)
  | UiPermissionRequestedEvent  // 'permission.requested' — RESERVED (types only; wired when approvals become optional)
  | UiPermissionResolvedEvent   // 'permission.resolved'  — RESERVED
  | UiAskRequestedEvent      // 'ask.requested'    — requestId, questions[] (AskUser; the cockpit renders option chips)
  | UiUsageUpdatedEvent      // 'usage.updated'    — usage: TokenUsage, costUsd? (cumulative-for-session)
  | UiImageEvent;            // 'image'            — itemId?, mediaType, data (base64; manager re-emits URL)
```

**AskUser (`ask.requested`, #473, #565).** The portable path remains
backend-neutral: the agent asks a structured
multiple-choice question by ending a turn with a `CEZ:ASK <json>` control marker
(a sibling of `CEZ:DONE` / `CEZ:MONITORING`); the RunManager detects it on the
*assembled* turn text — uniform across claude, codex and opencode with no mapper
work — validates the payload (`packages/cezar/src/core/ask.ts`, modeled on Claude Code's
`AskUserQuestion`: 1–4 questions, 2–4 options each, `header` ≤12 chars), emits
  `ask.requested` and parks the run `waiting`. A mid-turn `sendMessage` that a
  backend queued until idle is dropped (`AgentSession.discardQueuedMessages`) so
  that waiter cannot start a new turn after the question. The cockpit renders clickable option
chips; the user's pick (or a free-form reply) rides the normal reply seam
(`POST /api/runs/:id/messages`), and the card resolves client-side when that
message lands (no `ask.resolved` event). Codex additionally bridges its native
`item/tool/requestUserInput` server request onto the same event and routes the
next answer back as the documented JSON-RPC response. Malformed or unsupported
Codex native requests receive an error response rather than hanging the turn.
OpenCode likewise bridges its native `question` tool: the runner discovers the
main session's pending request through `GET /question`, emits `ask.requested`,
and routes the next answer to `POST /question/:id/reply`; malformed question
input emits no ask card and is rejected through `POST /question/:id/reject` so
the native turn cannot remain blocked. If the pending request cannot be found,
the runner terminates the turn instead of hanging. A malformed marker degrades
to plain text — the prose fallback is never made worse. A native `AskUserQuestion`
control-protocol bridge for claude (the `control_request can_use_tool` path) is a
possible future enhancement; the marker is the portable baseline.

`item.completed` carries **snapshots**, not deltas — safe to persist. `item.delta`
carries **appends** to one field of a live item and must not be persisted as a
standalone truth.

---

## 4. Per-backend mapping (summary)

Each backend has a mapper (`packages/cezar/src/core/<backend>-ui-mapper.ts`) turning its wire
transport into `UiEvent`s. The authoritative table is
`agent-event-protocols.md` §7.1; the load-bearing rows:

| v2 event / field | claude (stream-json) | codex (app-server JSON-RPC) | opencode (serve HTTP+SSE) |
|---|---|---|---|
| `session.started` | `system/init` (model, tools, cwd) | `thread/started` / `thread/start` result | `POST /session` response |
| `turn.started` | each stdin user message | `turn/started` | each prompt POST |
| `turn.completed` + `stopReason` | `result` subtype (`success→end_turn`, `error_max_turns→max_tokens`, `error_during_execution→error`) | `turn/completed→end_turn` (failed status or provider error → `error`), `turn/failed→error`, interrupt→`cancelled` | `session.idle→end_turn` (or `error` if a `session.error` preceded) |
| message item | `assistant` `text` blocks (deltas via `--include-partial-messages`) | `agentMessage` items | text parts |
| reasoning item | `thinking` blocks | `reasoning` items (+ `textDelta`) | `reasoning` parts |
| tool item | `tool_use`→running, `tool_result`→completed/failed, `permission_denials`→`declined` | `commandExecution`→execute (+`exitCode`, `outputDelta`), `fileChange`→edit (`diffs`), `mcpToolCall`→other, `webSearch`→fetch, collaboration spawn→task | tool parts (state `pending/running/completed/error→failed`, `patch` parts→`diffs`) |
| `item.delta` `output` (live terminal) | *(none — card fills on completion; per-capability degradation)* | `item/commandExecution/outputDelta` | running-state metadata |
| `plan.updated` | `TodoWrite` input | `todoList` / `plan` items | `todowrite` tool |
| `ask.requested` | portable `CEZ:ASK` marker | portable marker + native `item/tool/requestUserInput` | portable marker + native `question` tool (`GET /question`, `POST /question/:id/reply`) |
| subagent nesting (`parentItemId`) | `parent_tool_use_id` | collaboration receiver thread id (review mode remains childless) | child-session parts under a `subtask` |
| `usage.updated` | `result.usage` + `total_cost_usd` | `thread/tokenUsage/updated` (no USD) | `message.updated` tokens/cost + `step-finish` |

**Mapper robustness contract.** Inputs come off the wire and may be `null`,
partial or malformed. A mapper **must never throw**: unparseable NDJSON lines are
skipped (`packages/cezar/src/core/ndjson.ts` + the mapper), unknown message/content types
produce **no events**, and malformed entries in a `plan.updated` payload are
filtered out (a non-array plan emits no plan event at all). Mapper state is
**explicit and immutable** — each mapper's map function takes `(frame, state)`
and returns `{ events, state }`, never mutating the passed-in state
(`mapClaudeMessage` / `mapCodexNotification` / `mapOpencodeEvent`, each paired
with a `create<Backend>UiState`; see the claude mapper's "state carries across
messages" tests).

---

## 5. The tool display model (`packages/cezar/src/core/tool-display.ts`)

`toolDisplay(name, input)` turns a backend tool name + raw input into
`{ toolKind, title, subtitle? }`, computed **once** in the protocol layer (never
in components) so the thread, activity groups and notifications all say the same
thing. It is a pure function over untrusted input and **must never throw**. Tool
names are matched case-insensitively, so claude's `Bash` and opencode's `bash`
share one row; unknown tools keep the backend's name as the title with a
heuristic subtitle. `mcp__server__tool` names collapse to `server.tool`.

---

## 6. Backend parity — the hard rule (`packages/cezar/src/core/ui-parity.test.ts`)

> Every capability in the parity matrix MUST be emitted by **every**
> backend, so the GUI degrades **per-capability, never per-backend**.

This is made executable: `ui-parity.test.ts` asserts each capability over each
backend's golden-fixture expected output. If a mapper change drops a capability —
or a new fixture set forgets one — a named row fails. The matrix:

- `plan.updated` with entries (TodoWrite / todoList / todowrite)
- tool status `running`, `completed`, `failed`
- reasoning items (thinking / reasoning items / reasoning parts)
- structured diffs (Edit input / fileChange.changes / patch parts)
- sub-agent task items (Task / review-mode span / subtask parts) — one item per
  sub-agent: codex's `enteredReviewMode`/`exitedReviewMode` pair folds into a
  single `task` item with a running→completed lifecycle, so a consumer counting
  task items counts agents, not frames (spec
  `.ai/specs/2026-07-20-grouped-subagent-display.md`, #474)
- `usage.updated` with raw token counts
- `turn.completed` with a `stopReason`
- sub-agent **nesting** via `parentItemId` where the upstream wire attributes
  child work to a parent

A new backend is not "done" until it produces every row.

That covers what a mapper EMITS. The other half of the same requirement — what a
runner DOES — is §7, and a new backend has to satisfy both.

## 7. Harness parity — session and lifecycle (`packages/cezar/src/core/harness-parity.test.ts`)

> Every criterion in the harness parity matrix MUST hold for **every** backend,
> or carry a declared exemption naming the wire limitation that prevents it.

§6 pins what a mapper emits. This pins the rest of the contract in
`agent-runner.ts`: session lifecycle, provider-failure surfacing, `sendMessage`,
ask routing and park declarations. It exists because nine fixes (#2, #3, #4, #5,
#6, #46, #48, #53, #54) each repaired a failure mode on ONE backend that no
shared contract covered, so the same class of bug shipped again on the next one.

**Two tiers.** The seam tier drives each real runner class against that
backend's own offline mock and asserts over the v1 and v2 streams plus the
settled result. The run tier drives a real `RunManager` run in a temp git repo.
The second tier is not redundant: `ask.requested` is emitted by the RUNNER for
codex and opencode (`codex-app-server-runner.ts`, `opencode-server-runner.ts`)
and by `workflows/run.ts` for claude and pi, and whether a provider failure
fails the run or parks it is decided in the orchestrator either way. Provider
failures, asks and park declarations are only uniform above the seam.

**Shared scenario names, per-backend spellings.** Every mock is already driven by
`mock:<scenario>` markers found in the prompt text. The matrix names a scenario
once and `HARNESS_ADAPTERS` maps that name onto whatever a backend already calls
it, so no existing marker is renamed. A new runner declares its own map:

| Scenario | The mock must |
| --- | --- |
| `baseline` | one text, one tool call and result, usage, then its terminal turn signal |
| `done` | the same, with a trailing `CEZ:DONE` so the run reaches its review gate |
| `hold` | acknowledge the prompt, then pause before the content AND the terminal signal |
| `split-text` | stream the reply in pieces, ending with a trailing `CEZ:MONITORING` |
| `provider-error` | a runtime provider rejection in its own native error shape |
| `ask` | an ask — native where the wire has one, a `CEZ:ASK` marker otherwise |
| `ask-bad` | a malformed ask, and then still end the turn |
| `ask-reply-late` | the same ask, with OpenCode SSE idle preceding the independent reply HTTP acknowledgement |
| `subagent` | child work and a child terminal signal the parent survives, then parent `CEZ:MONITORING` text followed by child text before parent turn-end |

S9 also pins parent-only v1/result text while child messages remain nested on v2.
R12 asserts the `subagent` turn parks as `running`/`monitoring`, never `waiting`
(#149). Pi is explicitly exempt from S9 and R12 because its RPC has no child
session transcript. Codex filters both child message deltas and completions;
Claude excludes child assistant text from v1 and its result fallback buffer;
the v2 fallback uses the same parent-only guard.

Owned-input rows S11/S12 pin ask separation and false/retry/closed-session delivery
on all four real runners. R6–R11 exercise durable queued/startup input, before/during/
after asks, restart with an unanswered ask, continuation asks, delayed native replies,
DONE/explicit-stop precedence and post-send checkpoint failure. Echo probes use the
same documented assistant/item and terminal frames as each mock's baseline, with
unique item IDs across turns; no new vendor wire event is invented.

New scenarios are **wire-faithful** on the same terms as the golden fixtures
(§8): derive the shape from that backend's real transcripts and cite the source.
A scenario invented from assumption is #443 repeating inside the suite meant to
prevent it.

**Exemptions are data the suite validates, never an `it.skip`.** An entry in
`PARITY_EXEMPTIONS` carries a reason describing the WIRE limitation — "not
implemented yet" is a failing row, and the fix is the runner. Each entry has a
kind, because the two cases cannot be pinned the same way:

- `capability-absent` — the scenario is constructible, the backend just does not
  produce the signal. Pinned by an **inverted** assertion: the criterion must not
  hold, so a backend that later gains it fails its own exemption.
- `scenario-unconstructible` — the wire cannot create the situation at all, so
  there is nothing to invert (an unrelated baseline turn would satisfy some
  criteria by accident). Pinned by requiring the adapter to declare **no** prompt
  for that scenario, so the day a mock answers it the exemption fails and the row
  has to go live.

Guard tests assert every `(criterion, backend)` pair is a live row or an
exemption, that a kind agrees with whether a prompt is declared, and that the
file contains no skipped cell. A new id in `RUNNER_IDS` therefore fails the suite
until every row is addressed.

**The matrix is a debugging tool, not only a gate.** Every row names the issue
whose failure mode it pins, and each was verified red by reintroducing that
defect. A red row is first evidence of a real bug, not of a bad assertion:
authoring this matrix is what found the claude half of group 1, where an
`is_error` result whose subtype is still `success` reported an auth failure to
the cockpit as a clean end of turn.

---

### Governed delegation controls (D1)

D1 inspects real runner argv, JSON-RPC and HTTP boundaries on ordinary versus
restricted start/Continue launches. These controls add no tool grants and write
no global harness configuration. Per-backend knowledge remains inside adapters.
`provision-workflows.test.ts` covers every backend's initial, nonfinal, Continue,
recovery and disabled paths, plus mixed-backend workers retaining their own
accepted identity, empty grants and distinct per-session delegation credentials.

| Backend (locally verified version) | Per-invocation control | Evidence and limitation |
| --- | --- | --- |
| Claude Code 2.1.260 | `--disallowedTools Agent,Task` | `claude --help` documents the deny flag; installed `sdk-tools.d.ts` names `AgentInput`. `Task` covers the legacy name in recorded fixtures. Other tools and permission modes are preserved. |
| Codex 0.153.4 | `thread/start` and `thread/resume` `config: { "features.multi_agent": false, "features.multi_agent_v2": false }` | `codex features list` names both flags; `codex --help` documents dotted config overrides; `codex app-server generate-json-schema` confirms both request config fields. Existing sandbox, approval, account and model settings remain unchanged. |
| OpenCode 1.18.29 | `POST /session` `permission: [{ permission: "task", pattern: "*", action: "deny" }]` | Installed server `/doc` declares `PermissionRuleset`; its embedded `TaskTool.execute` checks `task`. Later prompt requests contain no `tools` map that would replace session rules. The current adapter creates a fresh session on Continue, so the deny applies there too. It still does not map general `allowedTools`. |
| pi 0.85.1 | `--exclude-tools subagent` | Installed `pi --help` applies exclusions to built-in/extension/custom names; the shipped `examples/extensions/subagent/index.ts` registers `subagent`. Other extension discovery and ordinary tool settings remain unchanged. |

**Explicit D1 pi exemption:** pi's RPC has no native delegation primitive or
capability identifying arbitrary custom delegation extensions. Only the verified
`subagent` entry point is excluded. Renamed/custom extensions remain outside that
restriction; D1 pins the exact exclusion and preserves unrelated extension/tool
settings. Guidance directs agents to cezar workers but must never be represented
as enforcement of this unsupported capability. Custom tools on other backends
and unrestricted same-user shell likewise remain outside hard isolation. Native
workers are not cezar-owned, collected, waited on or cleaned up by this protocol.
Older harness versions are not attested by this versioned capability check.

Provisioning supplies the bundled absolute CLI invocation and fresh environment
credentials for both parent and worker sessions; it never copies the parent's
credential to a worker. With delegation disabled/unavailable, the intent is absent
and ordinary execution keeps its prior settings. Start/Continue/recovery share the
same provisioner, including nonfinal workflow steps.

The governed command protocol is documented with runnable forms in [README](README.md#owned-workers-opt-in).
Spawn supports selected context (`--context` or UTF-8 `--context-file`) and backend/
model selection; omitted backend follows the active parent, same-backend omitted
model/account/effort inherit, and mixed-backend defaults resolve independently.
Inspect reports materialized input paths. Wait defaults to `any`; `one` requires
one worker and `all` every selected worker. All waits have finite 1–1800 second
deadlines (600 default), return immediately, and release capacity at turn end.
`cancel-wait <wait-id>` cancels only waiting, preserving worker work.

`collect <worker-id>` returns typed availability and persists the latest execution
revision's summary, HEAD, bounded diff and artifact descriptors under the parent.
An available `diff.path` names a JSON `{ result, diffSnapshot }` document, **not a
raw patch**. Latest settled collection is required for parent readiness; running
or obsolete collected output cannot satisfy it. Collection is observation, not
integration. Automatic completion wakes for inspection/collection without silently
accepting review; timeout/repeated premature completion retains attention. Human
Finish refuses unmet readiness. Continue a reviewing parent before its worker.

Review and deliberately integrate desired worker commits with Git before cleanup.
Collect/integrate, destroy owned resources, explicitly delete child histories, then
delete the parent. Summary and bounded diff snapshots survive child deletion until
parent deletion; general artifacts are not archived. Removed paths, branch names
and historical SHAs do not promise live resources. A worker's pending human ask is
never answered by lifecycle input, and no automatic merge/review acceptance exists.

---

## 8. The golden-fixture testing contract

Each backend has, under `packages/cezar/src/core/__fixtures__/<backend>/`:

- `<name>.ndjson` — a **wire-faithful** transcript of the backend's real output
  (shapes from `agent-event-protocols.md`, cross-checked against the backend's
  actual CLI / the dry-run mock, e.g. `packages/cezar/scripts/mock-claude.mjs`).
- `<name>.expected.json` — the **exact** `UiEvent[]` the mapper must produce for
  that transcript.

`<backend>-ui-mapper.test.ts` replays each fixture **exactly as the runner drives
the mapper** (seed turn started before the first line; malformed lines skipped),
round-trips the result through JSON (so a stray `undefined` fails loudly, since
these events get persisted as NDJSON), and asserts `toStrictEqual` against the
`.expected.json`. The same `.expected.json` files feed the parity test in §6.

> Verify fixtures against **upstream wire shapes**, never against your own
> assumptions. PR #443's root cause was a fixture that encoded an *assumed*
> codex shape (`todoList` items that the app-server never emits), which hid a bug
> where a codex plan never rendered at all. When adding a fixture, cite the
> upstream schema/source it was derived from, as #443 did.

## 9. Persistence & transport

- **NDJSON** — one append-only `runs/<id>.ndjson` per run, one JSON object per
  line (`seq`, `ts`, `type`, free extra keys). Never rewrite, reorder or
  re-number; readers skip bad lines. Both v1 and v2 events live here; a mixed
  file is valid. Cezar-owned task events are additive too: for example,
  `provider-auth-required` records only `{ provider, authFailureId, stepId? }`
  when a runtime rejection needs user authorization; it never carries vendor
  error text or credentials.
- **SSE** — the server replays from NDJSON then streams live, deduped by `seq`.
  Event names: `run-event` (v1) and `ui-event` (v2 dotted types). These names are
  a protected contract (see `BACKWARD_COMPATIBILITY.md` §2).

---

## 10. Adding a new runner (the #387 `pi` checklist)

A new backend is a **single class behind the seam** plus its mapper, fixtures and
its rows in **both** parity matrices — never backend-specific types leaking past
`packages/cezar/src/core/`. PR #387 added `pi` and enumerated every place the
runner union was duplicated; that list is the concrete map, and the union now
derives from one `RUNNER_IDS` tuple in `agent-runner.ts` so most of it is
typecheck-enforced rather than hand-tracked.

To be first-class:

1. **Runner** — `packages/cezar/src/core/pi-runner.ts` implementing `AgentRunner` /
    `AgentSession` (persistent process; `pid`; `sendMessage`/`discardQueuedMessages`/`end`/`interrupt`;
   `result`). Honor `AgentRunSpec` uniformly — use `prependSystemPrompt` if the
   backend has no native system-prompt channel.
2. **Factory** — add the id to `RunnerId` / `RUNNER_IDS` (`agent-runner.ts`) and
   a `case` in `createRunner` (`runner-factory.ts`). Add `UiBackend` in
   `ui-events.ts` **and its mirror** `packages/api-client/src/protocol/ui-events.ts` (the
   type-exactness test guards drift).
3. **Detection** — a `probePi()` in `backend-detect.ts` plus the `BackendCheck`
   name union; degrade gracefully when the CLI is absent (never fail boot). If it
   needs a binary override, add `CEZ_PI_BIN` — and per AGENTS.md's zero-config
   rule, document any new `CEZ_*` var in `.env.example` in the same commit.
4. **Mapper** — `packages/cezar/src/core/<runner>-ui-mapper.ts` emitting the full
   v2 `UiEvent` stream **alongside** v1. Never throw on malformed input; explicit
   immutable state.
5. **v1 alongside v2** — wire `SessionOptions.onUiEvent`; keep the v1
   `AgentEvent` stream flowing unchanged.
6. **Golden fixtures** — `packages/cezar/src/core/__fixtures__/<runner>/*.ndjson` +
   `*.expected.json`, wire-faithful and citing their upstream source, covering
   **every** parity matrix capability (§6), and a `<runner>-ui-mapper.test.ts`
   replaying them.
7. **Parity** — add the id to `BACKENDS` in `ui-parity.test.ts`; every capability
   row must pass. (If the backend has no wire parent attribution, document the
   nesting cell's substitute the way codex's review-mode items are handled.)
8. **Harness parity** — add the runner to `HARNESS_ADAPTERS`
   (`packages/cezar/src/core/harness-parity.testkit.ts`): the env var that points it at an
   offline mock, and a prompt for every name in the shared scenario catalog (§7). Then make
   that mock answer them, in the backend's own wire shape. **Every matrix row must pass** —
   the guard tests fail the suite until each `(criterion, runner)` cell is a live row or a
   declared `PARITY_EXEMPTIONS` entry naming the wire limitation. Never an `it.skip`, and
   never "not implemented yet".
9. **Plumbing** — the run-store `runner` enum, workflow step schema, the
   `POST /api/runs` / `PUT /api/config` bodies, `resumeCommand()`, the web
   `Runner` type, composer pills/presets, and Settings → Agents. Keep additive
   so old `runs.json` records still parse (the `runner` enum keeps `claude-cli`
   parseable — follow that precedent).
10. **Model selection** — accept `provider/model` where relevant; #387 documents
   the existing inconsistencies (opencode drops a bare model silently) — do not
   reproduce a silent-drop. A backend with no default provider gets no entry in
   `BACKEND_MODEL_MAP`'s default column, so a bare id fails loud.
11. **Credentials** — one entry in `BACKEND_ALLOW_PREFIXES` (`agent-env.ts`):
   `buildChildEnv` is least-privilege per backend, so a multi-provider runner
   must receive credentials for every provider its own model ids can name
   without widening other backends.

## 11. The plan channel (PR #443)

PR #443 (`fix/issue-433-render-plan-todo`, open at the time of writing) hardens
`plan.updated` across all three backends after finding the plan never reached the
cockpit dock — for a different reason on each backend. Its direction, which any
new runner should follow:

- **Claude** — current-session plans use `TaskCreate` / `TaskUpdate` / `TaskList`
  (not only `TodoWrite`); classify all of them as plan tools and fold them into
  a snapshot keyed by the task id the harness reports in each tool's **result**.
- **Codex** — the real plan channel is the turn-level notification
  `turn/plan/updated`, not a `todoList` item (which the app-server never emits);
  map it to `plan.updated` as a full replacement.
- **OpenCode** — `status` is free-form upstream; `cancelled` is a documented
  value. Don't whitelist a few statuses and silently drop the rest — an
  unrecognized status degrades to `pending` so a todo the agent wrote stays on
  screen.
- **General** — `plan.updated` is full-replacement; only a genuinely empty list
  clears the dock (a malformed frame maps to zero events, never a wipe).

The `plan.updated` **event name and payload structure are unchanged**; #443
extends the *handling*, not the wire shape (on `main`, `PlanStatus` is the three
values in §3).

---

## Compatibility

The agent event protocol is a protected surface: see `BACKWARD_COMPATIBILITY.md`
§7. In short — v1 `AgentEvent` `type` strings and v2 `UiEvent` dotted types are
additive-only; removing/renaming one, or breaking the parity requirement, is a
breaking change requiring the documented deprecation path.

## Related documents

- `.ai/specs/2026-09-04-harness-parity-matrix.md` — the harness parity matrix's design record (§7).
- `AGENTS.md` — repo working rules; the "Agent runners / backends" routing row.
- `BACKWARD_COMPATIBILITY.md` — §7 (this protocol) and §2/§3 (SSE names, NDJSON).
- `.ai/analysis/cockpit-ui-redesign/agent-event-protocols.md` — the deep design record (§7, §7.1).
- `.ai/specs/2026-07-14-cockpit-ui-redesign.md` — the spec (protocol v2, parity requirement).

### Bounded structured-question recovery (#88)

A CEZ:ASK payload missing only closing braces/brackets after a complete structural value gets one bounded repair, then the existing schema validation. Mid-string truncation, mismatched delimiters and invalid question structures remain rejected. Fresh and continuation turns persist a danger note for recovery or rejection; a recovered card warns users to check the options and how many they may pick, since repair cannot restore missing meaning. The raw recovered marker stays in the audit stream until the cockpit hides it alongside a validated card, preserving rejected split-stream fallback. Existing and unknown note tones stay dim. DONE/ASK precedence, Claude wakeups and monitoring serialization are unchanged.

Harness row S13 verifies the late auto-end veto and subsequent reply completion against all four real offline runner wires.
