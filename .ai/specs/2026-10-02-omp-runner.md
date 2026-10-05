# OMP (Oh My Pi) agent runner (#595)

Status: approved design (2026-10-02). Approved by the owner section by section in
brainstorming and then as this written spec. This is the committed design record that code
comments cite. Decisions made while implementing it (rulings 0 to 20, written "Ruling N" so they cannot be read as harness rows, checked against a real
OMP v18.4.11 binary on 2026-10-05) are folded into the sections they change and listed together
in [Implementation decisions](#implementation-decisions-2026-10-05).

Related: `AGENT_PROTOCOL.md` §4, §6, §7, §10 and the CI-wait contract; #387/#470 (pi runner);
#376 (cursor runner); #265 (same shape of work); `.ai/specs/2026-07-20-grouped-subagent-display.md`
(Agents drawer).

## Problem

Cezar runs Claude, Codex, OpenCode, Pi and Cursor as first-class backends. OMP
(`can1357/oh-my-pi`, CLI `omp`) is a Pi fork with a larger tool set (LSP, AST edits, native
subagents) and the same host surfaces cezar uses for Pi: `omp --mode rpc` over JSONL and
`omp acp`. Pointing `CEZ_PI_BIN` at `omp` is not support: the run, Settings, model discovery,
`allowedTools` mapping and the picker still say `pi`, a host with both binaries collides, and
the RPC dialect differs enough that Pi's runner would hang (no `agent_settled`, below).

## Goal

A team on OMP picks **OMP** in the composer and gets what every other backend gets: a live
session that streams text, reasoning, tools, diffs, plan and usage; Continue, steer and
interrupt; Needs You, monitoring and CI-wait; sub-agents in the Agents drawer; Settings → Agent
config; host model discovery. A host without `omp` boots unchanged and shows OMP as unavailable.

Acceptance criteria (#595), each owned by a section below:

| AC | Where |
|---|---|
| `omp` is a `RUNNER_IDS` backend and factory case, distinct from `pi` | Identity and plumbing |
| Probe lists OMP only when `omp` is installed | Identity and plumbing, Errors |
| A run streams tools, text and turn-end | Wire mapping |
| Continue and interrupt work on a live session | Session lifecycle |
| `ui-parity` and `harness-parity` rows pass (or a wire-named exemption) | Testing |
| Settings → Agent config: `omp` descriptor and catalog entries | Settings → Agent config |
| Host model discovery works | Model selection and discovery |
| Absent CLI never fails boot; picker disables it | Errors and degradation |
| `CEZ_OMP_BIN` documented in `.env.example` | Docs |
| Existing `pi` runs, probes and Settings unchanged | Approach (Pi files untouched) |

## Non-goals

- Replacing, retiring or refactoring the `pi` backend; Pi's runner, mapper, mock and fixtures
  are not edited.
- Treating `CEZ_PI_BIN=/path/to/omp` as OMP support.
- Live-network CI against a real provider; every automated test uses the offline mock.
- Shipping or installing OMP for users.
- `omp acp` (RPC carries everything needed; ACP stays OMP's alternative, not cezar's).
- Native OMP `ask` bridge, `rpc-ui` mode, host tools, protocol v2 `rpc_chunk` framing.
- Agent accounts (profiles) for OMP, reading OMP's native default model, the role flags
  `--smol` / `--slow` / `--plan`, goal mode. See Follow-ups.

## Decisions confirmed by the owner

| Decision | Choice |
|---|---|
| Approach | **A. Standalone** `OmpRunner` + `omp-ui-mapper` + mock + fixtures. Pi untouched. Pure helpers proven identical to Pi's (usage, content text) are duplicated with a comment citing the Pi function, not shared |
| Ask path | **Ask marker**: plain `--mode rpc`, where OMP never registers its `ask` tool; the agent asks through cezar's portable marker exactly like Pi |
| Default tools | **Code tools**: cezar defaults plus `todo`, `lsp`, `ast_edit`, `task`, `wait`. `find` and `ast_grep` were in the approved list and are out of the zero-config default (Ruling 1, see Tools) |
| Sub-agents | Listed in the Agents drawer, one row per OMP sub-agent, including batch `task` calls |

## Upstream facts (verified 2026-10-02)

Source: `can1357/oh-my-pi` tag `v18.4.11` (`c0b3937e81e6`) and `main` @ `7318a70cf4ed`;
npm `@oh-my-pi/pi-coding-agent` 18.4.10 (`engines.bun >= 1.3.14`, bin `omp`). Files:
`docs/rpc.md`, `docs/cli-reference.md`, `docs/environment-variables.md`, `docs/models.md`,
`docs/mcp-config.md`, `docs/config-usage.md`, `docs/approval-mode.md`, `docs/extensions.md`,
`packages/coding-agent/src/modes/rpc/rpc-types.ts`, `rpc-mode.ts`, `rpc-subagents.ts`,
`src/main.ts`, `src/session/agent-session-events.ts`, `src/tools/builtin-names.ts`,
`src/tools/ask.ts`, `src/tools/todo.ts`, `src/edit/{schemas,settings,index}.ts`,
`src/task/types.ts`, `packages/wire/src/index.ts`, `packages/agent/src/types.ts`.

What differs from Pi (each one breaks a Pi assumption):

| Fact | Consequence |
|---|---|
| "There is no Pi `agent_settled` frame" (`rpc.md`). A turn yields with `agent_end{yielded}`, the prompt completes with `prompt_result{id, agentInvoked, status, sessionSettled}`, quiescence is `session_settled` | Pi's turn-end trigger never fires; OMP needs its own boundary |
| `agent_end` can be non-terminal (`yielded:false` while retrying, compacting, answering a reminder) | `agent_end` is never a turn boundary |
| Startup writes a `ready` frame (`protocolVersion`, `supportedProtocolVersions`, `maxFrameBytes`) before handling commands; v1 caps each stdout frame at 1 MiB and elides oversized fields | Ignore `ready`; stay on v1 |
| `message_*` frames carry a `messageId`; `set_event_filter {messageUpdates:"delta"}` drops the per-delta `partial` message snapshot | Opt in; detect support from the echoed `data.messageUpdates` |
| No `--session-id`. `--resume [id]` / `--session [id]` resume by id prefix or path; a fresh session mints its id (`get_state.sessionId`) | Codex/Cursor precedent: id discovered, `--resume` on Continue |
| No `--exclude-tools`. `--tools a,b` is an allowlist validated against the discovered registry: **an unknown name, or a built-in the session has not enabled, is a startup error with exit code 2** (real binary, Ruling 4) | Never pass an unmapped name through; handle the refusal (Ruling 13, and Ruling 20 for MCP names) |
| `--add-dir <dir>` (repeatable) exists | `additionalDirectories` honored (Pi drops it) |
| Plain `--mode rpc`: `sessionOptions.hasUI = isInteractive \|\| mode === "rpc-ui"` (`main.ts`), so `AskTool.createIf` returns null | No native ask tool; marker path |
| Approval: `tools.approvalMode` default `yolo`; with no UI a prompt-requiring call fails closed | Same posture as Claude's `dontAsk`; cezar passes no approval flag |
| Sub-agents: `set_subagent_subscription {level:"events"}` streams `subagent_lifecycle {id, agent, description?, status: started\|completed\|failed\|aborted, parentToolCallId?, index}` and `subagent_event {id, event: AgentSessionEvent}` | Child work is attributable to its parent `task` call; S9/R12/R15 are constructible (no exemption) |
| `task` tool: single form `{agent, task, ...}` or batch `{context, tasks:[...]}` | One call may spawn N agents |
| Default `edit.mode` is `hashline`: args are `{input}`; the result `details` carries `path`, `oldText`, `newText` (or `perFileResults[]`) | Diffs come from the tool **result**, not args |
| `todo` takes ops (`init`, `start`, `done`, `rm`, `drop`, `block`, `unblock`, `append`, `view`); `result.details.phases[].tasks[]{content, status}` holds the full list | Plan comes from the tool result |
| Extensions: `--extension <path>`; `pi.registerTool({name, label, description, parameters, execute})`; legacy Pi extensions load through OMP's compatibility shim; parameters accept omptype or the TypeBox shim | CI-wait as an OMP extension, registration proven by `get_state.dumpTools` |
| MCP has no CLI injection flag (files only: `.omp/mcp.json`, `~/.omp/agent/mcp.json`) | CI-wait cannot use the MCP adapter without editing user files |
| `omp models --json`: `provider`, `kind`, `id`, `selector`, `name`, limits, reasoning/thinking metadata, `input`, `cost` | Discovery without an RPC session |
| Config is YAML: `~/.omp/agent/config.yml`, project `.omp/` (`settings.json`, then `config.yml`); `--config <file>` overlays are read-only YAML layers | New `yaml` config format; D1 overlay |
| OMP reads `OMP_*` and the Pi names `PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR`, `PI_CODING_AGENT_SESSION_DIR` | Credential allowlist; profiles deferred |
| Thinking levels: `off, minimal, low, medium, high, xhigh, max` (`--thinking`) | cezar effort maps 1:1 |
| Queue defaults `steeringMode: one-at-a-time` | `set_steering_mode all` (#551 parity) |

Identical to Pi (shapes cezar's Pi code already handles): `prompt` with optional
`streamingBehavior:"steer"` and id-echoed `response`; `message_update.assistantMessageEvent`
(`text_*`, `thinking_*`, `contentIndex`, `delta`); `message_end.message{role, usage, stopReason,
errorMessage}`; `tool_execution_start{toolCallId, toolName, args}`,
`tool_execution_update{partialResult}`, `tool_execution_end{result, isError}`; `abort`;
`get_state`; `extension_error`; stdin EOF drains and exits 0.

## Design

### Components

| Unit | Responsibility |
|---|---|
| `packages/cezar/src/core/omp-runner.ts` | `OmpRunner` implementing `AgentRunner`/`AgentSession`: one persistent `omp --mode rpc` child per session; `OMP_SPEC_SUPPORT`; `inputDelivery`; v1 `AgentEvent` stream; drives the mapper for v2 |
| `packages/cezar/src/core/omp-ui-mapper.ts` | Pure OMP RPC → v2 `UiEvent` mapper with explicit immutable state; never throws; owns the turn boundary, provider-error latch, sub-agent nesting, result-based diffs and plan |
| `packages/cezar/src/core/omp-model-catalog.ts` | `discoverOmpModels({ cwd })` over `omp models --json`; Discovery caps: 10 s, 2 MiB stdout, 2000 models (past the model cap the first 2000 in OMP's order are kept with one log line, never a throw; Ruling 19); throws on every other failure |
| `packages/cezar/scripts/mock-omp-rpc.mjs` | Offline mock in OMP's own wire shape (`ready`, ids, `prompt_result`, `session_settled`, sub-agent frames, todo/edit result details) for `CEZ_DRY_RUN=1` and both parity matrices |
| `packages/cezar/scripts/omp-ci-wait.mjs` | OMP extension registering `cezar_wait_for_ci` through the shared CI client (`../dist/ci-wait/mcp.js`, `src` in a dev checkout, like `pi-ci-wait.mjs`) |
| `packages/cezar/scripts/omp-restrict-delegation.yml` | Static `--config` overlay: `tools: { approval: { task: deny } }` |
| `packages/cezar/src/core/__fixtures__/omp/` | Wire-faithful `*.ndjson` + `*.expected.json`, each fixture citing its upstream file and version; a `README.md` stating which frames are source-derived and which are recorded |

### Identity and plumbing

- `RUNNER_IDS` gains `'omp'` (`agent-runner.ts`); `createRunner` gets `case 'omp'`;
  `UiBackend` in `core/ui-events.ts` and its mirror `packages/api-client/src/protocol/ui-events.ts`.
- `backend-detect.ts`: `probeOmp()` and the `BackendCheck` name; `CEZ_OMP_BIN` then `omp` on
  PATH; `--version`; `mock (CEZ_DRY_RUN=1)` under dry-run. Never probes `pi`.
- Runner-id tables in the sites that list runners today (the Cursor set):
  `contract/src/{health,workspace,delegation}.ts`, `core/{model-identity,model-presets,provider-auth,agent-profiles,host-model-catalog}.ts`,
  `agent-config/{catalog,models}.ts`, `paths.ts`, `delegation/execution-identity.ts`,
  `server/{open-in-app,server}.ts`, `workflows/{run,types}.ts`, `runs/store.ts` enum (additive),
  `automations/types.ts`, `server-install/steps.ts`, `config.ts`; web `api/{global-events,queries,run-events}.ts`,
  `lib/{provider-auth-alert,provider-status}.ts`, `routes/new-task-form.ts`,
  `routes/settings/{accounts-section,agent-descriptors,provider-settings}.tsx|ts`,
  `routes/task-thread/{run-actions,thread-items,thread-state}.ts(x)`. The implementation greps
  `'cursor'` and `RUNNER_IDS` again rather than trusting this list.
- Additive only: old `runs.json` records and configs parse unchanged.

### Spawn and spec support

```
omp --mode rpc
    [--extension <scripts/omp-ci-wait.mjs>]        # spec.cezarTools
    [--resume <sessionId>]                          # spec.resume
    [--append-system-prompt <text>]                 # spec.systemPrompt
    [--model <provider/model>]                      # spec.model
    [--thinking <low|medium|high|xhigh|max>]        # spec.effort
    [--add-dir <dir>]...                            # spec.additionalDirectories
    [--config <scripts/omp-restrict-delegation.yml>]# spec.restrictNativeDelegation (D1)
    [--tools <mapped,list>]                         # spec.allowedTools (see Tools)
```

`OMP_SPEC_SUPPORT` (held against the mock's recorded argv and RPC by the §7 spec-support rows):

| Field | Honored | Via / reason |
|---|---|---|
| `cezarTools` | yes | explicit CI `--extension`; `cezar_wait_for_ci` admitted when `--tools` is set |
| `systemPrompt` | yes | `--append-system-prompt` |
| `userPrompt` | yes | RPC `prompt.message` |
| `images` | yes | RPC `prompt.images` (`{type:'image', data, mimeType}`) |
| `cwd` | yes | spawn cwd |
| `allowedTools` | yes | `--tools`, mapped onto OMP names; unmapped names dropped (fail closed) |
| `restrictNativeDelegation` | yes | `--config` overlay denying `task`, and `task`/`wait`/`eval` left out of `--tools`; with `allowedTools` undefined D1 passes an explicit list (D1) |
| `bashAllowlist` | yes | no prefix equivalent: `bash` dropped from `--tools` when an allowlist is set (Pi's rule) |
| `additionalDirectories` | yes | `--add-dir` per directory |
| `env` | yes | merged over the child env through `buildChildEnv` |
| `model` | yes | `--model provider/model` |
| `effort` | yes | `--thinking`, canonical level |
| `timeoutMs` | yes | wall-clock kill switch |
| `sessionId` | yes | `--resume <id>` when resume is set; a fresh session mints its own id, reported from `get_state` |
| `resume` | yes | `--resume` in place of a fresh session |

### Tools

Default (step without `allowedTools`): `HARNESS_EXTRA_TOOLS.omp = ['todo', 'lsp', 'ast_edit',
'task', 'wait']` on top of `DEFAULT_ALLOWED_TOOLS`, so the zero-config argv is
`--tools read,edit,write,grep,glob,bash,todo,lsp,ast_edit,task,wait`.
No web, `eval`, browser, GitHub, memory or checkpoint tools unless a workflow grants them.

`find` and `ast_grep` are not in the default (Ruling 1). The real v18.4.11 binary gates them behind the
settings `find.enabled` and `astGrep.enabled`, both off by default, and a `--tools` list that names
an unavailable built-in exits 2 with `Built-in tools unavailable in this session: find, ast_grep.`
Naming them by default would fail every zero-config run. A workflow can still grant them through
`allowedTools` for a user who enabled them.

The other config-gated names in the default (`todo`, `lsp`, `ast_edit`, `web_search` when granted)
can be switched off in a user's own settings. Those users must not lose the run (Ruling 13): when the
child exits 2 before its first frame and stderr reads `Built-in tool(s) unavailable in this
session: X[, Y]`, the runner respawns **once** with exactly those names removed from `--tools`
and emits one v1 `note` naming them. The respawn only ever narrows; it never adds a name or
falls back to OMP's defaults. Because the refusal arrives before any frame, the session keeps a
**stdin outbox** until the first frame: every command accepted meanwhile (the startup
commands, the opening `prompt`, a human steer) waits in order and is replayed to the respawned
child, so no accepted input is lost. `session.pid` is a getter that follows the live child, and
`SessionOptions.onPidChange` tells the run manager when a respawn replaced it.

MCP tools (Ruling 20). In RPC mode OMP validates `--tools` right after a 250 ms MCP discovery
window (`docs/mcp-config.md`), so a correctly spelled tool from a slow server can read as unknown.
The same one-time respawn therefore also reads `Unknown tool(s) in --tools: a, b.`: when every
name in it is an `mcp__` name this spawn passed, those names are removed too. Both lines arrive in
one exit, so one respawn covers both, with one v1 `note` naming everything dropped. Any other
unknown name (a built-in, a cezar tool, an MCP name cezar never passed) stays fatal.

`ompTools(allowedTools, bashAllowlist, restrictNativeDelegation)`:

| cezar name | OMP name |
|---|---|
| `Read` / `Edit` / `Write` / `Bash` / `Grep` / `Glob` | `read` / `edit` / `write` / `bash` / `grep` / `glob` |
| `Subagent`, `Task` | `task` |
| `TodoWrite` | `todo` |
| `WebSearch` / `WebFetch` | `web_search` / `read` (Ruling 2: `fetch` is not a v18.4.11 built-in; `read` reads static web pages per its own description) |
| any OMP built-in name (`BUILTIN_TOOL_NAMES` at the pinned version, lower-case) | itself |
| `mcp__<server>__<tool>` (Claude's spelling) | `mcp__<server>_<tool>`, OMP's own spelling (v18.4.11 `qjn`: each part lowercased, anything but `[a-z0-9_]` and repeated underscores folded to one `_`, edges trimmed, a tool name repeating its server's prefix stripped of it). Ruling 20 |
| any other `mcp__*` (already OMP's spelling) | itself; validated against the registry OMP discovered, so an unregistered one is dropped by the Ruling 13 / Ruling 20 respawn |
| anything else | dropped, with one v1 `note` naming the dropped tools |

Rules: dedupe; `bash` dropped under `bashAllowlist`; `task`, `wait` and `eval` dropped under D1;
names the Ruling 13 respawn excludes removed; append `cezar_wait_for_ci` (and, under `CEZ_PREVIEW=1`,
`cezar_preview_serve`: exactly the names `omp-ci-wait.mjs` registers, Ruling 11) when `cezarTools` is
set and the list is non-empty. The flag itself:

| `spec.allowedTools` | Flag |
|---|---|
| `undefined` | none: OMP's own default set (Pi's behaviour for the same input). Exception: under `restrictNativeDelegation` an explicit list, see D1 (Ruling 14) |
| `[]` (planner, auto-name: "no tools") | `--no-tools` (Claude's default-deny intent; Pi enables everything here, OMP does not copy that) |
| non-empty, maps to at least one OMP name | `--tools <list>` |
| non-empty, every entry dropped | `--no-tools`, plus the drop `note` (fail closed, never wider)|

### Session lifecycle and wire mapping

Startup writes, in order: `get_state` (id `cezar-state`), `set_steering_mode all`,
`set_subagent_subscription events`, `set_event_filter {events:null, messageUpdates:"delta"}`,
then the first `prompt`. OMP queues commands until it is ready.

| OMP frame | v1 (`AgentEvent`) | v2 (`UiEvent`) |
|---|---|---|
| `ready` | none | none (protocol v1 stays; the `maxFrameBytes` cap is not negotiated) |
| `response` to `get_state` | `session` (discovered id) | `session.started {backend:'omp', sessionId, model?}` |
| `response` to `set_*` with `success:false` | `note` | none |
| `response` to `prompt` (by id), success | agent-input ack, Pi's #505 bookkeeping | none; marks the opening prompt admitted |
| `response` to `prompt`, `success:false` (pre-admission; no `prompt_result` follows) | `error` | `session.error` (non-fatal); when it answers the **opening** prompt the turn ends `turn.completed {stopReason:'error'}` (Ruling 10) |
| `response`, other `success:false` | `error` | `session.error` (non-fatal) |
| `message_update` `text_*` | coalesced `text` per block (`V1TextCoalescer`) | message `item.*` |
| `message_update` `thinking_*` | none | reasoning `item.*` |
| `message_start` role `user` | `onAgentInputConsumed` by text match | none |
| `message_end` assistant | `token-usage`, `cost`; latch set (`stopReason:error`) or cleared | `usage.updated`; turn usage held for `turn.completed` |
| `tool_execution_start` | `tool-call` | tool `item.started` (`toolDisplay`) |
| `tool_execution_update` | none | `item.updated` with partial output |
| `tool_execution_end` | `tool-result`, `image` parts | `item.completed`; `diffs` from edit/write `result.details` (`path`, `oldText`, `newText`, `perFileResults[]`), falling back to replace-mode args; `plan.updated` from todo `result.details.phases` (`abandoned` → `cancelled`, `blocked` → `pending`) |
| `agent_start` | snapshot of acknowledged, unconsumed submissions (#505) | re-opens a turn if activity resumes after settle (Pi's `mapActivity` rule) |
| `agent_end` (any) | none | none (never a boundary) |
| `prompt_result` `agentInvoked:false`, or a `prompt` response with `data.agentInvoked:false`, **for the prompt that opened the turn** | `turn-end` | `turn.completed` |
| `prompt_result` `status:error` before the agent ran | `error`, then `turn-end` | `session.error`, `turn.completed {stopReason:'error'}`; if the failed `prompt` response already reported it, only the turn end follows (no duplicate) |
| **`session_settled`** | **`turn-end`**: marker scan, latch release, consumed-input release, auto-end | **`turn.completed`** with held usage and cost |
| `subagent_lifecycle` | none | sub-agent row (below) |
| `subagent_event` | **never** v1 text, never `turn-end` | child items with `parentItemId` |
| `extension_error` | `note` | `session.error` (non-fatal) |
| `notice` | `note` | `session.error` (non-fatal) when `level:error` |
| `extension_ui_request` (`setWidget`, ...), `advisor_cost_changed`, `queue_update`, `available_commands_update`, `auto_*`, `cache_warming_*`, other | none | none (Ruling 7: observed unsolicited at startup in plain rpc mode; an interactive extension UI request goes unanswered and OMP times it out) |

Turns: a message sent while a turn runs goes out as `prompt` with `streamingBehavior:"steer"`;
an idle one opens a turn. The mapper remembers the **id of the prompt that opened the turn**
(null when OMP woke on its own) and whether OMP admitted it. Only that prompt's local completion
or pre-admission failure ends the turn: a steer OMP handles locally, or that fails after
admission, leaves the running turn alone (a local completion of a steer must not end a turn
that is still running). Startup commands and the opening prompt go through the stdin outbox
described under Tools. `inputDelivery` is `steer` / `observable`, as Pi, derived
from the source and then confirmed by a live turn on 2026-10-05: a mid-turn steer was
consumed in the same turn (Ruling 0, updated). Interrupt: `abort`, then SIGTERM, then SIGKILL after
`KILL_GRACE_MS`. End: close stdin, SIGTERM after the grace period. `resumeCommand()`:
`omp --resume <id>`.

### Sub-agents and the Agents drawer

`collectSubagents` (`packages/web/src/routes/task-thread/subagent-dock.ts`) lists every
parent-less `toolKind:'task'` item and gathers children by `parentItemId`. The mapper produces
that shape; no web change is needed beyond tests.

| Case | Dock row | Children |
|---|---|---|
| Single-form `task` call (`args.task`) | the call's own tool item (id = `toolCallId`) | `parentItemId = toolCallId` |
| Batch-form call (`args.tasks[]`) | one synthetic tool item per sub-agent: `id = <toolCallId>#<lifecycle.id>`, `name:'task'`, `toolKind:'task'`, title from `description` (else the task text), `input {agent, task}` | `parentItemId` = the synthetic id |
| Batch call card | rendered as a plain tool item (`toolKind: 'other'`), title "Task batch · N agents", so the drawer shows N rows, not N+1 | none |

Status: `started` → `running`, `completed` → `completed`, `failed`/`aborted` → `failed`, for
batch and single-form rows alike; a run that ends mid-agent shows as stalled (existing rule).
v18.4.11 runs `task` asynchronously in RPC by default (`async.enabled`, protocolDefault
`["rpc"]`), so a single-form call's `tool_execution_end` can arrive while its agent still runs:
the row then stays `running` with the result attached (`item.updated`) and completes on the
agent's terminal lifecycle frame. A lifecycle already terminal at the result decides the row's
status; a failed result fails the row at once. Agent type comes from the input `agent`
key the drawer already reads. Child `agent_end`/`session_settled`-shaped events inside
`subagent_event` never close the parent turn (S9). A `subagent_event` whose id has no lifecycle
frame yet cannot be attributed (only the lifecycle carries `parentToolCallId`): it is held in a
bounded per-id buffer (200 frames, 8 ids; overflow dropped with one `note`) and replayed when the
lifecycle arrives. The real-binary check records the actual frame order.

### Ask path

Plain `--mode rpc`; the agent asks through the portable marker, parsed at `session_settled`
from the turn's coalesced text exactly as `pi-runner.ts` does. `askResumeCases` is the marker
case only.

### CI-wait tool

`--extension scripts/omp-ci-wait.mjs` when `cezarTools` is set, alongside the user's discovered
extensions (never `--no-extensions`, never `--trusted-extension`). Internal wiring
(`CEZ_TOOL_TOKEN`, `CEZ_TOOL_SOCKET`) reaches the child through `spec.env`. Registration evidence
is `get_state.dumpTools` listing `cezar_wait_for_ci` on the real binary (v18.4.11, proven with
the bundled extension). The extension passes the raw JSON Schema `parameters` and OMP accepts it,
so no TypeBox shim is needed; MCP injection stays rejected (it would require editing
`.omp/mcp.json`). Loading: a dev checkout imports `src/ci-wait/tools.ts`, but real OMP cannot
resolve the workspace contract package from an unbuilt source checkout, so the extension falls
back to `dist/ci-wait/tools.js` **only when it exists**; with no build the source import error
is rethrown, never hidden behind a missing `dist`.

### Delegation restriction (D1)

Under `restrictNativeDelegation`: the `--config omp-restrict-delegation.yml` overlay denies
`task` (user `deny` is absolute in every approval mode), and `task`/`wait` are dropped from
`--tools`. OMP's `eval` tool has `agent()`/`workpool()` helpers that can still spawn agents, and
v18.4.11 has no setting that disables them (only `eval.tools.enabled` and
`eval.workpool.freshAgents`; Ruling 6), so **D1 also drops `eval`** and the spec-support row says why.

With `allowedTools` undefined, OMP's own default set contains `task`, `wait` and `eval`, so
passing no `--tools` would leave delegation open. D1 therefore passes an **explicit list**: OMP's
v18.4.11 default set (`read, bash, edit, eval, glob, grep, task, wait, todo, web_search, write`,
recorded from `get_state.dumpTools`) minus `task`, `wait` and `eval` (Ruling 14). This deviates from
the "no flag" row for `undefined` on purpose: it fails closed. The cost is that D1 runs lack OMP
default extras added after that version. The `via` string on the spec-support row states the
deviation.

### Credentials and environment

`BACKEND_ALLOW_PREFIXES.omp = ['OMP_', 'PI_', ...MULTI_PROVIDER_PREFIXES]`; not `CLAUDE_`
(Pi's reason applies). `PI_*` passes through unchanged, the same as running `omp` in the user's
shell. `PROFILE_ENV_VAR.omp = null` with the reason: OMP profiles are named (`OMP_PROFILE`), and
`PI_CODING_AGENT_DIR` is ignored under a named profile and not verified to move `agent.db`
credentials.

### Model selection and discovery

- `model-identity`: `omp` selects `provider/model` with no default provider (a bare id fails
  loud); `model-presets`: no presets (discovery owns the list; cross-runner guard treats `omp`
  like `pi`).
- `discoverOmpModels`: `omp models --json` under `buildChildEnv({backend:'omp'})`; the output is
  an **object** `{"models":[...]}`, not a bare array (Ruling 3, real binary); keep `kind === 'chat'`
  (or absent); id = `provider/id` (the entry's `selector`); effort levels from the entry's
  `thinking` array of levels (null when the model has none); skip under `CEZ_DRY_RUN=1` without `CEZ_OMP_BIN`; reasons are
  stable one-line categories (`not installed`, `timed out`, `malformed output`, `no models`).
- `modelDiscoveryRunnerSchema` + `hostModelCatalogAdapters` + `GET /api/v1/models?runner=omp`
  + `DISCOVERY_RUNNER_LABEL.omp = 'OMP'` + `invalidateHostModels('omp')` after Connect/Check.
- No native-default-model strategy: an unpinned run passes no `--model`, so OMP's own default
  (model roles) applies.

### Provider status

`provider-auth` descriptor `omp`: executable `CEZ_OMP_BIN ?? 'omp'`, login `omp login`, install
hint "Install OMP (`curl -fsSL https://omp.sh/install | sh`), then run `omp login`." Status
probe: `omp models --json` (Ruling 3). Verified on the real binary: with no credentials it exits 0 and
prints `{"models":[]}`; with a provider key it lists that provider's models. `parseOmpStatus`
therefore reads an empty `models` array as disconnected, a non-empty one as connected, and
anything else as unknown (null). No `get_login_providers` call is needed. The parser is
unit-tested on the recorded output.

### Settings → Agent config

Catalog entries (vendor knowledge, dated "verified 2026-10-02", `docsUrl` to the OMP docs):

| id | Path | Kind | Scope | Format |
|---|---|---|---|---|
| `omp.user.settings` | `~/.omp/agent/config.yml` | settings | user | yaml |
| `omp.project.settings` | `.omp/config.yml` | settings | project | yaml |
| `omp.user.mcp` | `~/.omp/agent/mcp.json` | mcp (`holdsMcp`) | user | json |
| `omp.project.mcp` | `.omp/mcp.json` | mcp (`holdsMcp`) | project | json |
| `omp.user.memory` | `~/.omp/agent/AGENTS.md` | memory | user | markdown |
| `project.agents` (shared) | `AGENTS.md` | memory | project | markdown, add `omp` to `runners` |

Precedence strings quote `docs/config-usage.md` and `docs/mcp-config.md` verbatim (excerpts keep
their lead-in as written upstream).
`AgentHomePaths.omp = $PI_CODING_AGENT_DIR || ~/${PI_CONFIG_DIR || '.omp'}/agent` (default
profile; project files always live in `<repo>/.omp/`). Labels show the default spelling.
`agentConfigFormatSchema` and `ConfigFormat` gain `'yaml'`; `validate.ts` parses it with the
existing `yaml` dependency; the cockpit editor gets YAML highlighting if its language map needs
an entry. `AGENT_DESCRIPTORS.omp`: Settings, MCP, Memory & instructions.

### Cockpit

Composer pill "OMP" (`RUNNER_ORDER` after `pi`), disabled with its install hint when the probe
says unavailable (existing `canRun` path); provider settings and alert copy; thread/run-action
runner switches; Settings → Agents tab.

### Errors and degradation

| Case | Behaviour |
|---|---|
| `omp` absent at boot | `probeOmp` `available:false` + hint; boot continues; pill disabled |
| `omp` absent at spawn | ENOENT → "`omp` not found on PATH: install OMP (https://omp.sh) and run `omp login`" |
| Unparseable line / `parse` failure | v1 `note`; loop continues |
| Provider failure | latched on assistant `message_end` `stopReason:error`, cleared by a later success, released at `session_settled` or stream end without settle (#256, #316) |
| `prompt_result status:error` before the agent ran | v1 `error` + `turn-end`; never waits for a settle that will not come |
| Non-zero exit | error with the last three stderr lines; a cezar-sent signal is teardown (#73) |
| Timeout | wall-clock kill switch, Pi's message shape |
| Oversized v1 frame | OMP elides fields; the mapper tolerates missing fields |
| Model discovery failure | adapter throws a stable reason; catalog `unavailable`; stale cache keeps its reason |

## Testing

Guards that must pass with `omp` added (each fails today the moment the id lands without its
adapter, which is the point):

- `ui-parity.test.ts`: `omp` in `BACKENDS`; every capability row from `__fixtures__/omp`; `omp`
  added to the sub-agent nesting list (`parentItemId`).
- `harness-parity.test.ts` via `HARNESS_ADAPTERS.omp` (`binEnv: 'CEZ_OMP_BIN'`, the OMP mock,
  every scenario **including `subagent` and `subagent-after-park`**). Exemptions only where the
  wire genuinely lacks the cell, each with an OMP-specific reason: R16 (`text_end.content` is the
  one text channel for v1 and v2), I2 (the settle predicate reads a queued steer before
  settling, Ruling 16), A9 (plain `--mode rpc` never constructs the ask tool, Ruling 15) and
  A13/A14 (no portable-answer HTTP ACK retained after turn completion; shared with every
  runner). No S9, R12 or R15 exemption.
- `model-discovery-guard`, `agent-descriptors.test`, the `UiBackend` exactness test,
  `dry-run-backends`, contract parity, and every `RUNNER_IDS`-driven table (conversation,
  CI-wait, CI-wait refusal R27, workflow timeout and no-progress, owned input delivery,
  autosave, allowed-tools, resume command, open-in-app).

OMP-owned tests:

- `omp-ui-mapper.test.ts` replaying `rpc-lifecycle`, `rpc-edit-todo`, `rpc-subagents` (single,
  batch, aborted), `rpc-retry` (non-terminal `agent_end`, failed attempt, recovery).
- `omp-runner.test.ts`: argv per spec field; startup command order; steer vs idle prompt; ack
  and consumption; `agentInvoked:false`; interrupt; end; ENOENT; latch release on stream end;
  tool-name mapping (unknown names dropped, never passed).
- `omp-model-catalog.test.ts`: JSON parsing, caps, every failure reason, dry-run skip.
- `catalog.test.ts`, `validate.test.ts` (yaml), `agent-env.test.ts` (`omp` allowlist both
  directions), `subagent-dock.test.ts` (OMP single, batch of three, aborted mid-agent).
- One focused browser spec: an OMP dry-run run with sub-agents shows its rows in the Agents
  drawer.

Also pinned: the Ruling 10 failed-prompt and steer-local boundaries, the Ruling 13 respawn and stdin outbox
(a human message sent before the first frame reaches the respawned child), the D1 explicit list
(Ruling 14) and the exit-2 mock. The mock frames after `session_settled` that drive the harness R15
cell are constructed (Ruling 17).

Red proofs (stash the source, run, confirm red, restore): the turn-boundary test (`agent_end
{yielded:false}` must not end the turn) and S9 on the OMP mock (a child terminal frame must not
end the parent turn).

## Verification evidence (real OMP)

Recorded 2026-10-05 against the prebuilt `omp/18.4.11` linux-x64 release binary (checksum
verified), installed outside the repo, with an empty home (no user config, no login). The
fixtures README (`packages/cezar/src/core/__fixtures__/omp/README.md`) holds the observed
frames and says which fixture lines are observed and which are source-derived.

| Probe | Result |
|---|---|
| `omp models --json`, no credentials | exit 0, `{"models":[]}` (an object with a `models` array) |
| `omp models --json`, provider key set | exit 0, 27 models; entry keys `provider`, `kind` (`chat`), `id`, `selector`, `name`, `contextWindow`, `maxTokens`, `reasoning`, `thinking` (null or a level array such as `low..max`), `input`, `cost`, `pricingStatus` |
| `--mode rpc` with no models or credentials | exit 1 before any frame; stderr `No models available. Use /login or set an API key environment variable...` |
| `--tools read,not_a_tool` | **exit 2**, `Error: Unknown tool in --tools: not_a_tool.` plus the built-in list |
| `--tools` naming `find`, `ast_grep` | **exit 2**, `Error: Built-in tools unavailable in this session: find, ast_grep.` (gated by `find.enabled` / `astGrep.enabled`, default off) |
| `--tools read,edit,write,grep,glob,bash,todo,lsp,ast_edit,task,wait` with the D1 overlay | starts; `get_state.dumpTools` lists exactly that set |
| Default registry (no `--tools`) | `read, bash, edit, eval, glob, grep, task, wait, todo, web_search, write` |
| RPC startup | `ready {protocolVersion:1, supportedProtocolVersions:[1,2], maxFrameBytes, maxReassembledFrameBytes}`, then unsolicited `extension_ui_request {method:"setWidget"}`, `advisor_cost_changed`, `available_commands_update`; every response carries its `id`; `get_state.data` carries `sessionId` (uuid v7), `dumpTools` (when asked), `isSettled`, `isStreaming`, `hasPendingAsyncWork`, `model`, `steeringMode` and more |
| `set_steering_mode all`, `set_subagent_subscription events`, `set_event_filter {events:null, messageUpdates:"delta"}` | each `success:true`; the filter echoes `data.messageUpdates` |
| `fetch` tool | not a v18.4.11 built-in; `read` describes itself as reading static web pages |
| eval `agent()`/`workpool()` | no setting disables them |
| `cezar_wait_for_ci` | listed by `get_state.dumpTools` with the bundled `--extension` (registration proven) |

**Not verified live (Ruling 0):** no live model turn. The host had no OMP provider login and none was
offered, so every turn fixture (text, tools, edit/todo details, sub-agents, retry, settle,
`inputDelivery` steer behaviour, the order of an early `subagent_event` against its lifecycle)
is source-derived with citations to the pinned upstream files, and the fixtures README says so.
The first live run on a logged-in host is the open check.

## Resolved assumptions

| Question | Answer |
|---|---|
| Turn boundary | `session_settled`, or a prompt completed locally; never `agent_end` |
| Protocol version | v1, no `negotiate_protocol` |
| Approval mode | not passed; OMP's default `yolo` plus no-UI fail-closed matches Claude's `dontAsk` posture; a user's stricter `tools.approvalMode` is respected |
| Agent home in Settings | `$PI_CODING_AGENT_DIR`, else `~/$PI_CONFIG_DIR/agent` (default `.omp`); named profiles not resolved |
| xAI retry extension | not loaded; OMP owns retries (`auto_retry_*`, `retry.fallbackChains`) |
| LSP | left on (`--no-lsp` not passed) |
| Session title generation | OMP disables it in RPC itself |

## Risks

- OMP releases several times a day; the wire is pinned by version-stamped fixtures, and the
  mapper ignores unknown frames. A breaking upstream change shows up as a fixture or probe
  failure, not a hang (the stream-end path releases latches and ends the session).
- `--tools` validation means a wrong default name fails every run; the default list is checked
  against `BUILTIN_TOOL_NAMES` of the pinned version and by the real-binary probe.
- Bun-loaded extension compatibility for `omp-ci-wait.mjs`: resolved. The real-binary
  `get_state.dumpTools` check lists `cezar_wait_for_ci` (v18.4.11; see § Verification evidence).

## Follow-ups (separate issues)

- Native OMP ask bridge (`rpc-ui` + `set_ask_dialog`).
- OMP agent accounts (`OMP_PROFILE` or verified `PI_CODING_AGENT_DIR`).
- Native default model from OMP model roles.
- Role flags (`--smol` / `--slow` / `--plan`) and goal mode.
- Protocol v2 framing for lossless large tool output.
- Extracting helpers shared by the Pi and OMP mappers once both wires are fixture-pinned.

## Implementation decisions (2026-10-05)

Rulings made while implementing, each already folded into the section it changes. Where one
differs from the approved text above, the ruling wins and the cost of being wrong is stated.

| # | Decision | Cost if wrong |
|---|---|---|
| Ruling 0 | Turn fixtures are source-derived and labeled. Updated 2026-10-05: once an OMP login existed, live turns through `OmpRunner` (`xai-oauth/grok-4.6`) confirmed streaming, a same-turn steer, `--resume` and interrupt; see the fixtures README verification ledger | The fixtures could drift from the live wire; the live check covers the main paths only |
| Ruling 1 | Default tools exclude `find` and `ast_grep` (settings-gated, default off; `--tools` naming them exits 2) | Users who enabled them do not get them by default; a workflow can grant them |
| Ruling 2 | `WebFetch` maps to `read`, not `fetch` (not a v18.4.11 built-in) | A `WebFetch` grant gives no web fetch beyond `read`'s static pages |
| Ruling 3 | `omp models --json` is `{"models":[...]}`; status: empty is disconnected, non-empty connected, else null; effort levels from `thinking` | Status misreports |
| Ruling 4 | Unknown or unavailable `--tools` names exit 2 (not 1); the mock mirrors it with OMP's stderr | None |
| Ruling 5 | Runner argv builder and spawn/session lifecycle shipped together (same file) | Larger single diff |
| Ruling 6 | D1 also drops `eval`: no v18.4.11 setting disables its `agent()`/`workpool()` helpers | `eval` unavailable under governed delegation |
| Ruling 7 | The mapper ignores `extension_ui_request`, `advisor_cost_changed`, `available_commands_update` (unsolicited at startup in plain rpc mode) | An interactive extension UI request goes unanswered; OMP times it out |
| Ruling 10 | A failed `prompt` response (pre-admission, no `prompt_result` follows) emits a non-fatal `session.error`; the mapper remembers its id so a later `prompt_result` does not duplicate it; the runner closes the turn only when the failed prompt **opened** it | One extra error line |
| steer-local | A local `agentInvoked:false` completion ends the turn only for the opening prompt's id; a steer handled locally never ends a running turn | A steer would end a live turn |
| Ruling 11 | The CI tool list is whatever `omp-ci-wait.mjs` registers (`cezarToolNames`, including `cezar_preview_serve` under `CEZ_PREVIEW=1`) | R35 preview row red |
| Ruling 13 | Exit 2 before any frame naming settings-disabled built-ins: respawn once without them, one v1 `note`, stdin outbox until the first frame replayed to the respawned child, `session.pid` follows the live child | One extra spawn on startup |
| Ruling 14 | D1 with `allowedTools` undefined passes an explicit `--tools` list (fail closed; deviates from "no flag") | D1 runs lack OMP default extras such as `web_search` |
| Ruling 15 | A9 exemption reason: plain `--mode rpc` never constructs the ask tool (`sessionOptions.hasUI` is true only for interactive or `rpc-ui`; `AskTool.createIf` returns null); a wire limitation, not "not implemented" | A9 row hides a gap |
| Ruling 16 | I2 exemption accepted: the settle predicate requires `queuedMessageCount === 0` and a queued steer is read before settle; the reason names the settle predicate (`rpc-session-settle.ts`) | I2 gap hidden |
| Ruling 17 | Mock frames emitted after `session_settled` (the harness R15 regression) are **constructed**: real OMP settles only when `!hasPendingAsyncWork`. Kept as a stricter robustness test and labeled so in the fixtures README | None (stricter than the wire) |
| Ruling 19 | Volume never fails discovery or the status probe: model cap 2000 and 2 MiB stdout, past the cap the first 2000 in OMP's order with one log line; the `omp models --json` status probe gets a 4 MiB buffer (per-descriptor `maxBuffer`). OpenRouter alone lists 561 models on v18.4.11 | Larger buffers for one probe |
| Ruling 20 | Claude-spelled `mcp__<server>__<tool>` grants are translated to OMP's `mcp__<server>_<tool>`; the Ruling 13 respawn also drops passed `mcp__` names from `Unknown tool(s) in --tools` (never widens; any other unknown stays fatal) | An MCP grant silently missing, with a v1 note |

## Docs to update in the same change

`.env.example` (`CEZ_OMP_BIN`), README env table and backends list, `AGENT_PROTOCOL.md` (§1
identity, §4 OMP mapping, §7 exemptions, §10 OMP lessons: no `agent_settled`, no
`--session-id`, no `--exclude-tools`, result-based diffs, `--tools` rejects unknown names; the
CI-wait harness table and D1 table), `BACKWARD_COMPATIBILITY.md` (new runner id, additive),
and this file.

