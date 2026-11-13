# One mock scenario module and six wire encoders

Source: candidate 3 of the 2026-11-03 architecture review (cezar task f5410885).
Campaign task: d18f6eb8. Baseline: `main` at `bc5764da7`.

## Goal

Today each fake-agent scenario is written once per native mock, in that mock's
wire encoding. A workflow feature that changes what the fake agent does must edit
up to six mocks. After this work:

- One module, `packages/cezar/scripts/mock-scenario.mjs`, decides what the fake
  agent does for every shared `mock:` scenario: its text, reasoning, tool calls,
  cezar tool calls, waits, sleeps and turn end.
- Each runner mock is an encoder for its own wire. It turns the module's steps
  into native frames, and it keeps its native acknowledgement, rejection,
  failure and steering encoding.
- One module, `packages/cezar/scripts/mock-lifecycle.mjs`
  (hearsay-tools/cezarion#1529), owns the no-progress stall, the atomic pid
  write and the release wait.

A workflow feature then changes one scenario script, and each encoder is checked
once against its real runner and mapper.

## Evidence

Measured on `main` at `bc5764da7`.

### Size

| Mock | Lines | Process model |
|---|---:|---|
| `mock-claude.mjs` | 958 | one process per session, stream-json on stdin |
| `mock-codex-app-server.mjs` | 892 | one process per session, JSON-RPC on stdio |
| `mock-opencode-serve.mjs` | 1,169 | one HTTP server per process, SSE events |
| `mock-pi-rpc.mjs` | 651 | one process per session, RPC on stdio |
| `mock-omp-rpc.mjs` | 749 | one process per session, RPC on stdio |
| `mock-cursor-print.mjs` | 246 | one process per turn; cross-turn state in a file under `.ai/cezar/mock-cursor-print/` |
| **Total** | **4,665** | |

No function in these files is above complexity 20 (largest: 18).

### Change coupling

From 2026-09-15 to 2026-11-03, 70 commits changed these six mocks. 28 of them
changed four or more mocks. Workflow features that forced six-mock edits:
a0b806246 (hearsay-tools/cezarion#1662), 26e62e6f0 (hearsay-tools/cezarion#2446),
463a5bf01 (hearsay-tools/cezarion#1240), faa0c92ab (hearsay-tools/cezarion#1262),
1091b54f2 (hearsay-tools/cezarion#933). The review's "37 of 70 changed no runner"
depends on how a runner change is counted; with "touched a `src/core` runner,
transport or mapper file" the count is 29 of 70. Either way, many
mock edits do not follow a runner change.

### Scenario inventory

C Claude, X Codex, O OpenCode, P pi, M OMP, U Cursor print. A scenario in four or
more mocks is **shared**; this campaign moves the shared scenarios.

| Scenario | C | X | O | P | M | U | Notes |
|---|---|---|---|---|---|---|---|
| `agent-echo` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `autonomous` (+ `-cap`, `-cezar-ask-cap`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | content already in `mock-autonomous.mjs` |
| `cezar-ask` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Claude: a marker inside the default reply |
| `cezar-done` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Claude: a marker inside the default reply |
| `cezar-tool` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | content in `mock-ci-tool.mjs` |
| `ci-wait` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | content in `mock-ci-tool.mjs` |
| `crash-stderr` (+ variants) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | content in `mock-runner-crash.mjs` |
| `deferred-turn-start` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | delay in `mock-deferred-turn-start.mjs` |
| `hold` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `hold-cezar-ask` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `hold-cezar-done` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `hold-gated` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `multi-pr-refs` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | content in `mock-multi-pr.mjs` |
| `no-progress-*` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | hearsay-tools/cezarion#1529 |
| `silent-tail-*` and the final-message nudge | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | content in `mock-silent-tail.mjs` |
| `turn-messages` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | decoder in `mock-turn-messages.mjs` |
| `ack-only` | ✓ | ✓ | ✓ | ✓ | ✓ | – | a per-turn process cannot hold an ack |
| `busy-progress` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | OMP matches it in the same entry as `no-progress` |
| `provider-error` | – | ✓ | ✓ | ✓ | ✓ | ✓ | Claude uses the failure control and `auth-error` |
| `resume-cezar-done` | ✓ | ✓ | ✓ | ✓ | ✓ | – | Cursor: a resume origin in its state file |
| `steer-tool` | ✓ | ✓ | ✓ | ✓ | ✓ | – | wire limit: no steering in print mode |
| `steer-late` | – | ✓ | ✓ | ✓ | ✓ | – | |
| `subagent-after-park` | ✓ | ✓ | ✓ | – | ✓ | – | |
| `cezar-wait` | ✓ | – | – | ✓ | ✓ | – | inside the default reply |

About 60 more tokens exist in only one to three mocks (approvals, native asks,
permissions, Codex channels, OMP local commands, Cursor print modes). They encode
one wire's own behavior and stay in their mock.

### Copied helpers

| Helper | Copies |
|---|---|
| `watchdogStall` | C, X, O, P, M; inline in U |
| `watchdogWritePid` | all six |
| `waitForMockRelease` | C, X (adds a `suffix`), O, P, M; `waitForRelease` in U |
| `afterParityPark` | C, X, O, M |
| "Keep this fixture standalone" comment | C, X, O, P. No test copies a mock any more (`cez/native-mock-source`, hearsay-tools/cezarion#1479). |

### Drift in shared scenarios

The copies already differ. Examples:

| Scenario | Difference |
|---|---|
| `hold` | C, P, M: sleep 250, text, sleep 250, end. X, O: one 250 ms timer, then text and end. U: sleep 500, then the default reply |
| `hold-cezar-ask` | release fallback 400 ms in C, X, P, M, U; 250 ms in O |
| `busy-progress` | final text "busy complete" (C, P, U), "busy progress finished" (M) |
| `cezar-done` | text "parity done: the task is complete" (P, M), "Done." (U); C appends the call to its default reply |
| `steer-tool` | final text "steer tool done\nsaw: …" (C, X); "steer tool done" (P, M) |
| `multi-pr-refs` | the extra frames differ: reasoning, a subagent message, a child message, or none |
| `no-progress` | `mock:gate-prompt-ack` only in P and M; U's stall is inline, has no `input-closed` variant, and its `ignore-term` keeps the old listener and has no 12 s backstop; O closes input by flag, the others by `closeSync(0)` |

## Design

### Constraints

- GLOSSARY "Native failure control" and "Native delivery control": each mock keeps
  its native rejection, acknowledgement and failure encoding. The failure state
  survives mock subprocess restarts. The real runner and its transport stay in use.
  `mock-failure-control.mjs` and `mock-delivery-control.mjs` do not change.
- ADR 0020 and `docs/areas/runners.md`: native mock-wire parity runs for every
  `RUNNER_IDS` entry. An injected normalized event is not coverage.
- `cez/native-mock-source` (hearsay-tools/cezarion#1479): no test reads, splices or
  swaps mock source. The new modules are ordinary imports of the mocks.
- `CEZ_DRY_RUN=1` runs all six mocks from the published package. The reply to a
  prompt without a `mock:` token is user-visible dry-run behavior. It stays
  byte-identical for every runner. It may move into the scenario module only with
  its per-runner text unchanged.
- Event-loop order: today a mock's synchronous frames go out in one tick, and
  optional modules load only when configured. The player must not add an `await`
  between two synchronous steps.

### The scenario module

`packages/cezar/scripts/mock-scenario.mjs` exports:

```js
/** The shared scenario a prompt selects, or undefined. First match wins. */
export function scenarioFor(prompt, context);
/** Runs a scenario's steps through one encoder. Awaits only asynchronous steps. */
export function play(scenario, encoder);
```

- `context` carries `runner` (a `RUNNER_IDS` value), `lifecycle(call)` (the mock's
  cezar tool call, as `mock-autonomous.mjs` receives it today), and `toolPrompt(prompt)`,
  `ciPrompt(prompt)` and `crash(prompt)` as mock-supplied wire boundaries. The module
  knows no runner's wire config. It also carries `session` (cross-turn state; in memory,
  or Cursor print's state file) and `unsupported` (the scenario names this wire cannot
  carry; see below).
- A scenario is `{ name, beforeFailure, steps }`. `beforeFailure` says whether the
  scenario runs before the mock's native failure control. The module owns the match
  order, including the substring order that keeps `mock:hold-cezar-done` from
  matching `mock:hold`.
- The module imports the existing content modules (`mock-autonomous.mjs`,
  `mock-multi-pr.mjs`, `mock-silent-tail.mjs`, `mock-turn-messages.mjs`,
  `mock-ci-tool.mjs`, `mock-runner-crash.mjs`, `mock-deferred-turn-start.mjs`) and
  `mock-lifecycle.mjs`. They stay where they are.

### The encoder seam

A step is a plain object. The encoder has one method per step kind:

| Step | The encoder emits |
|---|---|
| `open` | the native turn start. The encoder alone orders it against the mock's acknowledgement: OpenCode sends its HTTP acknowledgement after the SSE turn events in its delayed-ack cases (`autonomous-cap`, `f7-delay-ack`), and that order stays |
| `effect(run)` | nothing; runs code at play time, with no encoder method. An asynchronous effect defers the next step; a synchronous effect does not |
| `text(parts)` | one assistant message; `parts` are its deltas. A part may be a function of `lifecycle`, so a cezar tool call runs before the text goes out |
| `reasoning(text)` | one reasoning or thinking block |
| `toolStart(call)` / `toolEnd(call)` | a tool call and its result; `call` has `id`, `name`, `input`, `output`, `isError` |
| `child(steps)` | child (subagent) work, where the wire has it |
| `progress` | one native progress signal with no content |
| `sleep(ms)` | nothing; the player waits |
| `release(fallbackMs)` | nothing; the player waits on `CEZ_MOCK_RELEASE_FILE` through `mock-lifecycle.mjs` |
| `park` | nothing; the player waits on the prompt's `parity-release=` path |
| `readSteers` | the steers the wire admitted during the turn, in its native order |
| `stall` | hands the turn to `mock-lifecycle.mjs` `stall()` |
| `end` | the native turn end (usage, result frame, idle, settle) |

Wire details stay in the encoder: usage shapes, ids, `threadId`, uuids on a result,
OpenCode's idle timer, the Claude replay frame. The mock still owns: the line or
request parser, acknowledgement and delivery control, the failure control check at
the point the scenario's `beforeFailure` names, steering admission, the untokened
default reply, and every token that is not shared.

`play` returns `handled` or `continue`. A scenario whose effect lets the turn go on
returns `continue`, and the mock goes on with its own dispatch, as today:
`mock:crash-stderr-clean` writes its diagnostic and the mock then sends its normal
reply. A step can end the process (`crash-stderr`, `crash-stderr-single`); then
`play` never returns.

`unsupported` replaces silent gaps. A wire that cannot carry a step (Cursor print:
no held ack, no steering, no child work) names those scenarios. `scenarioFor` then
skips them, so the prompt falls through as it does today. Each entry must match a
declared `PARITY_EXEMPTIONS` entry or an existing fall-through.

### Unifying drift

The copies differ (see Evidence). A scenario script has one version. For each
difference, the slice that adopts the script picks one version by this rule:

1. The parity catalog row in `harness-parity-core.testkit.ts` (`SCENARIOS`) decides
   what the mock must do.
2. A detail the catalog does not name takes the version most mocks use, unless a
   test pins another version; then the pinned version wins.
3. A test assertion never changes to fit a unified script. If a test pins two
   different versions on two runners, the scenario keeps a per-runner parameter,
   and the slice reports it.

The timing parameters this rule's point 3 produced are Codex F11
(`silent-tail-late-turn-start`: release before turn start, then the `.content`
release before text) and Cursor F10 (`silent-tail-slow-done`: release the tail
through the release file rather than a sleep). Cursor also keeps the `cezar-done`
text `Done.` plus the unchanged lifecycle note, pinned by
`packages/cezar/test/e2e/cursor-print.test.ts:43`; other runners keep the shared
completion text. All retain their pinned tests. The `tool-tail` scenario and the
Cursor F3 scenario lost their last parity rows with F1–F6 and were deleted
(hearsay-tools/squawk#3020).

Unification changes test-only fixture output, never what a user sees: shared
scenarios start only from a `mock:` token, and the untokened reply stays
byte-identical.

### Behavior-neutral proof per slice

1. **Wire diff.** It shows exactly what a slice changed in each mock's output. It
   proves equivalence except for the drift items the PR lists; it does not prove
   that a listed drift item is harmless (steps 2 and 3 do).
   - **Recorder.** Slice 2 adds it. When `CEZ_MOCK_WIRE_FILE` is set, a mock
     appends everything it sends to the runner: stdout and stderr, including the
     raw writes of `mock-runner-crash.mjs` (`writeSync`) and child output in
     held-pipe mode, and for OpenCode the SSE events and every HTTP response
     (status, body), such as `acknowledgePrompt`. Each record names its channel.
     Normalize ids, uuids, timestamps, temp paths, pids and allocated ports
     (the OpenCode mock prints its listen port on stdout). A child process that
     inherits the mock's pipes (`crash-stderr-held-pipe`) writes past the
     recorder; its recipe records the mock's own writes and the exit, and the
     existing crash-stderr tests keep covering the child's output.
   - **Recipes.** The evidence script owns one recipe per shared scenario. It does
     not rely on the `HARNESS_ADAPTERS` prompts: the catalog has no `agent-echo`,
     `ack-only` or `deferred-turn-start` entry, maps `cezar-ask` to
     `mock:cezar-tool`, and maps `resume-cezar-done` to `ask-resume`. A recipe
     gives:
     - the opening prompt, with the token each mock matches directly
       (`mock:cezar-ask`, a base64 payload after `mock:turn-messages:`, a
       `parity-release=<path>` for `subagent-after-park`);
     - the follow-up inputs and their timing: the answer for `resume-cezar-done`,
       the final-message nudge for each `silent-tail-*` variant, a steer for
       `steer-tool` and `steer-late`;
     - the gates the script releases (`CEZ_MOCK_RELEASE_FILE`, the park path) and
       when;
     - the end condition: the recipe's own last expected record, not the first
       native turn end. By default it is the native turn end. Exceptions:
       `subagent-after-park` ends on the child events sent after the park
       release; the delayed-acknowledgement cases end on the acknowledgement;
       `ack-only` ends on the acknowledgement; `no-progress-*` ends when
       `watchdog.pid` exists and the frames the mock sends before it stalls are
       recorded (the gated variant in pi and OMP writes the pid before its
       acknowledgement and turn start); the terminating `crash-stderr` variants end on the process
       exit, recorded with its code or signal; `crash-stderr-clean` does not exit
       and ends on the native turn end. Then a stop and teardown, with no wait
       longer than the scenario's own bound;
     - the delayed-acknowledgement cases (OpenCode `autonomous-cap` and
       `f7-delay-ack`), so the order of acknowledgement and turn events is in the
       transcript;
     - the untokened prompts too (first turn and one follow-up), which prove the
       dry-run reply is byte-identical.
     A recipe a wire cannot run (Cursor print has no steering) is listed as a gap,
     not skipped in silence.
   - **Use.** The wire diff applies from slice 3 on: its base is `main` after
     slice 2, which has the recorder. Slice 1 changes stall behavior on purpose and
     is proven by its own tests and red proof. Slice 2 adds the recorder and is
     proven by unchanged tests with `CEZ_MOCK_WIRE_FILE` unset and by two
     identical recordings on its head. A slice records on its base and on its
     head and diffs the two. Every
     difference must be a drift item listed in the PR body with the rule that chose
     it. An encoder slice with no listed item has an empty diff.
2. **Parity.** `npm run test:parity` and the touched runner's harness parity files
   pass with unchanged assertions.
3. **Mapper and dry run.** The runner's `*-ui-mapper.test.ts`, `npm run
   test:package` after `npm run build` (dry run from the packed tarball), and the
   browser specs `npm run test:e2e:affected` selects.
4. **Guard.** A lint `SourceRule` under `packages/cezar/src/lint/`, beside
   `native-mock-source.ts`. The lint runner reads the scripts, so no test reads mock
   source and `cez/native-mock-source` holds. The rule applies to
   `packages/cezar/scripts/mock-*.mjs` other than the shared modules. It reports a
   mock that imports `mock-scenario.mjs` and still names a shared token in a string
   or regex literal. It must read literals, so it cannot use `blank()` from
   `lint/blank.ts`, which erases them; comments stay ignored. Synthetic cases pin
   what it refuses and allows, as `mock-source-boundary.test.ts` does for
   `cez/native-mock-source`. The final encoder slice, hearsay-tools/cezarion#2774 (PR
   hearsay-tools/cezarion#2818), makes the import required for all six
   `RUNNER_IDS` mocks. An exhaustive runner-to-mock map and a runner-key test
   prevent a new runner from bypassing the guard. Helpers remain optional;
   comments and sample strings do not count as imports. The rule ships with a red proof
   (`docs/sdlc/regression-proof.md`): a shared token added back to the pi mock.

## Slices

Each slice lands as its own PR into `main`.

| # | Issue | Work type | Change | Depends on |
|---|---|---|---|---|
| 1 | hearsay-tools/cezarion#1529 | feature (bug fix, plan approved on the issue) | `mock-lifecycle.mjs`: stall, pid write, release wait; Cursor print backstop, `gate-prompt-ack` for every mock, loud unsupported `input-closed`. The readiness-order fix and its `RUNNER_IDS` cell already landed in c0df8224b (hearsay-tools/cezarion#1628) | none |
| 2 | hearsay-tools/cezarion#2768 | cleanup (test tooling) | `CEZ_MOCK_WIRE_FILE` recorder for everything a mock sends (stdout, stderr including the crash helper's raw writes, OpenCode HTTP and SSE); recipe script; `.env.example` | none; PR opens after 1 merges (hot files) |
| 3 | hearsay-tools/cezarion#2769 | cleanup | `mock-scenario.mjs` with the player and every shared script; pi becomes the first encoder; the guard; `afterParityPark` moves in; docs | 1 and 2 merged |
| 4 | hearsay-tools/cezarion#2770 | cleanup | OMP encoder | 3 merged |
| 5 | hearsay-tools/cezarion#2771 | cleanup | Codex encoder | 3 merged |
| 6 | hearsay-tools/cezarion#2772 | cleanup | Claude encoder | 3 merged |
| 7 | hearsay-tools/cezarion#2773 | cleanup | OpenCode encoder | 3 merged |
| 8 | hearsay-tools/cezarion#2774 | cleanup | Cursor print encoder, with its `unsupported` list and file-backed `session` | 3 merged |

Slices 4 to 8 change one mock each and can run in parallel. Slice 3 defines the
whole step vocabulary from the inventory above, so an encoder slice should not need
to change `mock-scenario.mjs`. When it does, the worker asks the coordinator first.
Slice 8 (hearsay-tools/cezarion#2774, PR hearsay-tools/cezarion#2818) lands
the final guard step: all six runner mocks must import the scenario module.

Slice 3 also updates step 8 of `AGENT_PROTOCOL.md` § 10 (a new runner's mock is an
encoder over `mock-scenario.mjs`), and adds two GLOSSARY entries, "Mock scenario"
and "Wire encoder". Slice 1 adds the "No-progress stall" entry that
hearsay-tools/cezarion#1529 carries.

## Acceptance

- No runner mock implements a shared scenario token itself; the lint rule enforces it.
- One copy each of the stall, the pid write, the release wait and the park wait.
- The untokened reply of each mock is byte-identical to `bc5764da7`.
- Every existing test passes with unchanged assertions, including all parity,
  mapper, package and browser suites CI runs.
- Each encoder PR records its wire diff and the drift item behind every difference.
- Measured after the last slice: total lines of the six mocks and of the new
  modules, against 4,665.

## Out of scope

- Runner-specific tokens (approvals, native asks, permissions, Codex channels,
  OMP local commands, Cursor print modes).
- `mock-failure-control.mjs`, `mock-delivery-control.mjs` and each mock's native
  failure, rejection and acknowledgement encoding.
- Runner, transport and mapper source under `packages/cezar/src/core/`.
- Test assertions. A test that needs a change is a finding for the coordinator.
- An in-process mock wire (hearsay-tools/cezarion#2517, closed as not planned).

## Case tables

None of the template's case tables applies: no run state, cross-run relationship,
tool grant, worktree write, detached process or restored client state changes.
Slice 1 keeps the existing `leftover` children and their own exit backstops.
