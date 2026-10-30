# Cursor print transport qualification for fork #590

Checked on 2026-10-07 with Cursor CLI `2026.10.01-e373342`, model
`gpt-5.4-mini` from the live Cursor catalog, in a disposable Git worktree.
The accepted vendor limits and the final product-path recheck are recorded
below. Qualified new Cezar sessions now select print; legacy sessions keep ACP.

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

> Historical since hearsay-tools/cezarion#2279: governed print turns no longer
> pass this allowlist, so native subagent tools stay callable. The probe and
> `print-delegation.json` stay as the record of the qualification.

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
session; native-wire CI tool regressions were added before the default switch.

The [`portable-ask` probe](print-portable-ask.json) emitted a valid trailing
`CEZ:ASK` line and delivered an explicit reply with `--resume <id>`. The
second turn recalled a blind phrase absent from its prompt under the same
native ID. This proves print text and exact resume can carry the marker;
the full Cezar pause, choice and free-text paths were exercised below.
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

## Missing-session resume limit

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

The revised design requires Cezar to resume only an ID it recorded from a
Cursor session event, under the owning account, and compare the returned ID.
The existing `resumableSessionId` path already requires that persisted event;
Continue pins the owning profile. This probe does not model a normal Cezar
wrong-ID path. It shows that Cursor could silently lose its own history while
still accepting a formerly valid ID. Its public print wire offers no proof
of history continuity. The human accepted this vendor-side limit on
2026-10-08. Cezar must not deliberately retry a failed resume as fresh.

Other exploratory checks: a hidden `--image <path>`
accepted a generated five-stripe PNG, and the model reported the randomized
left-to-right colors with read tools denied. A synthetic invalid
`CURSOR_API_KEY` failed authentication instead of falling through to the
logged-in account. These are partial field/account evidence, not full
qualification or regression coverage. The approved spike already proved
an enabled Superpowers skill and controlled hook in a task worktree; a
repeat with the MCP invocation read its skill. No global Cursor files were
changed by these probes.

The checked-in [`fields` probe](print-fields.json) used advertised opaque model
`gpt-5.4-mini-medium`. It rejected a nonexistent explicit model pin before any
assistant or result frame, read a random canary from an `--add-dir` root, and
identified the randomized colors of a generated PNG passed by hidden
`--image`. An exact-resume turn kept the native ID and followed its new
instruction. The probe removed its disposable worktree. This does not prove
an independently specified effort value; the model catalog advertises
effort-specific opaque IDs, including a `-low` variant that the probe admitted
successfully. The runner must map explicit effort only to an advertised ID.

The [`plugin-lifecycle` probe](print-plugin-lifecycle.json) loaded a
disposable Cursor plugin containing a local skill and a `sessionStart` hook,
plus the user-enabled marketplace Superpowers skill. Its local hook ran on
the fresh session and injected a blind phrase; the exact-resume turn read
Superpowers from Cursor's marketplace cache and recalled that phrase. Cursor
did not rerun `sessionStart` in the replacement print process. This is the
hook's once-per-logical-session behavior, not a lost hook: its context was
present on resume. A new session after removing the local plugin did not
read its skill and reported it absent. No global plugin state was changed.

The [`errors` probe](print-errors.json) set a synthetic invalid
`CURSOR_API_KEY` for one print process. Cursor rejected it instead of falling
through to the logged-in account; neither output channel echoed the key.
A separate 10 ms deadline triggered and the probe's owned process group was
gone after cleanup. These are vendor and probe-harness controls. The product
runner's mock tests now cover result/EOF ordering, ambiguous admission
and descendants that outlive the leader.

| Required capability | Invocation / reply mechanism | Read-only prerequisite | Admission and positive / negative assertion | Evidence | Outcome |
| --- | --- | --- | --- | --- | --- |
| Native delegation restriction | Strict `--allowed-tools <comma-separated proto oneof names>` per invocation; omit ten native agent entries | Invalid-name validation exits before inference; version and tool catalog are checked | Fresh allowed read succeeds; resumed denied read fails; full non-agent list succeeds; same native ID throughout. No native worker was requested | `print-delegation.json`; installed `7000.index.js`, `src/utils/exclude-tools.ts` | Pass for built-in native entry points; custom extensions/shell outside control |
| Cezar MCP tools | Local plugin `mcp.json` with `${NAME}` environment placeholders, `--plugin-dir` on each turn | Strict non-agent tool catalog and bundled controller descriptor | Inert server received the synthetic value on fresh/resume; bundled CI tool discovered on both. No blanket approval or global writes | `print-mcp.json`; bundled-controller check; native-wire regression | Binding and production regression passed |
| Human questions and plan approval | Trailing `CEZ:ASK` text, explicit `--resume <id>` reply; native `AskQuestion` rejected | CLI version and discovered model | Marker/reply and history passed; native request auto-skipped after 1 ms, with no human answer | `print-portable-ask.json`; `print-native-question.json`; `print-cezar-live.json` | Full Cezar choice and free-text path passed; native question is accepted visible limit |
| Images, model, effort and workspace roots | Hidden `--image <path>`, `--add-dir <path>`, `--model <opaque advertised ID>` | `--list-models` live catalog | Randomized PNG identified, extra-root canary read, invalid model rejected before inference, advertised low-effort ID admitted, exact resume followed new instruction | `print-fields.json`; native-wire regression | Pass for observed flags and advertised model variants |
| Resume and recovery | Explicit `--resume <id>` | Cezar resumes only an ID confirmed by a persisted Cursor session event under the owning profile | Valid-ID history recall and three-turn Cezar recall passed; a never-seen UUID returned success under the requested ID with no prior turn, so vendor-side history loss is not detectable from ID equality | `print-portable-ask.json`; `print-resume-missing.json`; `print-cezar-live.json` | Valid-ID binding and recovery integration passed; vendor history-loss limit accepted |
| Plugin scope and lifecycle | Native marketplace loading and per-invocation `--plugin-dir`; project `.claude` disable does not filter marketplace | CLI version, live enabled plugin and strict native tool catalog | Local skill and hook ran fresh; hook context and marketplace skill remained on exact resume; local skill absent after removal. `sessionStart` runs once per logical session | `print-plugins.json`; `print-plugin-lifecycle.json`; installed `index.js` marketplace loader | Pass for enabled and absent local plugin; project-local disable limit accepted |
| Account failure and process cleanup | Per-process `CURSOR_API_KEY`; bounded process group | Synthetic invalid key and 10 ms deadline | Invalid key rejected without fallback or echo; timed-out process group gone. Product runner distinguishes result from EOF and ambiguous admission in native-wire tests | `print-errors.json`; probe cleanup; native-wire regression | Vendor control and runner lifecycle tests passed |

## Product-path recheck, 2026-10-08

The installed `2026.10.01-e373342` CLI passed the controlled
`plugin-lifecycle` probe again with `gpt-5.4-mini-medium`: the marketplace
Superpowers skill was read, the local `sessionStart` hook's context was
recalled after exact resume, the native session ID stayed stable, and the
removed local skill was absent. The probe used the same restricted native
tool catalog and an inert local plugin descriptor; its disposable worktree
was removed.

A fresh Cezar task in a disposable Git repository selected `cursor-print`
without a transport setting. Its native Read calls opened Superpowers'
marketplace `brainstorming/SKILL.md` and the task worktree README. The run
parked with a real `CEZ:ASK` card. `Path: Alpha` was delivered through Cezar;
a later free-text message recalled a blind phrase from the opening turn and
ended with `CEZ:DONE`. All three turns retained the same recorded native ID,
and the run finished `done`. The bounded summary is
[`print-cezar-live.json`](print-cezar-live.json); it contains no raw transcript,
credential, plugin source, or private path.

The first attempt exposed a preflight bug: a new worktree returned a Workspace
Trust prompt before validating the intentionally invalid tool name. The
read-only check now passes `--force --trust`, matching the real print launch.
Its generated-bin regression failed four checks before the fix and passed all
six afterward. The native question auto-skip, project-local Claude disable
limit, and unobservable vendor-side history loss remain as described above.

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
node packages/cezar/scripts/probe-cursor-print.mjs \
  --model <discovered-model-id> --output-dir /tmp/cursor-print-check \
  --case fields
node packages/cezar/scripts/probe-cursor-print.mjs \
  --model <discovered-model-id> --output-dir /tmp/cursor-print-check \
  --case plugin-lifecycle
node packages/cezar/scripts/probe-cursor-print.mjs \
  --model <discovered-model-id> --output-dir /tmp/cursor-print-check \
  --case errors
```

For `native-question`, exit code `2` means the native question was
automatically skipped; this is an accepted limit under the revised design.
For `delegation`, `mcp`, `portable-ask`, `fields`, `plugin-lifecycle` and `errors`, exit code `0` means their named
binding passed. For `plugins`, exit code `2` reproduces the accepted
project-local limitation on this installed plugin state. For
`resume-missing`, exit code `2` reproduces the accepted vendor history-loss
limit. Exit code `1` means a probe is inconclusive.
The script saves
only a bounded, allowlisted JSON summary and removes its temporary worktree.
A future CLI may change native-question behavior; requalify it before
offering native answer handling. Requalify all other rows and the final Cezar
invocation before widening the qualified build. Existing Cursor ACP sessions
and unqualified installations retain their marketplace-plugin limitation.

## Canonical model selection regression, 2026-10-13

The migration in hearsay-tools/cezarion#923 left fresh print admission reading
legacy `--list-models` aliases while the picker retained canonical ACP IDs.
Task `f142bec7-607c-4088-8866-70372ee05ab4` selected `grok-4.6` / `high` and
failed before inference. The fix for hearsay-tools/cezarion#987 reads the selected
account's read-only `cursor/list_available_models` metadata when an explicit ID
is absent from the legacy listing.

Live patched `CursorRunner` sessions on the same qualified CLI succeeded for
`grok-4.6` / `high`, `gpt-5.4-mini` / `high`, and `auto-smart`. Each returned
`CEZ_CURSOR_MODEL_OK` over print with the native delegation entries excluded.
The allowlisted evidence is [`print-model-selection.json`](print-model-selection.json).
Grok used `grok-4.6[effort=high,fast=true]`; GPT used
`gpt-5.4-mini[reasoning=high]`. Native parameter keys and other defaults come
from that account's ACP metadata. A partial `grok-4.6[effort=high]` was rejected
by the CLI, so print preflight builds the complete advertised selection instead
of guessing an alias or appending a universal effort key. The probes started
small fresh sessions; the original failed issue task was not resumed.

`cursor-model-selection.test.ts` drives native account discovery through the
real transport facade and print runner, records native argv, and checks
follow-up and exact Continue selection. Stashing only the capabilities fix made
all canonical Grok/GPT/Auto admission cases fail with the original
not-advertised error; restoring it passed. Unknown selections, missing account
access, unsupported effort and incomplete defaults still refuse inference.

## Pre-inference model rejection recovery, 2026-10-13

After hearsay-tools/cezarion#988 shipped, the original task successfully used
the canonical Grok selection. Its CI continuation at 09:44:43 UTC nevertheless
exited 1 with `Cannot use this model: grok-4.6[effort=high,fast=true]` before
any init, work or result frame. Automatic Continue retried the same model,
account and native session one second later and succeeded. The installed
CLI gives parameterized model metadata a two-second deadline; the history
does not establish whether that particular request timed out or failed.

The hearsay-tools/cezarion#994 fix retries that exact early rejection once.
The replacement process reuses prepared argv, stdin, environment, image
paths and any resume ID. It retains the pending input receipt and the logical
session deadline. Init, model work, result, provider error, cancellation,
signal termination or a different startup error prevents replay. A second
rejection surfaces the leading model diagnostic even when the catalog tail
is long. No alias, model fallback or fresh-session fallback is introduced.

`cursor-print-model-retry.test.ts` uses the native print mock to pin fresh,
opening Continue and follow-up retries, the two-attempt bound, pending
receipt, identical input and cancellation guards. The initial three recovery
tests failed against the unchanged runner. These controlled regressions
reproduce the observed wire failure; they do not claim a forced live metadata
timeout was reproduced.

## Newer builds and self-updates, 2026-10-19

On 2026-10-18 a research run started the CLI, and it updated itself from
`2026.10.01-e373342` to `2026.10.16-e3cb207`. The exact-build check above then
sent every new Cursor task to ACP (hearsay-tools/cezarion#1257). The new build
drops `adopt_tool_call`, renames the two PR code-tour tools and adds ten tools.
Its live `Expected one of:` list is
[`print-tools-2026.10.16-e3cb207.txt`](print-tools-2026.10.16-e3cb207.txt).

The owner chose a cheap pre-inference rule over a per-build probe record.
A build qualifies for print when its version is a dated build on or after
`2026.10.01-e373342`, the invalid-tool probe returns its catalog, and the
catalog lists every core tool (`CORE_CURSOR_PRINT_TOOLS`). Restricted turns
allow the qualified safe tools the build still advertises, so new entries stay
denied. Exact resume and the no-fresh-fallback rule are unchanged. The stream
wire of a newer build is not re-probed. The opt-in probes above remain the
evidence for widening the safe catalog.

Both installed builds accept the hidden `--disable-auto-update` option. Every
Cursor process cezar starts now passes it, and the probe script does too.
A build that rejects it exits 1 with commander's `unknown option` line before
any work, and cezar reruns the same command once without the option.

Live check on `2026.10.16-e3cb207`: the preflight returned supported with 57
allowed tools. A restricted `CursorRunner` session in a disposable repository
selected `cursor-print`, reported the marketplace Superpowers `brainstorming`
skill as available, and ended without an error. The `agent` link still
pointed at `2026.10.16-e3cb207` afterwards.
