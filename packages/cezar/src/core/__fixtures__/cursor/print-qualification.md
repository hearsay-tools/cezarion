# Cursor print transport qualification for fork #590

Checked on 2026-10-07 with Cursor CLI `2026.10.01-e373342`, model
`gpt-5.4-mini` from the live Cursor catalog, in a disposable Git worktree.
The print transport is **blocked**. No Cezar default transport change is
qualified by this record.

## Mandatory gate

`packages/cezar/scripts/probe-cursor-print.mjs` invoked the native CLI with
`-p --force --trust --output-format stream-json --model gpt-5.4-mini
--allowed-tools ask_question_tool_call`. The prompt requested a native question with
Alpha and Beta choices and no other tool. The CLI emitted an
`askQuestionInteractionQuery` request, then its own rejected response in the
same session **1 ms later**. The rejection said the question was skipped.
The process exited successfully even though no human choice reached the
question. The allowlisted capture is
[`print-native-question.json`](print-native-question.json). No raw transcript,
account configuration, environment values or credentials were stored.

The installed vendor bundle's `7000.index.js` module `src/run-agent.tsx`
contains a headless interaction handler whose
`askQuestionInteractionQuery` branch calls `askQuestion` with
`"Questions skipped in headless mode"`. This source observation explains
the live response; it is not a substitute for the capture. Print output
exposes the interaction query after the CLI has already answered it, so a
Cezar stream consumer cannot hold this native gate for the human. Portable
`CEZ:ASK` text remains possible, but the approved design explicitly requires
native question parity too. The human later approved a revised design that
accepts this native limit while requiring a real Cezar `CEZ:ASK` round-trip
before the default switch. The earlier capture in commit `2eac29f1` used the
wrong camel-case tool name in a hidden exclusion flag; this corrected capture
uses the CLI's validated snake-case allowlist. The result was unchanged.

## Native delegation control

The CLI validates `--allowed-tools` against its proto `ToolCall` oneof before
inference. A deliberately invalid value exited 1 and listed the tool names,
including `task_tool_call` and `create_agent_tool_call`. The opt-in
`delegation` probe used a harmless read tool as a behavioral control on one
native session: fresh print with only `read_tool_call` read a blind canary;
explicit resume with only `read_todos_tool_call` could not read a new canary;
another explicit resume with all discovered oneof names except the ten
native agent/delegation entries read a third canary. The native session ID
was unchanged, and no native worker was requested. The allowlisted summary
and exact 59-name permitted list are in
[`print-delegation.json`](print-delegation.json).

This proves the per-invocation allowlist is enforced across fresh and
resumed print turns for the native tool schema. The omitted proto entries
are the verified native entry points for this build. It does **not** isolate
same-user shell access, custom extensions or MCP tools; those are outside
the per-run native-entry-point control. The production runner must use the
qualified allowlist on every turn and fail closed if the CLI's tool schema
changes. A header string or a model's tool inventory alone would not have
been enough evidence.

## Revised qualification, 2026-10-07

The opt-in `mcp` probe loaded an inert local plugin through `--plugin-dir`.
Its MCP descriptor used `${CEZ_PROBE_CANARY}` as a placeholder; only the
print process environment held the synthetic value. The server received it
and returned its hash on both fresh and exact-resume turns. The same native
session ID was returned, and neither `--approve-mcps` nor a global Cursor
configuration write was used. A separate live check used the bundled
`CiToolController` descriptor and environment placeholders: Cursor discovered
its real CI tool on both turns under the same native ID. That latter check
did not invoke a CI operation. [`print-mcp.json`](print-mcp.json) records the
reproducible inert binding; the bundled check was summarized in the task
session and needs a checked-in regression before a default switch.

The [`portable-ask` probe](print-portable-ask.json) emitted a valid trailing
`CEZ:ASK` line and delivered an explicit reply with `--resume <id>`. The
second turn recalled a blind phrase absent from its prompt under the same
native ID. This proves print text and exact resume can carry the marker;
the full Cezar pause, choice, free-text and decline paths remain Tasks 4/6.
Native `AskQuestion` still auto-rejects and must appear as a failed tool.

The [`plugins` probe](print-plugins.json) found a project-local limitation. It
created a disposable task worktree with project-local
`.claude/settings.json` setting `enabledPlugins=false` for the known
Superpowers IDs, then ran print with the intended tool restriction and an
inert `--plugin-dir`. Cursor still used `readToolCall` on the Superpowers
`SKILL.md` from its **Cursor marketplace cache**, not the Claude plugin
cache. Installed CLI source shows the marketplace loader calls
`listEnabledPlugins(userId, teamId)` without a workspace identifier; the
project `.claude` setting filters the separate Claude plugin loader. We
found no per-session print binding to enforce project disablement without
changing global Cursor state. This does not establish how a future Cursor
project-specific marketplace toggle behaves. The human accepted a narrower
user/team-enabled plugin scope on 2026-10-07. This remains a known limit to
document; it no longer blocks the default switch by itself.

## Missing-session resume blocker

After that scope revision, the [`resume-missing` probe](print-resume-missing.json)
used a random never-seen UUID as `--resume <id>`. Cursor exited 0, emitted a
successful result with **that same ID**, and answered `NO_PRIOR_TURN` when
asked for history. It gave no missing-session error. Repeated exploratory
checks showed the same behavior with a fixed obviously invalid ID. Native
ID equality therefore cannot distinguish exact resume from a silent fresh
conversation. `agent ls` is an interactive Ink UI with no documented
noninteractive existence check. No read-only local predicate was
established: a normal fresh print turn created no new directory under
`~/.cursor/chats` in the probe.

The revised design still requires exact history and no silent fresh fallback
for follow-ups and Continue. Until a reliable pre-inference check or a newly
approved verification-turn design exists, this **resume gate blocks Tasks
2–6 and the default switch**. No product runner was changed after this
finding.

Other exploratory checks: a hidden `--image <path>`
accepted a generated five-stripe PNG, and the model reported the randomized
left-to-right colors with read tools denied. A synthetic invalid
`CURSOR_API_KEY` failed authentication instead of falling through to the
logged-in account. These are partial field/account evidence, not full
qualification or regression coverage. The approved spike already proved
an enabled Superpowers skill and controlled hook in a task worktree; a
repeat with the MCP invocation read its skill. No global Cursor files were
changed by these probes.

| Required capability | Invocation / reply mechanism | Read-only prerequisite | Admission and positive / negative assertion | Evidence | Outcome |
| --- | --- | --- | --- | --- | --- |
| Native delegation restriction | Strict `--allowed-tools <comma-separated proto oneof names>` per invocation; omit ten native agent entries | Invalid-name validation exits before inference; version and tool catalog are checked | Fresh allowed read succeeds; resumed denied read fails; full non-agent list succeeds; same native ID throughout. No native worker was requested | `print-delegation.json`; installed `7000.index.js`, `src/utils/exclude-tools.ts` | Pass for built-in native entry points; custom extensions/shell outside control |
| Cezar MCP tools | Local plugin `mcp.json` with `${NAME}` environment placeholders, `--plugin-dir` on each turn | Strict non-agent tool catalog and bundled controller descriptor | Inert server received the synthetic value on fresh/resume; bundled CI tool discovered on both. No blanket approval or global writes | `print-mcp.json`; separate bounded bundled-controller check | Binding passed; production regression pending |
| Human questions and plan approval | Trailing `CEZ:ASK` text, explicit `--resume <id>` reply; native `AskQuestion` rejected | CLI version and discovered model | Marker/reply and history passed; native request auto-skipped after 1 ms, with no human answer | `print-portable-ask.json`; `print-native-question.json` | Portable binding passed; native question is accepted visible limit; full Cezar gate pending |
| Images, model, effort and workspace roots | Hidden `--image <path>` accepted; model variants advertised by `--list-models` | Live account/model | Randomized image recognized without read tools; invalid API key did not fall through. Effort/roots not fully probed | Exploratory task-session checks | Partial; downstream halted |
| Resume and recovery | Explicit `--resume <id>` | CLI exposes `--resume` but no noninteractive existence check | A never-seen UUID returned success under the requested ID and had no prior turn; ID equality is not proof of resumed history | `print-resume-missing.json`; exploratory repeats | **Blocked: silent fresh fallback** |
| Plugin scope and lifecycle | Native marketplace loading; project `.claude` disable does not filter that source | Earlier spike used this CLI version | Project-local `enabledPlugins=false` still allowed Cursor marketplace Superpowers skill read from native cache | `print-plugins.json`; installed `index.js` marketplace loader | Known project-local limit accepted by user; remaining plugin lifecycle unqualified |
| Process ownership and errors | Bounded print process group | Probe used a 45-second deadline and group termination | The probe completed and its disposable worktree was removed; full runner process/error behavior remains untested | Probe command and cleanup check | Not qualified |

## Recheck

Discover a current Cursor model, then run the opt-in probes from this repo:

```sh
node packages/cezar/scripts/probe-cursor-print.mjs \
  --model <discovered-model-id> --output-dir /tmp/cursor-print-check \
  --case native-question
node packages/cezar/scripts/probe-cursor-print.mjs \
  --model <discovered-model-id> --output-dir /tmp/cursor-print-check \
  --case delegation
node packages/cezar/scripts/probe-cursor-print.mjs \
  --model <discovered-model-id> --output-dir /tmp/cursor-print-check \
  --case mcp
node packages/cezar/scripts/probe-cursor-print.mjs \
  --model <discovered-model-id> --output-dir /tmp/cursor-print-check \
  --case portable-ask
node packages/cezar/scripts/probe-cursor-print.mjs \
  --model <discovered-model-id> --output-dir /tmp/cursor-print-check \
  --case plugins
node packages/cezar/scripts/probe-cursor-print.mjs \
  --model <discovered-model-id> --output-dir /tmp/cursor-print-check \
  --case resume-missing
```

For `native-question`, exit code `2` means the native question was
automatically skipped; this is an accepted limit under the revised design.
For `delegation`, `mcp` and `portable-ask`, exit code `0` means their named
binding passed. For `plugins`, exit code `2` reproduces the accepted
project-local limitation on this installed plugin state. For
`resume-missing`, exit code `2` reproduces the silent fresh fallback and
blocks this revised design. Exit code `1` means a probe is inconclusive.
The script saves
only a bounded, allowlisted JSON summary and removes its temporary worktree.
A future CLI may change native-question behavior; requalify it before
offering native answer handling. Requalify all other rows
and the final Cezar invocation before changing the default. The implementing
owner of fork #590 owns that follow-up. Existing Cursor ACP sessions and the
default ACP path retain their known marketplace-plugin limitation meanwhile.
