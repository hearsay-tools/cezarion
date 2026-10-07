# Cursor print transport qualification for fork #590

Checked on 2026-10-07 with Cursor CLI `2026.10.01-e373342`, model
`gpt-5.4-mini` from the live Cursor catalog, in a disposable Git worktree.
The print transport is **blocked**. No Cezar default transport change is
qualified by this record.

## Mandatory gate

`packages/cezar/scripts/probe-cursor-print.mjs` invoked the native CLI with
`-p --force --trust --output-format stream-json --model gpt-5.4-mini
--exclude-tools taskToolCall`. The prompt requested a native question with
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
native question parity too.

| Required capability | Invocation / reply mechanism | Read-only prerequisite | Admission and positive / negative assertion | Evidence | Outcome |
| --- | --- | --- | --- | --- | --- |
| Native delegation restriction | Candidate hidden `--exclude-tools taskToolCall`; no verified denial | Vendor source shows the flag maps to a tool exclusion header | A native question probe excluded the task tool but did not attempt delegation; it cannot establish this gate | Installed `7000.index.js`, `src/utils/exclude-tools.ts` and `src/utils/exclude-tools-headers.ts` | Unqualified; no native worker was launched |
| Cezar MCP tools | No qualified per-session binding | `agent --help` has no session MCP argument; plugin-based injection was not tested | Must show the bundled server on fresh and resumed turns without global config writes or credential values on disk | No probe; halted at the question gate | Not run |
| Human questions and plan approval | Native print `askQuestionInteractionQuery` | CLI version and discovered model | Request emitted; CLI rejected it as skipped after 1 ms; no choice, free text or rejection from a human could be delivered | `print-native-question.json`; vendor `src/run-agent.tsx` | **Blocked** |
| Images, model, effort and workspace roots | To be qualified | Live model catalog included `gpt-5.4-mini`; effort not pinned | Must preserve every currently honored field | No probe; halted at the question gate | Not run |
| Resume and recovery | Explicit `--resume <id>` from the approved spike | CLI exposes `--resume` | The earlier spike proved native ID/history only; Cezar continuation/recovery was not tested | Issue #590 Plan handoff | Not qualified |
| Plugin scope and lifecycle | Native print marketplace loading | Earlier spike used this CLI version | Earlier spike proved Superpowers skill read and a controlled plugin hook; project enablement, disabled plugins and lifecycle remain untested | Issue #590 Plan handoff | Not qualified |
| Process ownership and errors | Bounded print process group | Probe used a 45-second deadline and group termination | The probe completed and its disposable worktree was removed; full runner process/error behavior remains untested | Probe command and cleanup check | Not qualified |

## Recheck

Discover a current Cursor model, then run the opt-in probe from this repo:

```sh
node packages/cezar/scripts/probe-cursor-print.mjs \
  --model <discovered-model-id> --output-dir /tmp/cursor-print-check \
  --case native-question
```

Exit code `2` means the native question was automatically skipped and the
gate remains blocked; `1` means the probe is inconclusive. The script saves
only a bounded, allowlisted JSON summary and removes its temporary worktree.
A future CLI must demonstrate that a human choice, free text and rejection
reach the native question before this gate can pass. Requalify all other rows
and the final Cezar invocation before changing the default. The implementing
owner of fork #590 owns that follow-up. Existing Cursor ACP sessions and the
default ACP path retain their known marketplace-plugin limitation meanwhile.
