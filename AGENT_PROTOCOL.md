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
  | { type: 'turn-end'; unconsumedInputIds?: readonly string[] } // hearsay-tools/cezarion#505
  | { type: 'input-unconsumed'; inputIds: readonly string[] }    // hearsay-tools/cezarion#505: out-of-turn unread report
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
   `started → delta → updated → completed` phases. Codex and OpenCode are
   natively item-shaped; Claude maps trivially. Every `RUNNER_IDS` backend implements
   this lifecycle through its mapper.
2. **ACP vocabulary** wherever a choice is arbitrary (tool status/kind, plan
   entries, diff shape, stop reasons) — ecosystem alignment.
3. **Per-capability degradation, never per-backend** — see §6.

### The item model (one id-keyed stream for text, reasoning, tools and hooks)

```ts
type UiItem = UiMessageItem | UiReasoningItem | UiToolItem | UiHookItem;
```

- `UiMessageItem` — `kind:'message'`, `role`, `text`, `phase?:'commentary'|'final'`.
- `UiReasoningItem` — `kind:'reasoning'`, `text` (extended thinking / reasoning summary).
- `UiToolItem` — `kind:'tool'`, `name` (backend tool name), `toolKind`, `title`
  (human line computed once — see §5), `status`, `input?`, `output?`, `error?`,
  `diffs?: FileDiff[]`, `locations?`, `exitCode?`, `parentItemId?`.
- `UiHookItem` — `kind:'hook'` (hearsay-tools/cezarion#961), one native hook run:
  `event` (PascalCase: `SessionStart`, `PreToolUse`, `Stop`), `name?` (native label
  when richer, `PreToolUse:Bash`), `source?` (hook definition path), `status`
  (`completed|failed|blocked|cancelled`), `entries: {kind, text}[]` (what the agent
  received: `context|feedback|warning|error|stop`), raw `stdout?`/`stderr?`,
  `exitCode?`, `durationMs?`, `parentItemId?`. Emitted **once**, as `item.completed`,
  and only when visible: `status !== 'completed'` or `entries` is non-empty
  (`hook-items.ts` `isVisibleHookItem`). A silent successful hook, or one printing
  only control JSON (`{"continue":true}`), is never emitted. Hook items are v2-only
  and never touch run state: no turn, park, wake, Needs You, ask or completion path
  reads them.

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
  | UiPermissionRequestedEvent  // 'permission.requested' — native approval choices
  | UiPermissionResolvedEvent   // 'permission.resolved' — human decision or expiry
  | UiAskRequestedEvent      // 'ask.requested'    — requestId, questions[] (AskUser; the cockpit renders option chips)
  | UiUsageUpdatedEvent      // 'usage.updated'    — usage: TokenUsage, costUsd? (cumulative-for-session)
  | UiImageEvent;            // 'image'            — itemId?, mediaType, data (base64; manager re-emits URL)
```

**AskUser (`ask.requested`, open-mercato/cezar#473, open-mercato/cezar#565).** The portable path is
backend-neutral: the agent asks a structured question with the `cezar_ask` tool
(hearsay-tools/cezarion#1234), which every runner in `RUNNER_IDS` reaches over the same
private MCP wire. Cezar validates the card (`askRequestSchema`, modeled on Claude Code's
`AskUserQuestion`: 1–4 questions, 2–4 options each, `header` ≤12 chars), and at the
turn end emits `ask.requested` and parks the run `waiting`. The `CEZ:ASK <json>` line
that once did this is no longer read (hearsay-tools/cezarion#2397); saved transcripts that
carry it stay readable. A mid-turn `sendMessage` that a
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
the runner terminates the turn instead of hanging. A native `AskUserQuestion`
control-protocol bridge for claude (the `control_request can_use_tool` path) is a
possible future enhancement; `cezar_ask` is the portable baseline.

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
| `turn.started` | each stdin user message that opens a turn; after a `result` with no line queued, the first parent `assistant` frame (Claude resumed the parent itself, hearsay-tools/cezarion#1512) | `turn/started` | each prompt POST |
| `turn.completed` + `stopReason` | `result` subtype (`success→end_turn`, `error_max_turns→max_tokens`, `error_during_execution→error`) | `turn/completed→end_turn` (failed status or provider error → `error`), `turn/failed→error`, interrupt→`cancelled` | `session.idle→end_turn` (or `error` if a failure `session.error` preceded) |
| message item | `assistant` `text` blocks (deltas via `--include-partial-messages`) | `agentMessage` items | text parts |
| reasoning item | `thinking` blocks | `reasoning` items (+ `textDelta`) | `reasoning` parts |
| tool item | `tool_use`→running, `tool_result`→completed/failed, `permission_denials`→`declined` | `commandExecution`→execute (+`exitCode`, `outputDelta`), `fileChange`→edit (`diffs`), `mcpToolCall`→other, `webSearch`→fetch, collaboration spawn→task | tool parts (state `pending/running/completed/error→failed`, `patch` parts→`diffs`) |
| `item.delta` `output` (live terminal) | *(none — card fills on completion; per-capability degradation)* | `item/commandExecution/outputDelta` | running-state metadata |
| `plan.updated` | `TodoWrite` input | `todoList` / `plan` items | `todowrite` tool |
| `ask.requested` | portable `cezar_ask` tool | `cezar_ask` + native `item/tool/requestUserInput` | `cezar_ask` + native `question` tool (`GET /question`, `POST /question/:id/reply`) |
| hook item | `system/hook_response` (`--include-hook-events` when `--help` lists it; without it only SessionStart/Setup). Entries parsed from JSON stdout: `additionalContext`→context, `systemMessage`→warning, block `reason`/`stopReason`/deny `permissionDecisionReason`→stop, ask reason→feedback; plain stdout→context. Stdout yields entries on exit 0 only (Claude ignores it otherwise; it stays raw output). Exit 2, `decision:block`, `continue:false`, deny→`blocked` | `hook/completed` (`run.entries` verbatim, `sourcePath`→`source`, `stopped`→`cancelled`) | *(none — plugin hooks run in-process)* |
| subagent nesting (`parentItemId`) | `parent_tool_use_id` | collaboration receiver thread id (review mode remains childless) | child-session parts under a `subtask` |
| background child (`background`, hearsay-tools/cezarion#2431) | `task_started.is_backgrounded` or `async_launched` result → running; `task_notification` → completed / failed / declined | `subAgentActivity(kind: started)` → running; parent-thread `subAgentActivity(kind: completed)` → completed | *(none — the parent settles after its children)* |
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

<a id="cursor-acp-264"></a>

### Cursor print (hearsay-tools/cezarion#590)

`CursorRunner` selects print for new sessions only after the installed binary
passes a pre-inference check (hearsay-tools/cezarion#1257): its version is a
dated build from `2026.10.01-e373342` or newer, it rejects an invalid native
tool with its `Expected one of:` catalog, and that catalog still lists the core
print tools (`CORE_CURSOR_PRINT_TOOLS`). Every Cursor process cezar starts
passes the hidden `--disable-auto-update` option, so a session never updates
the CLI under itself; a build that rejects the option runs without it. Each
turn launches `agent --disable-auto-update -p --force --trust --output-format
stream-json`; subsequent turns use `--resume` with the exact recorded native
session ID. A mismatch fails the run. Transport identity is persisted with the
native ID and account, so Continue and recovery retain the original transport.
Print is the only Cursor session transport: hearsay-tools/cezarion#1267 removed ACP
sessions. A build that fails the check fails the step before inference with
`Cursor CLI cannot run this task: <reason>`, followed by the fix: run
`agent update`, or update Cezarion when the build is newer than it supports.
A Continue or recovery of a session recorded on `cursor-acp`, or of an untagged
Cursor session from before print existed, fails with an error that says the
session cannot resume, and no Cursor process starts. Run records keep
`sessionTransport: "cursor-acp"` readable. A step that never received a Cursor
session ID has no conversation to lose, so its Continue opens a new print session.

The print invocation supplies the run's Cezar tools through a private temporary
plugin directory and accepts the user's existing Cursor marketplace plugins.
Governed runs pass no `--allowed-tools` list, so native subagent tools stay
callable (hearsay-tools/cezarion#2279; D1). The capability preflight still reads
the build's native tool catalog before every print session, Continue included,
and keeps a build that lacks a core tool off print. `cezar_ask` questions remain
answerable; this Cursor build auto-skips native questions from plugins, which
is a visible limitation. Print mode has no child-session transcript or
qualified token usage. Project-local Claude settings do not reliably disable
a user/team marketplace copy, and Cursor may silently lose history under an
otherwise valid ID; Cezar only verifies the returned ID.

Print model admission retains the canonical IDs discovered by the read-only
`cursor/list_available_models` extension (hearsay-tools/cezarion#987). When a
canonical ID is absent from `--list-models`, preflight reads that owning account's
native parameter keys, values and defaults. Explicit effort becomes a complete
`--model` variant selection, such as `grok-4.6[effort=high,fast=true]` or
`gpt-5.4-mini[reasoning=high]`; partial overrides are not qualified for this build.
Other parameters retain advertised defaults. Unknown models, unsupported effort
and incomplete defaults fail before inference. IDs with embedded parameters retain
those selections in the same bracket group; explicit effort replaces the embedded
effort, and other advertised defaults fill missing parameters. Malformed or
duplicate embedded parameters fail before inference. The validated native selection
is kept for every print turn and revalidated under the pinned account on Continue.
Advertised legacy IDs keep their existing variant-selection path. The discovery
child has a finite startup bound and is terminated when selection is cancelled.

### Cursor model discovery

ACP sessions were removed in hearsay-tools/cezarion#1267, and the earlier ACP runner
(hearsay-tools/cezarion#264) is in git history. One ACP use stays, for discovery only:
`cursor-model-catalog.ts` launches `agent acp`, sends `initialize` with
`_meta.parameterizedModelPicker: true`, and reads the read-only
`cursor/list_available_models` extension. It never sends `session/new`, so no session or
inference starts. The catalog gives the canonical model IDs, parameter keys, values and
defaults that print model admission needs (§ Cursor print); `--list-models` lists only
legacy aliases. Older CLIs without the extension fall back to `--list-models`, without
guessed effort. The discovery child has a finite startup bound and stops when selection
is cancelled.

**Telemetry limitation:** Cursor print emits no token usage: its terminal `result` frame
carries no `usage` or `total_cost_usd`, and print mode suppresses `thinking` events and
child-session transcripts. Cezar reports no invented usage, reasoning or nesting: the UI
matrix rows and harness S4 carry named, inverse-asserted wire-gap exemptions. Other
matrix rows remain required. Revisit these exemptions when Cursor exposes the data.

---

### OMP RPC (hearsay-tools/cezarion#595)

`omp-runner.ts` launches `omp --mode rpc` and holds one persistent JSONL connection, like Pi.
OMP is a Pi fork with its own dialect, so it is a standalone runner, mapper and mock (Pi files
are untouched; pure helpers proven identical to Pi's are copied with a comment naming the Pi
function). Design record: `.ai/specs/2026-10-02-omp-runner.md`, wire contract oh-my-pi
v18.4.11 `docs/rpc.md` and `rpc-types.ts`.

`omp-ui-mapper.ts` is the pure mapper. The load-bearing differences from Pi:

- **No `agent_settled`.** The turn ends at `session_settled`, or at a `prompt_result`
  `agentInvoked: false` (or a `prompt` response carrying it) for the prompt that **opened** the
  turn. `agent_end` is never a boundary: it also fires with `yielded: false` while OMP retries,
  compacts or answers a reminder. A steer OMP completes locally, or that fails after admission,
  does not end the running turn. A `prompt` response with `success: false` (pre-admission, no
  `prompt_result` follows) emits one non-fatal `session.error` and ends the turn only when it
  answers the opening prompt; the mapper remembers the id so a later `prompt_result` does not
  duplicate the error.
- **Result-based diffs and plan.** Edit/write diffs come from the tool **result** `details`
  (`path`, `oldText`, `newText`, `perFileResults[]`; default `edit.mode` is `hashline`, whose args
  are only `{input}`), falling back to replace-mode args. `plan.updated` comes from the `todo`
  result `details.phases[].tasks[]` (`abandoned` is `cancelled`, `blocked` is `pending`).
- **Sub-agents** stream as `subagent_lifecycle` / `subagent_event` after
  `set_subagent_subscription {level: "events"}`. Children nest under their `task` call by
  `parentItemId` and never reach v1 text or end the parent turn (S9). A batch `task` call
  (`args.tasks[]`) becomes one synthetic task item per sub-agent (`<toolCallId>#<id>`) so the
  Agents drawer shows N rows. A child event that arrives before its lifecycle frame is held in a
  bounded buffer (200 frames, 8 ids) and replayed.
- **Ignored frames:** `ready`, `extension_ui_request` (`setWidget` and friends, sent unsolicited
  at startup in plain rpc mode), `advisor_cost_changed`, `available_commands_update`, `queue_update`,
  `auto_*`, `cache_warming_*`. The wire stays on protocol v1; opt in to
  `set_event_filter {messageUpdates: "delta"}` to drop per-delta snapshots.
- **Ask** is the portable `cezar_ask` tool: plain `--mode rpc` never builds OMP's native ask tool.
- Startup writes `get_state`, `set_steering_mode all`, `set_subagent_subscription events`,
  `set_event_filter`, then the first `prompt`. A fresh session's id comes from `get_state`;
  Continue uses `--resume <id>`.

Tools: `--tools` is an allowlist validated against OMP's registry, so cezar maps names onto OMP's
(`TodoWrite` to `todo`; `WebFetch` has no web-only equivalent and is dropped) and drops anything unmapped with one v1 `note`;
`allowedTools: []` is `--no-tools`. The zero-config default adds `todo, lsp, ast_edit, task, wait`
to the cezar defaults. `find` and `ast_grep` are gated behind settings that default off and are
**not** in it: naming an unavailable built-in exits 2. When settings the user chose disable a
named tool, the runner respawns once without exactly those names, keeping accepted input in a
stdin outbox so none is lost. MCP tools: OMP registers `mcp__<server>_<tool>` (one underscore,
lowercased and sanitized), so a Claude-spelled grant `mcp__<server>__<tool>` is translated before
it reaches `--tools`. OMP validates `--tools` right after its 250 ms RPC MCP discovery window, so a
slow server's tool can still read as unknown: the same one-time respawn also drops the `mcp__`
names this spawn passed from an `Unknown tool(s) in --tools: a, b.` refusal, with one v1 `note`
for everything dropped. Any other unknown name stays fatal, and the respawn never widens.

Models: `omp models --json` prints an object, `{"models": [...]}`, which feeds discovery and the
provider status probe (empty means not logged in). Settings, MCP and memory files are edited from
Settings → Agent config, including OMP's YAML config.

Verified on the real binary: `omp/18.4.11` startup frames, the `set_*` acknowledgements,
`omp models --json`, `--tools` refusals and `get_state.dumpTools`. **Not verified live:** no
model turn ran, so turn fixtures and `inputDelivery` are source-derived with citations (the
fixtures README separates observed from constructed lines).

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
  `.ai/specs/2026-07-20-grouped-subagent-display.md`, open-mercato/cezar#474)
- `usage.updated` with raw token counts
- `turn.completed` with a `stopReason`
- sub-agent **nesting** via `parentItemId` where the upstream wire attributes
  child work to a parent
- hook items (`hook_response` / `hook/completed`, hearsay-tools/cezarion#961) — Claude
  and Codex only. OpenCode 1.18.35, Pi 1.0.4, OMP 18.8.0 and Cursor
  2026.10.01-e373342 run hooks in-process or report none, and carry the named
  `NO_HOOK_TELEMETRY` exemption with an inverse assertion
- background sub-agent task items (hearsay-tools/cezarion#2431): a child that
  outlives its spawn call keeps its root `task` item `running` with
  `background: true`, and one `item.completed` (`completed`, `failed`, or
  `declined` for a stopped child) reports its end. Claude marks it from
  `system/task_started` (`is_backgrounded`) or the `async_launched` result and
  ends it on `system/task_notification`; Codex 0.164.0 marks the
  `subAgentActivity(kind: started)` row and ends it on the parent-thread
  `subAgentActivity(kind: completed)`, which carries the turn id of the parent
  turn that already completed. A repeated end maps to nothing, and a nested
  spawn stays passive. OpenCode and OMP settle the parent only after its
  children end, and Pi and Cursor report no child end, so they carry the named
  `NO_BACKGROUND_SUBAGENTS` exemption with an inverse assertion

A new backend must produce every row its wire supports. A genuine upstream gap
requires a named, versioned exemption with an inverse assertion; Cursor token
telemetry above is the first UI-matrix exemption. Missing implementation is never
a wire gap.

That covers what a mapper EMITS. The other half of the same requirement — what a
runner DOES — is §7, and a new backend has to satisfy both.

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
  `workflows/waits-parity-cells.testkit.ts` and the testkit of each other family.
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
  (`WAIT_PARITY_FILES`, `WAIT_PARITY_FAMILIES`).
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
> assumptions. PR open-mercato/cezar#443's root cause was a fixture that encoded an *assumed*
> codex shape (`todoList` items that the app-server never emits), which hid a bug
> where a codex plan never rendered at all. When adding a fixture, cite the
> upstream schema/source it was derived from, as open-mercato/cezar#443 did.

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
  a protected contract (see `BACKWARD_COMPATIBILITY.md`).

---

<a id="10-adding-a-new-runner-the-387-pi-checklist"></a>

## 10. Adding a new runner (the open-mercato/cezar#387 `pi` checklist)

A new backend is a **single class behind the seam** plus its mapper, fixtures and
its rows in **both** parity matrices — never backend-specific types leaking past
`packages/cezar/src/core/`. PR open-mercato/cezar#387 added `pi` and enumerated every place the
runner union was duplicated; that list is the concrete map, and the union now
derives from one `RUNNER_IDS` tuple in `agent-runner.ts` so most of it is
typecheck-enforced rather than hand-tracked.

To be first-class:

1. **Runner** — `packages/cezar/src/core/pi-runner.ts` implementing `AgentRunner` /
    `AgentSession` (persistent process; `pid`; `sendMessage`/`discardQueuedMessages`/`holdsHumanInput`/`end`/`interrupt`;
   `result`). Honor `AgentRunSpec` uniformly — use `prependSystemPrompt` if the
   backend has no native system-prompt channel — and declare `specSupport` (§1):
   every field, honored with its channel or dropped with the wire reason. The §7
   spec-support rows hold the declaration against the mock's recording. Declare
   `systemPromptOnResume` (§1, hearsay-tools/cezarion#790): `resent` when every
   session/process delivers `spec.systemPrompt` again (so Continue must resend a
   skill playbook — Claude keeps the launch prompt and ignores new flags, so changed
   extra/delegation/artifact/handoff instructions never reach a resumed session; Pi
   replaces stored sections with the new flags; OMP was not live-verified and is
   declared `resent` as the safe value), `in-thread` when the opening turn prepended
   it into resumed history (OpenCode, Codex, Cursor). The flag is the caller's
   skill-prefix dedupe policy — in-thread runners still re-prepend the whole
   `spec.systemPrompt` (extra prompt + handoff) on every resumed opening turn. Required
   — a new runner fails to compile until it decides. Declare
   `inputDelivery` (§1) from a live probe of mid-turn input, including its
   `acknowledgement` and `humanInputAtTurnEnd`, and pass the §7 I1/I2
   rows or declare their exemption. Add the runner's row to `RUNNER_FACTS`
   (`core/runner-facts.ts`, §1), with its `inputDelivery` and
   `systemPromptOnResume`, and expose it as `facts`; the class reads both from its
   row, and the table's type fails to compile until the row exists. A new value of
   a turn-path fact brings the runner into the derived parity set (§7). Shared code reads these facts, so a new runner never
   needs a runner-id branch outside `packages/cezar/src/core/`.
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
   (`packages/cezar/src/core/harness-parity-core.testkit.ts`): the env var that points it at an
   offline mock, and a prompt for every name in the shared scenario catalog (§7). Then make
   that mock a wire encoder over `scripts/mock-scenario.mjs`: shared scenario
   selection and scripts belong to that module; the encoder emits the backend's
   native frames. Keep acknowledgement, delivery control, failure control and
   steering admission in the mock. Declare genuine wire gaps in `unsupported`.
   The player uses `scripts/mock-lifecycle.mjs` for the no-progress stall and release wait. **Every matrix row must pass** —
   the guard tests fail the suite until each `(criterion, runner)` cell is a live row or a
   declared `PARITY_EXEMPTIONS` entry naming the wire limitation. Never an `it.skip`, and
   never "not implemented yet".
   Choose the ask path explicitly: either map the backend's native question wire to
   `ask.requested`, or rely on the portable `cezar_ask` tool, which every runner reaches through `cezarTools`.
   A native bridge must keep its pending request in that runner's `AgentSession` state and
   route the next human answer through the same state back to the provider. Harness row R3
   pins a valid ask and R4 a malformed native one (a wire with no native ask is exempt from R4,
   because `cezar_ask` refuses bad arguments with `invalid_request`); R6 and R7 pin human-answer routing, queued agent
   input, and recovery with an unanswered ask. R26 pins completion after answering
   every exposed human ask kind in `askResumeCases`. A native-answer `end_turn`
   does not hand off to the human: resume the work unless the agent declares a
   terminal state, monitoring or another ask. Extra native kinds such as
   `create_plan` (and permissions if exposed as human asks) need the same resume
   coverage. Cursor permissions currently auto-resolve and do not create human asks.
   CI-wait exposure must also satisfy the CI-wait contract above: declare
   `cezarTools` in `specSupport`, preserve user configuration, prove discovery and
   actual invocation on fresh/resumed/recovered sessions, and verify the installed
   adapter with deterministic dry-run fixtures. Do not treat argv/config snapshots
   as transport proof or add a silent exemption for an unsupported CI tool.
9. **Plumbing** — the run-store `runner` enum, workflow step schema, the
   `POST /api/runs` / `PUT /api/config` bodies, `resumeCommand()`, the web
   `Runner` type, composer pills/presets, and Settings → Agents. Keep additive
   so old `runs.json` records still parse (the `runner` enum keeps `claude-cli`
   parseable — follow that precedent). **Settings → Agent config ships with the
   runner, not after it**: one `AGENT_DESCRIPTORS` entry in
   `packages/web/src/routes/settings/agent-descriptors.ts` keyed by the runner id,
   plus the vendor's documented config files in
   `packages/cezar/src/agent-config/catalog.ts` (paths, format, verbatim
   precedence, `docsUrl`; a home variable goes in `AgentHomePaths` /
   `agentHomePaths()` only when the vendor documents one). The guard in
   `agent-descriptors.test.ts` fails the suite for any `RUNNER_IDS` member
   without a descriptor, the way item 11's guard fails one without a
   model-discovery adapter (hearsay-tools/cezarion#321). A vendor that documents no editable file still gets its
   tab — give the group `empty` copy that says why and what to try, never omit
   the agent (hearsay-tools/cezarion#322, Pi's MCP group: "No MCP.").
10. **Model selection** — accept `provider/model` where relevant; open-mercato/cezar#387 documents
   the existing inconsistencies (opencode drops a bare model silently) — do not
   reproduce a silent-drop. A backend with no default provider gets no entry in
   `BACKEND_MODEL_MAP`'s default column, so a bare id fails loud.
11. **Host model discovery** — the picker lists the models the user's own CLI can run
   today, never a preset table. Discovery landed one runner at a time after each had
   shipped without it (hearsay-tools/cezarion#1 pi, hearsay-tools/cezarion#18 invalidation after login, hearsay-tools/cezarion#74 codex failure reasons,
   hearsay-tools/cezarion#89 claude), which is why it is a checklist step and not a follow-up. Nothing derives
   it from `RUNNER_IDS`: `modelDiscoveryRunnerSchema` is a hand-kept enum and
   `RunnerModelCatalog` takes a `Partial` adapter map, so a runner that skips this step
   fails nowhere — `GET /models` answers `unavailable` and the picker shows presets
   again. Seven pieces, in the same PR as the runner:
   - **Adapter** — a bounded `packages/cezar/src/core/<runner>-model-catalog.ts`
     exporting `discover<Runner>Models({ cwd })`. Spawn the CLI's own model-listing
     surface under the runner's sanitized child env (`pi --list-models`, codex
     `model/list`, claude stream-json `list_models`, opencode `models`), cap it (the pi
     precedent is 10 s, 512 KB of stdout, 500 models), and **throw on every failure** —
     absent CLI, too old, not logged in, malformed, timeout — so the catalog degrades to
     `unavailable` and boot never fails. Never read the CLI's config or cache files, and
     never run a model turn to discover.
   - **Contract enum** — add the id to `modelDiscoveryRunnerSchema`
     (`packages/contract/src/workspace.ts`); `runnerDiscoversModels` and the `/models`
     query validator both read it.
   - **Catalog registration** — add the adapter to `hostModelCatalogAdapters`
     (`packages/cezar/src/core/host-model-catalog.ts`), the map `server.ts` hands to
     `RunnerModelCatalog`. It is a full `Record` over the contract enum, so the previous
     bullet without this one is a typecheck error, not a silent `unavailable`.
   - **`GET /api/v1/models?runner=<id>`** — answers `{ runner, models, source:
     live | cache | unavailable, stale, reason? }` with no route change once the two
     bullets above are in; add the runner to `models-api.test.ts`.
   - **Picker** — `packages/web/src/routes/new-task-form.ts`: `mergeModels` lists the
     live catalog and keeps only the first preset as the fallback alias when
     `runnerDiscoversModels` holds, and `DISCOVERY_RUNNER_LABEL` needs the runner's
     display name for the "cached" / "unavailable" hint.
   - **Sanitized `unavailableReason`** — a `reason` is a stable one-line category
     (spec `.ai/specs/2026-07-21-codex-latest-model-discovery.md`, hearsay-tools/cezarion#74): never raw
     stderr, a command line, env or config content. A stale cache is served with the
     reason attached, not dropped.
   - **Invalidation** — `RunnerModelCatalog.invalidate(runner)` after provider
     Connect / Check / refresh (`invalidateHostModels` in `server-deps.ts`, hearsay-tools/cezarion#18), so an
     `unavailable` answer is never cached across a login. Retry is the same call.

   The pin is `packages/cezar/src/core/model-discovery-guard.test.ts`: every `RUNNER_IDS`
   member must be in the contract enum, ship the adapter module and be registered on the
   host catalog, unless `MODEL_DISCOVERY_EXEMPTIONS` names it with the wire reason (a CLI
   with no model-listing surface at all) — never "not implemented yet". Adapter behaviour
   stays covered by `<runner>-model-catalog.test.ts` and `models-api.test.ts`; the §6/§7
   parity matrices deliberately carry no discovery row.
12. **Credentials** — one entry in `BACKEND_ALLOW_PREFIXES` (`agent-env.ts`):
   `buildChildEnv` is least-privilege per backend, so a multi-provider runner
   must receive credentials for every provider its own model ids can name
   without widening other backends.

### OMP lessons (hearsay-tools/cezarion#595)

OMP is the second Pi-shaped runner, and each place it differs from Pi broke a Pi assumption.
Check these before copying an existing runner's code for a fork or near-fork of its wire:

- **No `agent_settled`.** Copying Pi's turn trigger would hang every OMP turn. Read the
  upstream docs' own statement of the boundary (`prompt_result`, `session_settled`) and never
  treat `agent_end` as terminal: it is non-terminal while OMP retries or compacts.
- **No `--session-id`.** The session id is discovered from `get_state` and Continue uses
  `--resume <id>` (the Codex/Cursor precedent).
- **No `--exclude-tools`.** `--tools` is an allowlist validated against OMP's registry: an unknown
  name, or a built-in the session has not enabled, exits 2 before any frame. Never pass an unmapped
  name through, keep the default list to tools that are on by default (`find` and `ast_grep` are
  not), and handle the refusal for tools a user's settings disabled, or MCP tools OMP has not
  registered, by respawning once without them. OMP spells MCP tools `mcp__<server>_<tool>`, not
  Claude's `mcp__<server>__<tool>`.
- **Not every omp build takes every flag.** OMP fails fast on an unrecognized flag
  (`Error: unknown flag(s): …`, exit 2). `--add-dir` is the one optional flag cezar passes, so a
  build that rejects it is respawned once without it, with a note; any other unknown flag stays
  fatal, because model, prompt, resume and tools are not optional.
- **Diffs and plan come from the tool result**, not the args: the default `hashline` edit mode has
  args `{input}` only.
- **`cezar_ask` is the ask in plain `--mode rpc`**, because OMP never registers its native ask
  tool without a UI; do not build a native ask bridge there.
- **Sub-agents are on the wire**, so S9/R12/R15 are constructible and carry no exemption.
- **`omp models --json` prints an object** (`{"models": [...]}`), not an array, and exits 0 with an
  empty list when logged out.
- **Record real-binary evidence, and say what you could not run.** Startup frames, `--tools`
  refusals and `dumpTools` were recorded first, and the turn fixtures were source-derived and
  labeled while no OMP login existed; live turns later confirmed streaming, a same-turn steer,
  `--resume` and interrupt (fixtures README verification ledger). A constructed frame (the mock
  sends frames after settle that the real wire never does) is labeled constructed, not passed off
  as a capture.

<a id="11-the-plan-channel-pr-443"></a>

## 11. The plan channel (PR open-mercato/cezar#443)

PR open-mercato/cezar#443 (`fix/issue-433-render-plan-todo`, open at the time of writing) hardens
`plan.updated` across Claude, Codex and OpenCode after finding the plan never reached the
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

The `plan.updated` **event name and payload structure are unchanged**; open-mercato/cezar#443
extends the *handling*, not the wire shape (on `main`, `PlanStatus` is the three
values in §3).

---

## Compatibility

The agent event protocol is a protected surface: see `BACKWARD_COMPATIBILITY.md`.
V1 `AgentEvent` `type` strings and v2 `UiEvent` dotted types are
additive-only; removing/renaming one, or breaking the parity requirement, is a
breaking change requiring an explanation and migration path.

## Related documents

- `.ai/specs/2026-09-04-harness-parity-matrix.md` — the harness parity matrix's design record (§7).
- `AGENTS.md` — repo working rules; the "Agent runners / backends" routing row.
- `BACKWARD_COMPATIBILITY.md` — the compatibility policy.
- `.ai/analysis/cockpit-ui-redesign/agent-event-protocols.md` — the deep design record (§7, §7.1).
- `.ai/specs/2026-07-14-cockpit-ui-redesign.md` — the spec (protocol v2, parity requirement).

<a id="bounded-structured-question-recovery-88"></a>

### Bounded structured-question recovery (hearsay-tools/cezarion#88)

Retired with the `CEZ:ASK` line (hearsay-tools/cezarion#2397). The repair once closed a `CEZ:ASK` payload that was missing only its closing braces and brackets, and it persisted a danger note. `cezar_ask` validates its arguments in the tool call, so the repair has no input left. Saved runs keep their recovery and rejection notes.

Harness row S13 verifies the late auto-end veto and subsequent reply completion against every `RUNNER_IDS` backend’s real offline wire.


<a id="codex-managed-permissions-708"></a>

### Codex managed permissions (hearsay-tools/cezarion#708)

Before fresh or resumed threads, query `configRequirements/read` on the session's
own app-server. Only `requirements: null` selects Cezar's unmanaged full-access
sandbox (needed by containers without UID maps). Managed requirements, including
unknown future fields, retain Codex's permissions. Codex resolves saved profiles
and managed defaults on resume; Cezar never replaces an allowed read-only profile
with a writable default. Unavailable or malformed discovery never
selects full access. Approval policy is never overridden.

`CEZ_CODEX_NETWORK=0` disables legacy workspace network access without replacing
managed filesystem rules. The thread response must confirm restricted network
access before any turn starts; incompatible profiles stop with a clear error.
Follow-up `turn/start` and `turn/steer` do not set permission overrides.

Registered harness row S14 exercises fresh/resumed sessions and repeated human
messages through every `RUNNER_IDS` member's `HARNESS_ADAPTERS` native wire. The
Codex mock models a rejected override retained and revalidated on later turns;
this reproduces the reported diagnostic pattern, not an independently captured
enterprise-account trace. `codex-permissions.test.ts` additionally covers sandbox
and profile requirements, read-only policy, unknown discovery, network restriction
and mid-turn steering. Removing the startup selection must fail the managed cells.

### Codex approval routing (hearsay-tools/cezarion#1049)

A JSON-RPC message with a method and a numeric or string ID is a server
request, never a notification. Cezar handles modern command execution, file
change and permission approval requests, MCP tool approvals and
`item/tool/requestUserInput`. Every other server request receives `-32601`
(method not supported); a malformed supported request receives `-32602`.
Unsupported legacy approvals, dynamic tools, other MCP elicitations (forms, URLs),
token refresh and attestation therefore cannot silently stall the transport.
Notifications have no reply.

#### MCP tool approvals (hearsay-tools/cezarion#1294)

Codex gates every MCP tool call by the server's or tool's approval mode
(`mcp_servers.<name>.default_tools_approval_mode`, `…tools.<tool>.approval_mode`:
`auto | prompt | writes | approve`), separately from `approval_policy`. Unless the
mode is `approve`, it asks the client first with `mcpServer/elicitation/request`.
Cezar sets `approve` on its own server's per-thread entry, so its tools never wait
on a prompt, and never sets `approval_policy`.

An elicitation is a tool approval when its `mode` is `form`,
`_meta.codex_approval_kind` is `mcp_tool_call` and `requestedSchema` asks for
nothing (absent, null or no properties), the test Codex's own TUI applies. It
routes like the other approvals: the same thread and turn checks, a
`permission.requested` titled "Codex requests an MCP tool call" with the server,
message, tool description and arguments, and these options, each answered with
the exact native reply:

| Option | Offered when | Reply |
| --- | --- | --- |
| Allow once | always | `{ action: "accept", content: null, _meta: null }` |
| Allow this tool for this session | `_meta.persist` names `session` | `{ action: "accept", content: null, _meta: { persist: "session" } }` |
| Always allow this tool (saved in your Codex config) | `_meta.persist` names `always`, and the server is not cezar's own | `{ action: "accept", content: null, _meta: { persist: "always" } }` |
| Decline and continue | always | `{ action: "decline", content: null, _meta: null }` |

Codex saves `always` as an approve rule in the user's Codex config, so it is never
offered for cezar's per-run server. Codex reads `cancel` as the same skipped call
as `decline`, so it is not offered. If Codex still asks before a cezar tool (an
older Codex that ignores the key, say), the request reaches Needs you like any
other; it is never answered silently. Elicitations carry no item ID.

`.ai/scripts/probe-approvals.ts` checks this routing against the installed Codex
in one paid turn (hearsay-tools/cezarion#1343). It builds a scratch `CODEX_HOME`
from the user's provider settings only, with no `approval_policy`, and runs
cezar's own runner and tool socket beside a second, marker MCP server. The model
calls the marker tool and then `cezar_wait`. The probe prints the thread's
`approvalPolicy`, every server request with cezar's reply, and each
`mcpToolCall` status. A default run shows the cezar call completed with no
approval request, and the marker call's `permission.requested` answered with
"Allow once". With `--answer decline`, the marker call is rejected. CI never
runs the probe.

Approvals emit the `permission.requested` event with an opaque, fresh
request ID, item ID when present, a title, full action/scope details and offered
options. Command `availableDecisions`, when supplied, is authoritative, including
structured execution-policy and network-policy amendments. Absent or null lists use the
native command/file decision defaults. Permission-profile requests instead grant
only the requested profile with an explicit turn or session scope, or return an
empty grant. Cezar never changes the administrator's approval policy.

The cockpit shows the request under Needs you and sends only `{ requestId,
optionId }` to `POST /api/v1/runs/:id/permissions` (or its project alias). The
runner alone retains each exact native response and exposes the optional
`AgentSession.respondPermission(requestId, optionId): boolean` seam. An unknown,
expired or already answered request, or a non-offered option, is refused without
writing a grant. Free text, agent messages, autonomous nudges and a worker's
parent cannot answer approvals. Permission decisions never use Continue.

Concurrent requests retain separate identities and resolve independently through
`permission.resolved`. RunManager parks the run, releases its workspace slot,
pauses autonomous input and the managed no-progress timer, and resumes only when
all approvals have resolved. `hasPendingPermission` is an optional live-attention
scalar on records and summaries; it grants nothing. Compact history retains
outstanding permission events even outside the newest visible page.

Turn completion/failure, `serverRequest/resolved`, Stop, session closure and
transport loss retire pending approvals; writable transports receive a rejection
before closing. Expiry disables the old card. Recovery creates a new native
session generation for an interrupted approval turn and never replays a stored
approval decision. An owned worker awaiting approval remains unfinished on
restart; recovery cannot classify its wait as successful completion.

The wire contract follows the [official app-server documentation](https://developers.openai.com/codex/app-server/)
and Codex 0.160.1's generated JSON schemas. Focused native-runner tests pin
structured decisions, malformed/unhandled requests, concurrent requests and
teardown. P1 pins the manager/API path and terminal continuation.

<a id="recoverable-opencode-skill-discovery-723"></a>

### Recoverable OpenCode skill discovery (hearsay-tools/cezarion#723, hearsay-tools/cezarion#1265)

OpenCode's [skill loader](https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/skill/index.ts#L105-L116)
skips a skill it cannot load after publishing an unscoped `session.error` with
`error.name: UnknownError`. For an unreadable file, `error.data.message` is
`Failed to parse skill <path>` (captured on 1.18.33, hearsay-tools/cezarion#723).
For malformed YAML frontmatter it is the `FrontmatterError` text from
[config/markdown.ts](https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/config/markdown.ts#L20-L34),
`<path>: Failed to parse YAML frontmatter: <parser detail>`; a 2026-10-18
reproduction on OpenCode 1.18.35 showed the turn going on to answer after that
frame (hearsay-tools/cezarion#1265). Cezar classifies both as recoverable only
when the path ends in `/SKILL.md` (or a Windows separator); the frontmatter path
must start the message and sit on one line, while its detail may span lines or be
empty. Cezar then emits a v1 `note` and a v2 `session.error` with `fatal: false`.
The unreadable-file note preserves the path and suggests checking readability and
repairing or reinstalling the skill. The frontmatter note names the path, keeps the
parser detail collapsed to one line, and suggests fixing the frontmatter between
the `---` lines, for example by quoting values that contain a colon or a quote, or
removing the skill. Neither warning sets the turn's error flag or enters the
agent-input ACK barrier. A successful later idle remains `end_turn`. All scoped
errors, even with the same text, and all other unscoped errors keep existing
failure handling. No protocol shape changes or automatic filesystem repairs are
involved.

Harness cells R44/R45 exercise fresh and Continue success through the native
OpenCode wire: the mock's `mock:skill-warning` sends both unreadable-file
diagnostics and the frontmatter frame captured from `opencode serve` 1.18.35.
Other `RUNNER_IDS` members have named executable wire exemptions for these
server-wide skill diagnostics. R46 exercises genuine provider failure on Continue
through every native `HARNESS_ADAPTERS` wire, complementing fresh R2. The
OpenCode cells also retain scoped skill-text, scoped frontmatter-text
(`mock:scoped-frontmatter-failure`) and unscoped provider failures; mapper and
withheld-ACK tests cover completion state and barrier bypass for both diagnostics.

### CI conflict observation parity (hearsay-tools/cezarion#1339)

R81–R83 in `workflows/ci-wait-conflict-{fresh,continued,recovered}-parity.test.ts` exercise every
`RUNNER_IDS` native mock through `HARNESS_ADAPTERS`, with a real GitHub client
and supervisor reading explicit `CONFLICTING` metadata from a separate gh wire.
R81 covers a fresh session, R82 a Continue, and R83 restart recovery without an
active session. They read committed rows before wake admission, inject a failed
checkpoint, retain one lifecycle input across duplicate completion, and deliver
one conflict observation over the native prompt channel. R83 also reboots with
a resolved but undelivered result after the external PR becomes clean: the saved
observation must survive without reclassification. No timer or repair authority
is introduced.
A cancelled wait ignores a late result of any outcome: U4 and
`workflows/ci-wait-list-registration.test.ts` pin that, so hearsay-tools/cezarion#2991 retired R84.
