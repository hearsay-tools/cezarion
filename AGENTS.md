# AGENTS.md — working in this repository

cezar is a **parallel coding-agents orchestrator**: a local cockpit (CLI + browser GUI) for running and tracking AI coding-agent tasks in a repo. You type a task, pick a workflow and a backend — Claude Code, Codex or OpenCode (experimental), or a mix per step — and watch it work live: steps, tool calls, tokens, diffs. Each task runs in its own git worktree, ends at a review gate (never auto-merges), and can be pushed as a draft PR through `gh`. Everything is local: no accounts, no database server, no cloud — state lives under `.ai/cezar/`: the run store is one embedded SQLite file (`runs.db`, `node:sqlite`, built into Node), the rest is plain JSON, NDJSON and Markdown. The server stack stays deliberately small: strict TypeScript (ESM, Node 24.15+), Hono + SSE, Zod at every boundary, and YAML workflows. The cockpit is React 19 + Vite + Tailwind v4 + shadcn/ui, compiled to static assets (the legacy vanilla UI was retired in R7). Every module is meant to be read in one sitting.

Architecture decisions live in [docs/adr/](docs/adr/). Consult the relevant records before changing a mechanism.

## Issue and PR citations

This fork is `hearsay-tools/cezarion`; upstream is `open-mercato/cezar`.
Cite issues and PRs as `hearsay-tools/cezarion#N` / `open-mercato/cezar#N`,
or as `fork #N` / `upstream #N`. A repository-qualified GitHub link is also
unambiguous. Never infer the tracker from the number or the current remote:
upstream history predates the fork and both trackers reuse numbers. Check the
source link, tracker title and git history when attribution is uncertain.

Historical documents may retain literal citations under a local source note
identifying their repository and snapshot. Generated upstream commit titles and
structured ledger fields follow the source attribution in
[the ledger guide](.ai/upstream/README.md#citation-provenance); edit the canonical
YAML and regenerate `LEDGER.md`. Preserve example protocol markers, test filters,
UI sample numbers, spec numbers, colors and shell syntax. These are not citations.
New prose in an archive must still qualify its references individually.

## Zero config

cezar ships no config file the user must create and no setting they must set before it works. Every capability is discovered from what is already there — the repo, the environment, `gh`, the running processes — or it degrades quietly to a smaller cezar. `.ai/cezar/config.json` is optional and every key has a working default; `.env` is never auto-loaded.

New state may be **written**, never **required**: `.ai/cezar/`, `~/.cache/cez/`, `~/.cezar/`. Delete any of them and cezar rebuilds what it needs on the next run. State that a user must author, migrate, or repair is not state — it is configuration, and it needs a reason. One deliberate exception inside that rule: the project registry keeps a `~/.cezar/config.json.bak` snapshot, so deleting `config.json` alone restores instead of resetting — delete the `~/.cezar` directory for a true reset.

Practical rules:

- When a feature seems to need configuration, the design is wrong. Discover it, or default it.
- Features that widen exposure or cost (network, other processes) are opt-in behind a `CEZ_*` flag, off by default — the zero-config default is also the safe default.
- Owner-approved exception: project warm-up is default-on (hearsay-tools/cezarion#667). After the server listens it builds every other registered project's context one at a time, which runs recovery and so may resume interrupted runs and spend tokens in projects not yet opened; it skips projects another live cockpit owns and single-project mode, claims each warmed project's `cockpit.lock` for the process lifetime, and `CEZ_PROJECT_WARMUP=0` restores purely lazy builds.
- A missing dependency, an absent peer, a read-only home: degrade to a smaller working cockpit, never fail the boot.
- Prefer a proxy-free, daemon-free mechanism when one exists — and when it doesn't, keep the mechanism invisible: no process to manage, no port to remember, no file to edit.
- Never trade a working default for a knob.
- Adding, renaming, or removing a `CEZ_*` env var — or changing what its default does — MUST update `.env.example` in the same commit (and the README env table when the var is user-facing). `.env.example` is the env contract's single documentation surface; an undocumented env var is a bug.

## Changing a mechanism that already works

Replacing working behavior is the highest-risk change in this repo, and it fails in a
characteristic way: the new mechanism is correct, the tests are green, the spec is
thorough — and the DEFAULT path quietly lost a guarantee nobody wrote down. open-mercato/cezar#810 and open-mercato/cezar#811
are the worked examples; both shipped a well-specified improvement that left the
zero-config user worse off than before.

**Name what the old mechanism was load-bearing FOR, not what it was for.** Those are
different questions. `IDLE_TIMEOUT_MS` read as session hygiene, and open-mercato/cezar#661 removed it from
the monitoring branch for a good reason (it was closing live sessions mid-CI and recording
them as `done`). It was also the only liveness bound on `CEZ:MONITORING` and the only
reason a parked monitor eventually stopped holding a `maxParallel` slot. Neither
dependency was named in the spec, so neither was replaced, and `monitoring` became a state
with no exit. Before deleting a timer, lock, cap or timeout, grep for everything that
reaches a terminal state *because* of it.

**A replacement that ships OFF is not a replacement.** Diff the default path, not the
feature. The question is always: *with every new knob at its shipped default, what does
the old scenario do now?* If the answer is "nothing", the change removed a mechanism and
added a setting. A spec's "Resolved assumptions" table answering a COST question with
"opt-in, default null" is not an answer to whether the zero-config path still works —
cost-safe and functional are separate reviews. See § Zero config: *never trade a working
default for a knob*.

**Enumerate the transitions out of every state you add or keep.** "Who fires this?" is the
question that finds these bugs in one step. A parked run has exactly three wake sources —
a user message (`deliverMessage`), the autonomous nudge (turn-end only), and the monitoring
wake timer. Cezar has no process-exit callback, no CI webhook and no sub-agent-completion
event, so a state whose only on-by-default exit is "a human types something" is a dead end,
however well it renders.

A spec or plan that adds or changes a run state MUST carry a **Transitions out**
table, reviewed with the spec or plan before implementation starts. Cover every
state the change adds or keeps, with one row per exit: **State | Trigger | Who or
what fires it | Behavior at shipped defaults**. A state whose only default exit
is a human action must say so explicitly in the table; a state with no default
exit must also say so. For example,
[the unified-waits spec](.ai/specs/2026-10-17-unified-waits.md) needs this table:
its list of input mechanisms and exits does not enumerate the transitions out of
every state the change retains.

**Enumerate tool-list kinds before changing a runner's tool flags.** A spec or
plan that changes how `allowedTools` or `bashAllowlist` maps onto a runner's tool
flags MUST carry a **Tool-list kinds** table, reviewed with the spec or plan
before implementation starts. Use one row per kind, for each affected runner:
**Input kind | Emitted runner flags | Callable built-in, MCP and extension tools
at shipped defaults**. Show effective tool access, not only the flags sent;
state when a runner ignores a restriction or cannot distinguish two input kinds.

Cover all of these kinds: `allowedTools` unset; the step default from
`allowedToolsForStep`; a list inherited from another runner's default (such as a
pi worker spawned from a Claude parent); a hand-written copy of the default
list; the default plus an extra built-in or custom name; the default plus an
`mcp__` name; a narrowed list; an empty list; and a list with a `bashAllowlist`.

hearsay-tools/cezarion#1305 and hearsay-tools/cezarion#1360 are the worked
example: the pi plan compared rules for recognizing the default list without
enumerating their inputs. Reviews then found extra MCP names, extra non-default
names and hand-written default copies with different access implications. The
table makes those cases explicit for design review; it does not decide which
ones should share a policy.

**Commit an outcome with what it depends on, or after it.** A write that records
an outcome (`delivered`, `charged`, `settled`, `answered`) must commit atomically
with the write holding what that outcome needs, or after that write commits.
Check every crash boundary between the writes: a delivered answer must already
be saved, and a delivered automatic wake must already be charged. A best-effort
write in a cleanup path must never throw past the cleanup and prevent it from
finishing. Test the boundary by reading the **committed row** at the point a crash
would hit, rather than checking only the final state or the in-memory object.
hearsay-tools/cezarion#1250 is the worked example: its review caught a wake delivered
without its charge, a counter write blocking Finish, and a Continue settling its
human wait before saving `continuationMessage`.

**Test the path with no live session.** When changing a path that reads
`this.active.get(runId)`, add a test with no session. Restart recovery and
scheduler continuations can reach the path before a session exists; an absent
entry must still produce the required durable outcome and a usable next step.
hearsay-tools/cezarion#1250 is the worked example: recovery used wording that assumed
cezar tools, a timer resumed a continuation without its tool controller, and a
wake at the budget cap cancelled its timer without opening the budget wait.

**Find every construction site of a shared in-memory object — grep the TYPE, not the
field.** `ActiveRun` is built in `execute` AND in `runContinuation`; open-mercato/cezar#811 populated
`state.skills` in the first only, so registry `/skill` expansion worked on new tasks and
silently failed on every Continue and every restart recovery. The same shape recurs in the
two near-identical turn-end handlers in `workflows/run.ts` (streaming and non-streaming):
a lifecycle change applied to one of them ships half a fix. When you add a field that a
delivery path reads, add it everywhere in the same commit or route both sites through one
helper.

**A fail-open helper needs a populated-input guarantee, or it lies.**
`expandRegistrySlashSkill` returning its input unchanged on no-match is right on its own —
a backend's own slash commands must survive. Against an empty registry that same branch
turns "cezar never loaded the list" into a confident user-facing "Unknown skill". Pair
every silent pass-through with a test that pins the *empty/absent input* case.

**Prove the regression test fails without the fix.** Pin the pre-fix commit as
`proof_base` and record the command, expected failure and fixed pass. A test written
after the diagnosis can pass against the bug; a green-either-way test does not prove
the fix. Keep the guard tests that pass both ways — they pin behavior you did NOT
want to change (park mode stays reachable; unknown slashes stay untouched) — but
know which is which. Do not use the shared stash stack for this proof.

For a **source fix**, run the new regression test against the old source in a
disposable worktree. From the repo root, replace the example commit and paths:

```bash
proof_base=<pre-fix-commit>
proof_repo=$(git rev-parse --show-toplevel)
proof_dir=$(mktemp -d "${TMPDIR:-/tmp}/cezar-red-proof.XXXXXX")
git worktree add --detach "$proof_dir/tree" "$proof_base"
(cd "$proof_dir/tree" && pnpm install --frozen-lockfile)
# Copy the current regression test, plus any new test helpers/fixtures it needs.

cp packages/cezar/src/path/to/regression.test.ts \
  "$proof_dir/tree/packages/cezar/src/path/to/regression.test.ts"
(cd "$proof_dir/tree" && npm test -- --passWithNoTests=false packages/cezar/src/path/to/regression.test.ts)
# Inspect the failure: it must show the reported defect, not a broken import/setup.

# Copy only the fixed source files into the scratch tree; keep the same test.

cp packages/cezar/src/path/to/source.ts \
  "$proof_dir/tree/packages/cezar/src/path/to/source.ts"
(cd "$proof_dir/tree" && npm test -- --passWithNoTests=false packages/cezar/src/path/to/regression.test.ts)
# After saving the evidence, clean up even if setup or a test failed.

git -C "$proof_repo" worktree remove --force "$proof_dir/tree"
rmdir "$proof_dir"
```

Create destination directories for new test paths as needed. Keep the package's
setup and environment; a scratch worktree needs its own dependency installation,
not a symlink to another checkout's workspace packages. Do not start Squeal in
this disposable tree. Run the fixed test in the task worktree too (through Squeal
when it is validating) so the proof does not replace normal verification.

For a **test-only fix**, reproduce the old test's defect under the same conditions
as the fixed test. There is no source fix to remove. Keep both versions out of the
watched test paths: create an ignored scratch copy with `git show`, then select it
with an explicit scratch Vitest config. For a server test, from the repo root:

```bash
proof_base=<pre-fix-commit>
mkdir -p .ai/qa
proof_dir=$(mktemp -d .ai/qa/red-proof.XXXXXX)
git check-ignore "$proof_dir/before.test.ts"
git show "$proof_base:packages/cezar/src/path/to/test.test.ts" > "$proof_dir/before.test.ts"
```

In that directory, write `vitest.config.ts` with this content:

```typescript
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import server from '../../../packages/cezar/vitest.config.ts'

export default defineConfig({
  ...server,
  root: fileURLToPath(new URL('../../../packages/cezar/', import.meta.url)),
  test: {
    ...server.test,
    include: [fileURLToPath(new URL('./before.test.ts', import.meta.url))],
    passWithNoTests: false,
  },
})
```

Adapt the package config for other workspaces. In the scratch test, adjust relative
imports and fixture paths to their original absolute locations; account for uses
of `import.meta.url` and colocated mocks too. Preserve the assertions and the
reproduction conditions. Run `npm test -- --config "$proof_dir/vitest.config.ts"`.
Inspect the failure, then replace only the scratch test with the fixed version,
apply the same path adjustments, and run the same command for green. A load-related
failure needs its original load or a controlled reproduction; an unrelated import
error, empty test selection or ordinary passing run is not red proof. Scratch tests
outside a package root can lose `console.log` output; use assertion failures and
captured runner output as evidence, not the presence or absence of a log line.
Remove the scratch test and config after saving the evidence (`rm -r "$proof_dir"`).

These recipes leave the task's tracked source and test files in place, so Squeal
never runs a temporarily swapped version. Ignoring a scratch file alone does not
exclude it from a test runner: keep it outside the package's test include patterns
and use the explicit scratch config only for the manual proof.

**Read the run-history evidence before theorizing, and cite it.** `.ai/specs/` records the
design, `git log -S` and `git merge-base --is-ancestor <commit> <tag>` settle "was this in
the release the user is on", and a user's "it worked in 0.9.1" is a testable claim, not an
opinion. open-mercato/cezar#810 was confirmed in one command before a line of code was read.

## Runner regressions ship with shared coverage

When fixing runner lifecycle, input delivery, Needs You, monitoring, ASK or
completion behavior, add or extend an exhaustive `RUNNER_IDS` regression in the
same PR. Use each runner's own native mock wire through `HARNESS_ADAPTERS`;
a backend-only test or injected normalized event does not cover the other
runners. Register new cells in the parity guard and give genuine wire gaps
named executable exemptions. Prove the relevant regression fails without the
fix. See `AGENT_PROTOCOL.md` §7 for the contract and examples. Do not defer this
coverage to a separate issue.

Keep each parity test file under about 300 s on an idle host, so that it stays
inside Squeal's 600 s per-file cap on a loaded host. When a parity suite grows
past that, run its `RUNNER_IDS` cells from one file per runner, defined once in
a `*-cells.testkit.ts`, and add a guard that every runner has its file. Split a
runner's file again by row group when one runner alone is too slow.
`core/harness-parity-cells.testkit.ts` and
`workflows/waits-parity-cells.testkit.ts` are the examples
(hearsay-tools/cezarion#1288).

Before opening a PR that changes `packages/cezar/src/workflows/run.ts`'s wait,
turn-end, failure or step-settlement paths, verify every suite matching
`packages/cezar/src/core/*-parity.test.ts` and
`packages/cezar/src/workflows/*-parity.test.ts`: with Squeal, run
`squeal status --wait 60000 packages/cezar/src/core/*-parity.test.ts packages/cezar/src/workflows/*-parity.test.ts`
and require a passing verdict for all selected files. Repeat the wait only for
files that are still pending. A file that Squeal reports as unknown (it timed out
at its per-file cap, or was never queued) does not become pending if you wait
again. Run it with `npm test -- <file>`, and record that command and its result
next to the Squeal verdict for the other files. Without Squeal, run
`npm test -- packages/cezar/src/core/*-parity.test.ts packages/cezar/src/workflows/*-parity.test.ts`.

### Generated inbox retirement

The owner waived the compatibility window for hearsay-tools/cezarion#1543. The generated
follow-up inbox is removed outright in 0.17.0: do not restore `CEZ_FOLLOWUPS`, suggestion
prompts, todo routes, watchers, synchronization or launch controls. Existing `todos.json`
files stay untouched; old Inbox URLs show plain-file export guidance. Historical run
`generateFollowups` fields are read-only legacy data and never enable generation.
Keep the handoff journal, Notes, Continue, live conversation follow-ups, worker messaging,
ordinary task creation and issue-authoring skills independent. Native runner plan/todo
wire events are unrelated to the removed generated inbox.

## The HTTP API

Four invariants. A feature that breaks any of them compiles on its own branch and stops working
when it lands — open-mercato/cezar#694 arrived with eleven unreachable routes for exactly this reason.

- **Every request and response shape is a zod schema in `packages/contract`, with its TypeScript
  type inferred from it (`z.infer`).** Never hand-write an API type, and never declare one in
  `server.ts` or in the api-client. The api-client re-exports the contract; the cockpit imports
  the schema when it wants to validate and the type when it wants to compile.
- **Register routes by CHAINING them into a family builder**, the way the ~24 families in
  `server.ts` already do. Hono accumulates route types through the chain only: a loose
  `app.get(…)` statement returns a value nobody keeps, so the route vanishes from `AppType` and
  the typed client cannot see it — silently, with the server still serving it.
- **Validate bodies, path params and the query string as route MIDDLEWARE**, through the trio in
  `src/server/validators.ts`. Parsing inside a handler is invisible to hono, which is what let
  `POST /runs` accept `{ totalNonsense: 12345 }` from a typed client without complaint.
- **Everything answers under `/api/v1`** (project-scoped: `/api/v1/p/:projectId/…`). The
  unversioned surface is gone.

The contract must describe EXACTLY what the route sends — no wider, no narrower. When a schema and
its route disagree, fix the SOURCE, never widen the schema; `contract-parity*.test.ts` asserts both
directions and a one-way check passes on real drift. Two mismatches recur often enough to name:
writing `key: maybeUndefined` types a key as always-present that `JSON.stringify` drops from the
wire (spread it conditionally), and an object-literal `type: 'x'` widens to `string` during hono's
inference, erasing a discriminant consumers narrow on (`as const`).

When a new variant lacks a field the other variants require, give it its own arm in
`z.discriminatedUnion` on the existing discriminant; never make the shared field optional
to admit it. See `openWaitSchema` in `packages/contract/src/waits.ts` as changed in
hearsay-tools/cezarion#1250: CI and timer waits require `deadline`, while the human arm
has none.

A request schema is just as exact about what the route TAKES: it refuses everything its handler
would refuse for a shape reason — a pattern, a length, a character set — so a body the middleware
admits never comes back a 400 from the handler, and `AppType` never promises an input the route
turns away. Export a shared rule ONCE from `packages/contract` and use that constant in the schema,
the handler and the cockpit; the handler never refuses, on shape alone, a value the schema let
through. What a schema cannot know — a name already taken, a run another process holds — stays the
handler's to refuse. hearsay-tools/cezarion#1081 is the worked example: its create-project body
first matched the name against GitHub's repository-name characters, which admit a leading `-`, `.`
or `_`, and the handler then refused those names through `isValidCheckoutName`. The fix there
exports one project-name pattern from the contract, and the schema, the handler and the New project
dialog all test against it.

Import a contract VALUE from the module that defines it, never through a package root. The
service writes `@open-mercato/cezar-contract/<module>`. The cockpit writes
`@open-mercato/cezar-api-client/contract/<module>`, or `@open-mercato/cezar-api-client/<path>` for
the api-client's own modules. Both roots re-export every contract module, delegation's schemas
among them, so one value imported through a root loads them all, and an edit to any shared schema
then reruns tests that never use it (hearsay-tools/cezarion#1237). Types still come from the
roots, as `import type`. `packages/cezar/src/contract-import-boundaries.test.ts` refuses every
other root import, and its failure names the subpath for each value.

## Repository layout

Four pnpm workspaces (npm script metadata retained) under a `private` root that publishes nothing itself:

| Path | Package | What it is |
| --- | --- | --- |
| `packages/cezar` | `@wjarka/cezarion` | The service + CLI, and everything behind them (runs, workflows, agent runners, workspace state). The published artifact: `bin`, plus the built cockpit in `web/dist`. |
| `packages/contract` | `@open-mercato/cezar-contract` | The HTTP contract itself: every request and response as a zod schema with its TypeScript type inferred from it, so no shape is written twice. **Node-free on the same terms as the api-client** (`lib: ["ES2022"]`, `types: []` in its tsconfig make a `node:*` import a compile error). `private`, and that has a cost: the service imports a contract VALUE (`workspaceUiStateSchema`, in `workspace/migrations.ts`), so a published tarball naming a package npm has never seen would fail on install. `packages/cezar/scripts/inline-contract.mjs` runs as `postbuild` to fold the contract into `dist/contract/` — bundle AND declarations — and repoint the emitted references, module subpaths included. Each module is also a subpath, `@open-mercato/cezar-contract/<module>`, which is how code imports a contract value (see § The HTTP API). Delete that script the day the contract is published, or the day nothing in the service imports a contract value. |
| `packages/api-client` | `@open-mercato/cezar-api-client` | The contract between the two: the typed client over `AppType`, the SSE/protocol types, and the scope helpers. Re-exports `packages/contract` so a consumer needs one import, for types. Values come through its subpaths: `/contract/<module>` (a one-line re-export of each contract module) and `/<path>` for its own modules. **Node-free by construction** — no `node:*`, no `@types/node` — because it is bundled into a browser AND imported by the Node service. `private` for now: versioned with the release but not on npm. The service may therefore only import it in TESTS — a runtime import would make the published CLI depend on something npm cannot resolve. |
| `packages/web` | `@open-mercato/cezar-web` | The cockpit SPA. Private; its output is an artifact of the service (`vite build` writes into `packages/cezar/web/dist`, which the CLI ships and serves). |

Rules that follow from that:

- **The CLI is not a separate package and should not become one.** It is the same program as the service — `packages/cezar/src/index.ts` boots `startServer`, but also `RunManager`, the workspace registry and the worktree machinery, and `cez run` executes a workflow with no server at all.
- A dependency belongs to the workspace that imports it. The root carries only what spans all four (`typescript`, `vitest`, `tsx`). A build script counts as an importer: `scripts/inline-contract.mjs` reaches for `esbuild`, so `esbuild` is a devDependency of `packages/cezar` rather than something inherited from whatever vite happens to hoist.
- Cross-package imports go through the package name, never a relative path — the exceptions are test-only reaches for golden fixtures, and they are ugly on purpose.
- The repo root keeps only what spans workspaces: `scripts/dev.mjs` (boots both halves) and `scripts/release*.mjs` (a release spans every package). Everything else lives in the package that owns it.

## Task routing

| When the task involves…                                                                                                                                                                                       | Read first                                                                                                                                                                                                                                    | Key rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI entry, `serve`/`run`/`init` subcommands, flags                                                                                                                                                            | `packages/cezar/src/index.ts`                                                                                                                                                                                                                                | Uses `node:util` `parseArgs`, no CLI framework. `serve` is the default command. Headless `run` treats `review` as a terminal success status (exit 0). `serve` boots in a fixed order: bind the listener, open the boot store and build its `RunManager`, `recover()` the boot project, then `startServer`. So anything a recovered run needs (its cockpit address, for one) must reach the boot manager at construction, not from `startServer`. `init` never overwrites existing files. Keep `.ai/cezar/.gitignore` maintenance (`ensureDataGitignore`) in sync with any new state file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Agent runners / backends                                                                                                                                                                                      | `AGENT_PROTOCOL.md` (the contract), then `packages/cezar/src/core/agent-runner.ts`, `packages/cezar/src/core/runner-factory.ts`, `packages/cezar/src/core/claude-cli-runner.ts`, `packages/cezar/src/core/codex-app-server-runner.ts`, `packages/cezar/src/core/opencode-server-runner.ts`, `packages/cezar/src/core/backend-detect.ts`, `packages/cezar/src/core/harness-parity.test.ts` | One seam: every backend implements `AgentRunner`/`AgentSession` and emits both the v1 `AgentEvent` stream and the normalized v2 `UiEvent` protocol. **Read `AGENT_PROTOCOL.md` first — it is the contract a new runner must satisfy** (the event schema, per-backend mapping, golden-fixture testing, and the backend-parity requirement), with an explicit new-runner checklist. Runner and backend prose never counts runners: `harness-parity.test.ts` refuses a counted roster in `AGENT_PROTOCOL.md` and in the harness-parity spec and test files. To run only that guard, from the repo root: `npm test -- packages/cezar/src/core/harness-parity.test.ts -t "counted roster"`. **Two executable parity matrices, and a backend must pass both**: `ui-parity.test.ts` pins what every MAPPER emits, `harness-parity.test.ts` pins what every RUNNER does (session lifecycle, provider-failure surfacing, `sendMessage`, ask routing, park declarations, and each runner's `specSupport` declaration of which `AgentRunSpec` fields reach its wire — hearsay-tools/cezarion#284) — a row a wire genuinely cannot carry needs a declared exemption, never a skip. New backends slot in as one class — do not leak backend-specific types past the seam. `claude-cli` is a legacy backend id kept so old run records parse. `CEZ_DRY_RUN=1` must keep working (bundled mock, no real CLI). Tool access goes through `allowedTools`, but the zero-config default includes unrestricted `Bash` (no `bashAllowlist`) and Codex/OpenCode don't honor `allowedTools` at all — see open-mercato/cezar#430.                                                                                                                                                                                                                                                                                                    |
| HTTP server & API routes                                                                                                                                                                                      | `packages/cezar/src/server/server.ts`                                                                                                                                                                                                                        | Hono app, binds to `127.0.0.1` only. A global `/api/*` request-origin guard (open-mercato/cezar#426) runs before every route except `/api/v1/health`: it rejects non-loopback `Host` headers (DNS-rebinding) in local mode and cross-origin mutating requests (CSRF) in both modes — zero-config, no token, so the same-origin cockpit and the Vite dev proxy pass untouched. The loopback test is `isLoopbackHostHeader` (anchored 127.0.0.0/8, missing Host = untrusted); never match it with a `127.` string prefix. **Request validation is route MIDDLEWARE, not a `safeParse` inside the handler** — `jsonZodValidator` / `paramZodValidator` / `queryZodValidator` from `packages/cezar/src/server/validators.ts`, read from `c.req.valid('json'|'param'|'query')`. Hono records a validated shape in the route type only when validation happens as middleware, so a handler-side parse is invisible to `AppType` and the typed client would accept any body for that route. The rejection shape is unchanged: `{ error }` with 400/404/409. CORS is deliberately enabled for `/api/v1/health` only (cross-origin discovery); never widen it. SSE endpoints replay from NDJSON then stream live, deduped by `seq`.                                                                                                                                                                                                                                                                                                   |
| API request/response shapes (any new field, route or payload) | `packages/contract/src/*.ts`, then `packages/cezar/src/server/validators.ts` | **One zod definition per shape, type inferred — never a hand-written interface.** Add the schema here FIRST, then chain the route and validate through the trio; `contract-parity*.test.ts` proves the schema and the route agree in both directions, and `typed-bodies.test.ts` proves the route reached `AppType` at all. See the HTTP API section above for why a loose `app.get(…)` disappears. |
| Real-time events (live UI signals, replacing polls)                                                                                                                                                           | `.ai/specs/2026-07-23-websocket-subscriptions.md`, then `packages/cezar/src/server/ws.ts` + the `health` topic in `packages/cezar/src/server/server.ts`, and `packages/web/src/api/ws.ts`                                                                                        | Browser ownership: read `.ai/specs/2026-10-08-browser-tab-coordination.md` first. Local visible documents share one same-origin SharedWorker for the workspace SSE, multiplexed task SSE, topic WebSocket and allowlisted recurring reads; documents retain their own caches/cursors. Hidden documents release demand; authenticated bootstrap, scope reconciliation and bounded history hydration precede restoration. Remote/failed-worker mode uses finite authenticated HTTP (no permanent SSE or ordinary WebSocket). Two live channels: the SSE run/event stream (`/api/v1/workspace/events`, `packages/web/src/api/global-events.tsx`) and the **WebSocket subscription bus** (`/api/v1/ws`, `ws` lib server-side, native `WebSocket` client). The bus is the pattern for any new live signal instead of a `refetchInterval`. Its whole discipline is **demand-driven subscription**: a topic's server publisher starts on the `0→1` subscriber and stops on `1→0`, and one socket per local coordination group ref-counts listeners per topic. **Subscribe at the scope that matches the data's demand lifetime, always return the unsubscribe (`useEffect(() => subscribeTopic(...))`), publish only on change** — a leaked subscription is a server publisher that never stops AND a component that keeps waking for a screen the user left. Per-view signals subscribe in the view; **session-global signals subscribe ONCE at the root**, not per reader — health is the worked example: one `useHealthSubscription()` controller in `GlobalEventsProvider` subscribes after bootstrap only for local mode, while `useHealth()` is a pure cache read the ~15 readers call without touching the socket. Remote mode must open no browser WebSocket because it cannot explicitly carry reverse-proxy credentials; it uses finite authenticated HTTP reconciliation. One socket per local coordination group — never `new WebSocket` for a feature; add a topic. **One named exception: the live preview pane** (hearsay-tools/cezarion#781, spec `.ai/specs/2026-10-02-live-preview-v1.md`) opens its own `/api/v1/p/:projectId/runs/:id/preview/ws` per open pane, in remote mode too, because it streams binary JPEG frames and pointer input that a JSON topic cannot carry. It is opt-in behind `CEZ_PREVIEW=1` (off, the path answers 404), demand-bound to an open pane, refused before the handshake unless the upgrade guard trusts it, and capped at two upgrade attempts so a proxy that cannot carry it (Basic Auth, open-mercato/cezar#688) shows 5.14 instead of looping. A new feature does not get the same exception: add a topic. Liveness: server ping/pong reaping + app-level beat, client watchdog + reconnect. Topics are workspace-level (single-mount, never `/api/v1/p/`) and, because the upgrade guard admits any loopback origin (WS has no CORS), must only carry data safe for any local page — read the spec's security caveat before adding one. |
| Workspace registry / per-user state (`~/.cezar/`)                                                                                                                                                             | `packages/cezar/src/paths.ts`, then `packages/cezar/src/workspace/config.ts`, `packages/cezar/src/workspace/projects.ts`, `packages/cezar/src/workspace/migrations.ts`, `packages/cezar/src/workspace/semaphore.ts`                                                                                                      | `~/.cezar/config.json` is the per-user workspace config **and** the project registry — every repo cezar has been booted in (spec `2026-07-20-multi-project-workspace`). Every path goes through `cezarHomeDir()` so `CEZ_HOME` keeps tests and containers off a real home; never re-derive `homedir()` elsewhere. Schema rules are load-bearing: every field optional with `.catch`, `.passthrough()` at every object level, per-entry salvage for `projects` (one bad row never evicts the registry), and writes only through `mergeWriteWorkspaceConfig` (read-modify-write + atomic tmp/rename, `0600`) so two processes converge. A corrupt or read-only home degrades to in-memory defaults with ONE warning — never a boot failure. Migrations are config-files-only, idempotent, additive and non-blocking; run state never migrates. `maxParallel`/`memoryLimitMb` are workspace-wide (`resources`): the per-repo keys are imported once by migration 001 and ignored by enforcement afterwards. Registration is suppressed for task worktrees and `$HOME` itself (`shouldRegisterProject`). A merge-write resolves its path ONCE and uses it for both halves — resolving it twice let a `CEZ_HOME` that changed mid-flight read one home and write another, wiping the user's registry. Two guards back that up: `assertCezarHomeWriteIsSandboxed` refuses any write into the real `~/.cezar` from a vitest process, and `packages/cezar/vitest.setup.ts` pins `CEZ_HOME` to a per-worker sandbox so no case ever runs unpinned. Every write that leaves projects behind also snapshots `config.json.bak`, which `loadWorkspaceConfig` restores from when the config is missing, empty or corrupt (a config that parses and is simply empty is the user's own state and is never overridden). | **Agent accounts** (spec `2026-07-29-agent-profiles`) live in this directory too, but in their OWN file — `~/.cezar/agent-accounts.json`, never a key in `config.json`, so a cezar that has never heard of accounts cannot drop them; `src/workspace/agent-accounts.ts` owns the store, `src/core/agent-profiles.ts` the vendor knowledge and `src/workspace/agent-profiles.ts` the resolution. |
| Project-scoped routes & contexts (`/api/v1/p/:projectId`, `/p/:projectId`)                                                                                                                                       | `packages/cezar/src/server/project-context.ts`, then `packages/cezar/src/server/server.ts`, `packages/web/src/routes.tsx`                                                                                                                                                        | One `{store, manager, dataDir, launchKey}` context per registered project, built on first touch or by the background warm-up after listen (`warmAll`, off with `CEZ_PROJECT_WARMUP=0`, hearsay-tools/cezarion#667), disposed on removal; a `missing` root is never instantiated (unknown id → 404, gone root → 409). Every project route is registered **once** in a chained family builder and mounted under both `/api/v1/<path>` (bound to the boot project) and `/api/v1/p/:projectId/<path>` — `route-parity.test.ts` walks the exported route manifest and asserts `/api/v1/x`, `/api/v1/p/<boot>/x` and `/api/v1/p/default/x` answer byte-identically, so a new scoped route without its alias fails the suite. `default` is the reserved boot alias and is never an allocated slug. Workspace-level routes (`/projects`, `/workspace/*`, `/fs/browse`) are single-mount and never scope-prefixed. The cockpit mirrors the split: every view lives under `/p/:projectId/`, flat legacy PAGE paths redirect to the boot project, and global settings sit outside the scope at `/settings/global`. **One versioned API surface**: the unversioned `/api/*` spelling was removed — everything answers under `/api/v1`. A chained builder is the only shape Hono can infer route types from, which is what makes `AppType` (`packages/cezar/src/server/app-type.ts`) and the typed client cover the API. **Add a route by adding a link to its family's chain, never a loose `api.get(…)` statement** — a statement reaches neither the typed client nor `AppType`; `versioned-surface.test.ts` fails on any route outside `/api/v1`, and `bc-route-inventory.test.ts` (which reads a built app's route table, not the source) requires it to be inventoried in BACKWARD_COMPATIBILITY.md §2.                                                                                                                 |
| Git / worktree logic                                                                                                                                                                                          | `packages/cezar/src/git-worktree.ts`, `packages/cezar/src/git-diff-base.ts`, `packages/cezar/src/server/git.ts`                                                                                                                                                                                                    | One worktree per task at `.ai/cezar/worktrees/<runId>`, branch `cez/<id8>` off the configured base branch. Helpers never throw (except `createWorktree`) — degradation is the caller's policy. Diffs are capped (`DIFF_CAP`). Orphaned worktrees are pruned at startup. **"Which ref anchors *this task's* diff" lives in exactly one place** — `resolveTaskDiffBase` (`git-diff-base.ts`): the merge-base against the **freshest** base ref (`origin/<base>` when the local branch is behind it — agents fetch, they never pull, and a stale local `main` is what turned an eight-line fix into `+59514 −12160`), and, when the agent checked another branch out into the worktree, that branch **as the run found it** (`<branch>@{<run start>}`), whichever of the two attributes fewer changed lines. Attributing a checked-out branch's history to this task is what produced five-figure numbers on review and QA runs (open-mercato/cezar#591 fixed the Changes tab, open-mercato/cezar#751 the stored `diffStat`); anchoring those runs at `HEAD` instead then reported `+0 −0` for work they really did commit. A new task-diff surface resolves through that helper and passes the run's `branch` **and** `startedAt`; `worktreeDiff`/`worktreeDiffStat` deliberately keep the whole-branch anchor and each carry a comment saying why. **Autosave commits only on the task branch** (hearsay-tools/cezarion#1004): the turn-end and run-finalize flushes and the periodic timer go through `RunManager.saveWorktree`, which hands `autosaveCommit` the run's recorded `branch`; when the agent checked another branch out (or detached HEAD), nothing is committed and the handoff's `## Autosave (cezar)` section (cezar-owned, before `## Progress log`, so the agent's Progress log stays its own) plus a cockpit note name the branch and the uncommitted path count. A turn-end or run-finalize commit is reported the same way, with the `git reset --soft <sha>~1` that folds it into the agent's own commits while it is still HEAD; the timer's commits go to the handoff only, as one coalesced `periodic:` line per run of consecutive periodic commits (`recordHandoffPeriodicAutosave`), since a clean closing flush reports nothing. A change to how `autosaveCommit` writes must state its guarantee against the agent's concurrent checkout, merge, cherry-pick, revert and commit in the `autosaveCommit` comment that starts "The save is not atomic", the only list of what the save guarantees today and which races it accepts (hearsay-tools/cezarion#1111). The pre-PR flush names no branch and commits on whatever HEAD is. A fresh task worktree has no `node_modules`; Node walks up into the main checkout and `@open-mercato/*` workspace packages resolve there, not here. Before typecheck or tests, run `pnpm install --frozen-lockfile` in the worktree. Worktree creation itself installs nothing; a project's optional `worktreeSetup` commands (`packages/cezar/src/worktree-setup.ts`, hearsay-tools/cezarion#917, spec `.ai/specs/2026-10-07-worktree-setup.md`) run after creation and before the first agent turn, from `RunManager.execute` (tasks and workers) and `runContinuation` (a reclaimed worktree rebuilt on Continue), with the durable `RunRecord.worktreeSetup` that restart recovery reads. **Tools whose reports name a commit must resolve it once, then route every subsequent git call through one pinned helper**: pass `--attr-source=<sha>`, use a private index populated from that commit for index-based operations, and pass `--no-textconv` for raw-content reads. Require a PATH-shim call-log test that fails if any call after resolution bypasses the pin; see `.github/scripts/upstream-scan.cjs` (`pinnedGit`) and `.github/scripts/upstream-targets.test.cjs`. |
| GitHub integration (issues/PRs tab, draft PRs)                                                                                                                                                                | `packages/cezar/src/server/github.ts`, `packages/cezar/src/server/pr.ts`                                                                                                                                                                                                    | Must degrade gracefully: no `gh`, no remote, offline all return `{ available: false, reason }` — never an error. `gh … --json` output is zod-validated at the boundary. `GITHUB_TOKEN` is the fallback when `gh` isn't authenticated. `createDraftPr` never throws; failures map to one-line human errors. `CEZ_DRY_RUN=1` fakes the PR URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Automations (GitHub polls and schedules) | `packages/cezar/src/automations/`, then `packages/contract/src/automations.ts`, `packages/contract/src/automation-schedule.ts`, the automations family in `packages/cezar/src/server/server.ts`, `packages/web/src/routes/automations/`, and `.ai/specs/2026-10-02-scheduled-automations.md` | Opt-in behind `CEZ_AUTOMATIONS=1`; the gate middleware answers `409` otherwise. Two kinds: `github` polls, `schedule` fires on the clock and needs no remote. A schedule fire takes the hearsay-tools/cezarion#651 store lease, reserves one receipt per occurrence (`<id>:schedule:<iso>`), launches an ordinary task, and never advances `nextRunAt` on a lost lease. At most one catch-up inside 24 h, auto-pause after 3 consecutive launch failures. `setState` is a read-modify-write against a fresh disk read. No `task.dispatch`, no default-on. Stage 2 (hearsay-tools/cezarion#774): `cez automation` (`automations/automation-cli.ts`) reaches the cockpit through `CEZ_COCKPIT_URL`/`CEZ_PROJECT_ID`, which the boot manager receives at construction (`serve` binds its listener before it recovers, so recovered runs carry it) and every other project's manager receives from `startServer` via `RunManager.setCockpitAddress`; it never starts a server or probes ports on its own. The prompt part and the built-in `create-cezarion-automation` skill share ONE gate (`CEZ_AUTOMATIONS=1` AND an address): add any new skill lookup through `RunManager.builtinSkills()` and any new session construction site through `automationsPart()`. Templates, calendars and stats are stage 3. |
| Workflows (YAML chains, steps, retries)                                                                                                                                                                       | `packages/cezar/src/workflows/types.ts`, then `packages/cezar/src/workflows/load.ts`, `packages/cezar/src/workflows/run.ts`                                                                                                                                                                | A step is agent (`prompt`/`skill`) XOR check (`command`); a file has `steps` XOR the portable `skills` shorthand — both enforced by zod refinements. `onFail.retry` may only reference an _earlier_ step (`stepsIssue`). `{{task}}` is the substitution token. `quick-task` is the built-in zero-config workflow; built-ins always come back after delete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Pending asks (`cezar_ask`, the ask card, a new field on the ask) | `packages/cezar/src/workflows/run.ts`, then `packages/cezar/src/runs/transcript-facts-fold.ts`, `packages/cezar/src/delegation/questions.ts`, `packages/web/src/routes/task-thread/thread-state.ts`, `packages/cezar/src/task-cli/projections.ts` | A pending ask has four kinds of reader. `workflows/run.ts` opens the human wait and emits the `ask.requested` event. `runs/transcript-facts-fold.ts` and `delegation/questions.ts` route a worker's question to its parent. `routes/task-thread/thread-state.ts` builds the cockpit ask card. `task-cli/projections.ts` (`projectStatus`, fed by `pendingQuestion` in `task-cli/cli.ts` and `runs/webhook.ts`) feeds `cez task status` and the task webhook; these read the `ask.requested` event, not the human wait, so a design that follows the wait misses them. A field added to the ask card must reach every reader, or the spec must say why a reader leaves it out. hearsay-tools/cezarion#1471 is the worked example: its `context` field missed the CLI and webhook projections until review round 1. |
| Skills (Markdown playbooks, team repos)                                                                                                                                                                       | `packages/cezar/src/skills.ts`, `packages/cezar/src/skills-remote.ts`                                                                                                                                                                                                       | A skill is a `.md` file with optional YAML frontmatter (`name`, `description`); its body becomes the agent's extra system prompt. Discovery precedence is local-first: `.ai/cezar/skills` → `.ai/skills` → `.agents/skills` + agent mirrors → global → team repo. Missing dirs are fine; team-skill loading never blocks on the network (background cache in `~/.cache/cez/`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Runs store / state persistence                                                                                                                                                                                | `packages/cezar/src/runs/store.ts`                                                                                                                                                                                                                           | One embedded SQLite file per project, `.ai/cezar/runs.db` (`node:sqlite`, WAL; Node 24.15 is the floor and CI proves it), plus one append-only NDJSON event file per run. **Read first, in this order: `runs/run-database.ts` (the only SQL; schema, `transaction()`, claims, fenced writes), `runs/run-row.ts` (record to row: columns, summary, `isLiveRecord`), `runs/raw-record.ts` (keeps unknown fields across a write), `runs/store.ts` (`RunStore`, import, open), then `runs/run-index.ts` (read-only cold reader), `runs/legacy-index.ts` and `runs/store-open-error.ts`.** Each row holds the complete `RunRecord` JSON plus a stored `toRunSummary()` column and the few columns the store queries; `RunRecord` stays a zod schema, so new fields must still be optional or defaulted and rows written by an older cezar still parse. **Only the live set is in memory**: queued, running and waiting runs, runs a `RunManager` holds, pending wake timers and parents waiting on workers (`isLiveRecord`, plus `pin`). Finished runs load from the row on demand as fresh copies (frozen under vitest), so never keep or mutate one, and never rebuild a full scan of `runs`: add an indexed column. A delegation family is held, claimed and released as one unit (`run_claims`: session UUID, pid and start identity, checked inside the write transaction), so two processes on one project never both write a run. A foreign live run is readable and every control answers 409 `{ error }` (`requireRunControl`); `run_claims` and `run_conflicts` are private. `runs.json` is imported once on first open into `runs.db` (exact bytes kept in `runs.json.pre-sqlite.bak`, completion marker in the same transaction), never written again and never deleted; there is no dual-write, so an older cezar sees only history up to the import. **A store that cannot open never reads as empty**: `RunStore.open` throws a typed `RunStoreOpenError` (`corrupt`, `busy`, `permission`, `disk-full`, `unsupported-schema`, `legacy-writer`, `other`), a damaged file is left byte-for-byte alone, and `serve` answers 409 `{ error }` for that project's routes instead of treating it as no runs. Recovery steps live in `BACKWARD_COMPATIBILITY.md` section 3. Cold readers (`readRunIndexFromDisk`) open `runs.db` read-only and never build a context. Spec: `.ai/specs/2026-10-05-sqlite-run-store.md`. A **queued** run's prompt stays editable until the scheduler picks it up (open-mercato/cezar#472): `task` plus the optional `queuedMessages` stack are folded into `{{task}}` at dequeue, and that fold is read-only — never write it back to the record. The store is also the in-process event bus for SSE.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Task handoff journal (`CEZ_HANDOFF_FILE`, `.ai/cezar/runs/<runId>.handoff.md`) | `packages/cezar/src/handoff.ts`, then the two readers' files `packages/cezar/src/server/server.ts` and `packages/cezar/src/server/forge/github.ts` | A per-task journal at `.ai/cezar/runs/<runId>.handoff.md` (spec 007, `.ai/specs/007-handoff-file-todos.md`), outside the worktree so it survives worktree removal. `seedHandoffFile` writes the skeleton. The agent finds the file through `CEZ_HANDOFF_FILE` and the `HANDOFF_ONLY_INSTRUCTIONS` system-prompt fragment, and keeps `## Progress log` (newest at the top) and `## Resume notes`. **The top of `## Progress log` belongs to the agent.** Two features read its first lines as the agent's own summary: `handoffProgressExcerpt` (`handoff.ts`) feeds the variants compare column (`handoffExcerpt` in the `GET /groups/:groupId` route of `server/server.ts`, spec 010), and `buildPrBody` (`server/forge/github.ts`) writes the body of a draft PR opened from the cockpit (Goal plus the first lines of the Progress log). **cezar writes its own records to a cezar-owned section, never the Progress log**, as `## Autosave (cezar)` does since hearsay-tools/cezarion#1111: `appendHandoffAutosaveReport` and `recordHandoffPeriodicAutosave` write there, and the first report creates the section right before `## Progress log`. One exception exists on purpose: `appendHandoffHeartbeat`'s lifecycle lines (`turn complete — …` and `step "…" complete — …` from `workflows/run.ts`, plus `picked from N variants` in `server.ts`) go to the top of the Progress log as the fallback that keeps the journal current when the agent writes nothing. `handoffProgressExcerpt` skips the lifecycle lines (and `session idle-closed — …`) whenever the agent wrote a line of its own, because the no-wait nudge's extra turn writes more of them (hearsay-tools/cezarion#1234). A new cezar record does not join them. The first design of hearsay-tools/cezarion#1004 wrote the autosave report at the top of the Progress log, and only CI's cockpit E2E (`variants-compare.e2e.ts`) caught it. |
| Web UI (cockpit)                                                                                                                                                                                              | `packages/web/src/app.tsx`, then `packages/web/src/routes.tsx`, `packages/web/src/api/`, and the affected component/route                                                                                                                                    | React 19 + Vite + Tailwind v4 + shadcn/ui; source lives in `packages/web/` (its own npm workspace, `@open-mercato/cezar-web`, with the React/Vite/Tailwind deps in ITS manifest, not the root's), build output in ignored `packages/cezar/web/dist/`. Anything the server and the cockpit BOTH speak — the v2 protocol types, the `/api/v1/p/:projectId` scope helpers, and (as it grows) the typed API client — lives in the third workspace `packages/api-client/` (`@open-mercato/cezar-api-client`), which must stay Node-free: no `node:*` import and no `@types/node`, because it is bundled into the browser AND imported by the Node service. Keep one global SSE connection and patch the TanStack Query cache in place; authoritative refetch happens on reconnect/visibility. Preserve light/dark/system theming, mobile safe areas, keyboard access, and unit coverage. The legacy vanilla web app was deleted in R7; when `packages/cezar/web/dist` is missing the server answers every shell route with a built-in "run `npm run build:web`" hint page (`packages/cezar/src/server/static-ui.ts`). **Virtualized lists (`virtua`):** `Virtualizer` wraps each child, so put row styling and flags on the rendered item element, never on `ul > li` or `li + li` selectors. The GitHub examples in hearsay-tools/cezarion#1189 (pending merge) are `gh-row-item` in `packages/web/src/routes/github/github.tsx` and `github-layout.css`. In jsdom unit tests, supply scroll-element geometry through a `ResizeObserver` stub and a non-null `offsetParent`; see `packages/web/src/routes/github/github-geometry.testkit.ts` in that PR. In browser specs, scroll and collect rows (`allRowNumbersJs` in `packages/web/e2e/github-sidebar.e2e.ts` in that PR), or wait for one row, never a total DOM row count. Before virtualizing a list, grep `packages/web/e2e/*.e2e.ts` for `> li` and the list's `data-slot`. Small text on card-2: follow the [measured token table and lint rule](packages/web/docs/card-2-contrast.md). |
| Agent config files (Settings → Agent config; grouped by agent, MCP as a per-agent subsection — spec 2026-07-17-agent-config-by-agent, descriptor table in `packages/web/src/routes/settings/agent-descriptors.ts`) | `packages/cezar/src/agent-config/` (`catalog.ts`, `files.ts`, `validate.ts`, `service.ts`, `seed.ts`), then `packages/cezar/src/paths.ts` and the `/api/v1/agent-config` routes in `packages/cezar/src/server/server.ts`                                                                      | Read and edit the coding agents' OWN config files (Claude/Codex/OpenCode settings, MCP, memory), raw and per-scope (spec open-mercato/cezar#404). `catalog.ts` is the ONLY place vendor knowledge about config FILES lives — paths + verbatim precedence strings; keep it accurate and dated. Its sibling `src/core/agent-profiles.ts` owns the other half: the env var that relocates each agent's whole home (spec `2026-07-29-agent-profiles`). Never re-serialize a file cezar opened (byte-exact round-trip). Files are addressed by catalog id, never a path. **Writing is a local-machine capability: every `PUT /api/agent-config/:id` 409s when `capabilities().localHandoff` is false — this closes a hooks-based RCE path, do not weaken it.** The gitignored personal layer is seeded into run worktrees (`seed.ts`, guarded by `git check-ignore`).                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Cockpit e2e specs (`packages/web/e2e/*.e2e.ts`, the browser seam, a flaky shard) | `packages/web/e2e/README.md`, then `packages/web/e2e/agent-browser.ts` and `packages/web/e2e/contrast.ts` | Wait, then read, as one step: `click`/`hover`/`fill` auto-wait for their selector, `waitForValue` polls an expression and returns the sample that passed (hearsay-tools/cezarion#409); a one-shot `expect(browser.…)` right after an action is a race. `packages/web/src/test/e2e-wait-discipline.test.ts` scans every spec on `npm test` against a baseline that only shrinks. A red shard leaves a failure bundle (`.ai/qa/failures/`); read it before theorizing, and no flake fix lands without one or a local reproduction. A wait added or changed to fix a flake must carry the [README provenance comment](packages/web/e2e/README.md#the-rules-the-ratchet-enforces): the full failure-bundle leaf path with a durable citation, the reproduction command or env-gated delay, and before/after run counts with both totals. |
| Feature specs / design history                                                                                                                                                                                | `.ai/specs/`                                                                                                                                                                                                                                  | Numbered and dated specs are the design record — code comments cite them (`spec 006`, `open-mercato/cezar#348`). Read the relevant spec before changing a feature it covers; keep new work consistent with it or update the spec.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Upstream drift (what open-mercato/cezar shipped, what we ported, declined, or solved differently) | `.ai/upstream/README.md`, then `.ai/upstream/ledger.yaml`, `.github/scripts/upstream-scan.cjs`, spec `.ai/specs/2026-09-18-upstream-ledger.md` | One entry per upstream commit since the fork point, keyed by sha; `pending` rows come from the weekly `upstream-scan.yml` PR and are decided by editing `status`, `fork` and `reason` in the YAML, then `node .github/scripts/upstream-scan.cjs render` so `LEDGER.md` matches. The unit gate validates every row. Before planning a port, run `node .github/scripts/upstream-scan.cjs targets <sha>` from current `main`: it re-checks the commit's files against the fork as it is now (hearsay-tools/cezarion#1002). **Never add a git remote named `upstream`**: `gh` prefers it over `origin` and cezar's GitHub tab starts showing the upstream repo; the scan fetches into `refs/cez-upstream/main` instead. |

## Validation

The pinned TypeScript 7 package is the native compiler and offers no stable
JavaScript compiler API (`typescript` exports only version fields). For
source-scanning tests, reuse regex scans over `blank()` from
`packages/cezar/src/test-wait-discipline.testkit.ts`; see
`contract-import-boundaries.test.ts` and `test-wait-discipline.test.ts` for examples.

A fresh task worktree (`.ai/cezar/worktrees/<runId>`) has no `node_modules`. Run `pnpm install --frozen-lockfile` in that worktree before the commands below — otherwise Node walks up to the main checkout and typecheck/tests compile against that tree's sources, not this one.

**If Squeal is installed and validating this worktree, use it for iteration.**
Read the `SQUEAL` reports and follow its installed skill. `squeal.config.json`
covers the four unit Vitest projects, both fast `node:test` groups from
`npm run test:unit`, and both E2E suites in its slow tier: packaged CLI
(`npm run test:package`) and cockpit browser (`npm run test:e2e`).
Do not duplicate those background runs with `npm test`,
`npm run test:unit`, `npm run test:package`, `npm run test:e2e`, or `npm run test:changed`.
Use `squeal why <check>` for failure details and, when a result is needed,
`squeal status --wait 60000`.
Lease messages show executable and interpreter script names, with other arguments
omitted to avoid logging credentials. The timeout reuses the initial diagnostic
snapshot; it does not start more command probes after the acquisition deadline.
For a test-env lease held by a Squeal daemon, use this guidance:
“If Squeal covers this spec, read its result with `squeal status --wait 60000`;
do not start a duplicate run.”
If test-first work intentionally makes a previously passing check fail, Squeal denies the next edit once; resend the same edit unchanged (a newly added test’s first observed failure does not trigger this denial).
Under Codex, use the absolute Squeal command printed in its messages when
`squeal` is not on PATH. Fix regressions and report known failures, pending,
stale, or unknown results accurately; zero known failures is not a full pass.

Squeal is optional. If it is absent, no daemon is validating, or a needed result
is unknown, run affected test files/test names through npm. Inspect
`npm run test:changed -- --plan` before using `npm run test:changed`; if the plan
falls back to a full run, choose focused checks and leave the full gate to CI.
Packaged CLI E2E exercises built output: run `npm run build` after relevant source
changes before relying on its results. The config declares the server and cockpit
build artifacts as inputs. The browser project's globalSetup uses the existing
test environment bootstrap to prepare or reuse the app and Chrome; a missing
browser is an error in a Squeal run. `npm test` and `npm run test:watch` select
only the four unit projects. Typecheck and build remain separate checks;
run them when the change needs them. When Squeal is unavailable, use focused
browser specs for affected UI flows, e.g.
`npm run test:e2e -- smoke.e2e.ts -t 'test name'` (see `packages/web/e2e/README.md`).
Do not run the entire Vitest or browser suite after each edit or each review round.

Before opening a PR that changes dry-run turn-end behavior — the
`packages/cezar/scripts/mock-*.mjs` mocks, the turn-end rule, attention, or the
human-ask summary — select the browser and packaged fixtures that drive a dry-run
task to a park, from the repo root:

```bash
P="waitForStatus\([^)]*'waiting'|hasPendingHumanAsk|attentionLabel|'mock:"
grep -lE "$P" packages/web/e2e/*.e2e.ts packages/cezar/test/e2e/*.test.ts
```

Require passing results for these matches alongside the unit parity suites in
[Runner regressions ship with shared coverage](#runner-regressions-ship-with-shared-coverage)
(hearsay-tools/cezarion#1251). With Squeal validating, read and wait for the
selected files through `squeal status --wait 60000 <files>`; if slow results are
not current, use `squeal run --slow --wait 60000`. Without Squeal, run the browser
matches with `npm run test:e2e -- <specs>` from the repo root. Packaged matches
require `npm run build` from the repo root first; then, from `packages/cezar`, run
`node --import ../../scripts/test-git-env.mjs --import tsx --test <files>` with
those packaged paths relative to that directory (e.g. `test/e2e/task-cli.test.ts`).

Before opening a PR that renames, moves or removes a `RunRecord` field, also
search the packaged and browser fixtures for each changed field name, including
its old and new names or paths. From the repo root, replace the example names
below with the changed field's names:

```bash
rg -l -F -e 'delegation.wait' -e 'waits' packages/cezar/test/e2e/*.test.ts packages/web/e2e/*.e2e.ts
```

Inspect the matches to identify fixtures that read the changed field; common
names can also match unrelated text. Require passing results for the affected
fixtures through the Squeal or focused npm paths above. Run `npm run build`
from the repo root before validating matching packaged fixtures, including with
Squeal, so they exercise the current built output. This selection supplements
the dry-run park-fixture and runner-parity requirements above
(hearsay-tools/cezarion#1300).

Before pushing a change that renames an enum or discriminant value — a wait
kind, outcome, status or attention label — search test files for the quoted old
value. From the repo root, replace `ci` below with that value:

```bash
rg -n -F -e "'ci'" -e '"ci"' packages --glob '*.test.*' --glob '*.e2e.ts'
```

Inspect every match. Update assertions and fixtures that should use the new
value. Preserve intentional refusal tests, legacy-row conversion tests and
unrelated uses. A rejection test that passes only because the old value is now
unknown must be updated to test its intended constraint. In
hearsay-tools/cezarion#1504, a deadline test still used `ci` after the kind became
`pr`, so it could pass without checking the deadline requirement.

In an unbuilt worktree, only a `Cannot find module` error naming a missing
`dist/` module is the known Squeal limitation. An assertion failure in
`test:package` is a real failure that needs investigation; do not dismiss it
alongside missing-`dist` errors.

No tool maps a cockpit source change to the browser specs it affects, with or
without Squeal: `npm run test:changed` runs `npm test`, whose four unit projects
hold no browser spec, and Squeal's browser-spec inputs include all of
`packages/web/src/**`, so an edit marks every spec stale and names none. Grep
`packages/web/e2e/*.e2e.ts` for the `data-slot`, `data-streamdown` and
`data-testid` values and distinctive class names that the changed file and the
local components it imports render. Walk down to what the file renders, never up
to what renders it: going up reaches most of the suite. When Squeal is
unavailable, run the matches with `npm run test:e2e -- <spec>.e2e.ts` (one call
takes several specs); otherwise those specs' results come from Squeal. Shared
renderers such as `packages/web/src/routes/task-thread/markdown.tsx` and
`packages/web/src/components/diff/*` matter most, because one edit reaches specs
written for other features. `markdown.tsx` renders no `data-slot`, yet an edit to
it broke `artifact-project-links.e2e.ts` (hearsay-tools/cezarion#1076) through
its siblings `task-link.tsx` and `link-safety-dialog.tsx`; this grep, run from
the repo root, lists that spec:

```bash
grep -lE 'link-safety|data-streamdown|thread-markdown' packages/web/e2e/*.e2e.ts
```

Specs also assert on visible text, and the attribute grep does not find those
assertions. When a cockpit change adds, renames or removes visible copy (a label,
a tab, a heading, a button, an empty state), also grep the specs for that copy.
Grep both the new and the old string: a spec can assert that text is present,
and a spec can assert that it is absent. In hearsay-tools/cezarion#1335 the
sidebar got a new tab labelled "Automations". The attribute grep found
`quick-list.e2e.ts` and `mobile-task-controls.e2e.ts`, and both passed locally.
`automations.e2e.ts` asserts that the sidebar does not show "Automations" while
the feature is off, and it failed only in CI. This grep, run from the repo root,
lists that spec:

```bash
grep -lF 'Automations' packages/web/e2e/*.e2e.ts
```

### One-CPU load reproduction

For a failure that appears under CPU contention, use this optional diagnostic
from the repo root. It needs **Linux**, Bash, `taskset` (util-linux), and GNU
`timeout` (coreutils). Choose a focused test file and name; replace both
placeholders below. This is a controlled reproduction, not a routine test rerun
or a replacement for the failure bundle. With Squeal validating, read its failure
report first and follow its installed skill: use this command only when the
controlled-load result is needed and unknown, not to duplicate background checks.

```bash
# Select the first CPU allowed to this shell, including inside a cpuset.

cpu=$(awk '/^Cpus_allowed_list:/ { split($2, cpus, /[,-]/); print cpus[1] }' /proc/self/status)
LOOPS=2 timeout --kill-after=5s 120s taskset -c "$cpu" bash <<'BASH'
set -eu
pids=()
cleanup() {
  if ((${#pids[@]})); then
    kill "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
for ((i = 0; i < LOOPS; i++)); do
  sh -c 'while :; do :; done' &
  pids+=("$!")
done
npm test -- <test-file> -t '<test-name>'
BASH
```

The shell, busy loops, test command and its children inherit the same logical
CPU affinity unless a child explicitly changes it. Together they can consume
one logical CPU, not the whole host; other sessions using that CPU still compete
with them. Start with `LOOPS=2`, then increase in small steps only as needed.
For CPU-bound work, the failing host's load average divided by its available
logical CPU count gives a rough starting point for runnable work per CPU.
Each busy loop adds one runnable competitor, and the test adds its own work.
For example, load 48 over 24 CPUs suggests roughly two runnable tasks per CPU,
not an exact prescription of two loops. Load average includes I/O waits; CPU
quotas, priorities and test parallelism also change the result. Record the CPU,
loop count, command, revision and observed outcome. Eight loops reproduced the
reported R24/R25 failures in hearsay-tools/cezarion#1392; it is no universal
threshold or guarantee of reproduction.

Normal completion or test failure runs the EXIT cleanup, which stops and reaps
only the recorded loop PIDs. Ctrl-C uses the same cleanup. The 120-second limit
sends SIGTERM to the command group, including test descendants. If Bash remains
alive five seconds later, GNU `timeout` sends SIGKILL. If Bash exits first,
`timeout` exits too: a descendant that ignores SIGTERM can survive. This bounds
the reproduction command, not every possible descendant. After an interrupted
or timed-out test, check for remaining test processes and stop those you own
before another attempt. A timeout normally returns 124 (or 137 after SIGKILL),
not a test assertion result. Do not add `--foreground`: it would exclude children
from the timeout's group handling. Increase the limit only for a known longer
focused test, and keep it finite. Traps cannot run after SIGKILL of the shell
itself; do not kill the outer timeout to stop the reproduction.

**In a unit test, a timeout is a hang guard, never the thing the test waits on.**
Wait for the product's own signal: an event, a callback, a store write, a file
the fixture publishes. A test that proves something did NOT happen moves past
the window with fake timers, or says at the call site why it needs real time.
Size a bound per step, not per row or sequence: a loop of N turns gets a
per-turn budget, or a window that restarts on each sign of progress
(hearsay-tools/cezarion#1145). A product budget a test shrinks, such as a Git
timeout or an autosave budget, applies only to the step it exercises and never
races its own fixture's startup (hearsay-tools/cezarion#1144,
hearsay-tools/cezarion#1146). Any bound that remains states its reason at the
call site, as a `// bound: <reason>` comment. In the server unit tests,
`packages/cezar/src/test-wait-discipline.test.ts` flags bare sleeps and wait
bounds under 10 s against a baseline that only shrinks; Vitest's 1 s default
for `vi.waitFor` and `expect.poll` counts as one. A new site gets the product's
signal or a `// bound:` reason, never a baseline entry. After fixing a site,
shrink the baseline with
`TEST_WAIT_DISCIPLINE_UPDATE=1 npm test -- packages/cezar/src/test-wait-discipline.test.ts`.
The scan cannot see a shrunk product budget, so review checks that one.

When a PR adds or splits a Vitest unit test file taking longer than about one
minute on CI, add or update its repository-relative path and measured duration
in milliseconds under `durationsMs` in `.github/test-durations.json`. Use the
passed per-file Vitest suite-summary line in the CI log, not an individual test
timing or total job duration; record the source run and commit in provenance.
For split files, measure each resulting file separately. Keep browser E2E weights
in their separate manifest. See [the Vitest sequencer](docs/sdlc/ci.md) for its
balancing-only role and median fallback for unlisted files.

**The final gate and full-suite runs belong in CI.** Do not run the entire local
gate, `squeal run --all`, or the full Vitest or browser suite just to finish a
task, commit, open a PR, or complete a review. Run a full local suite only when
explicitly requested or needed to investigate a CI failure. A full local Vitest
run is CI's three shards, one after another: `npm test -- --shard=1/3 --maxWorkers=4`,
then `--shard=2/3` and `--shard=3/3` with the same flags. An unsharded `npm test`
is not the local full gate: on a host with about 30 GiB free it can be OOM-killed
(exit 137). Squeal reuses cached
results at startup (`baseline.onStart: "lookup-only"`) and validates edits without
a cold-start full run; its Stop policy requires neither a full nor a slow suite.
Record the tested revision (or uncommitted diff), commands or Squeal status,
outcomes, and subsequent edits in the handoff. After later code changes, rerun
affected checks. A targeted run, skipped browser suite, or old pass for changed
inputs never counts as a full pass. CI independently enforces the complete gate
in `.github/workflows/ci.yml`; check its required aggregate before merge.

A PR that edits `ci.yml`, or a workflow it calls, does not run its own definition.
CI triggers on `pull_request_target`, which loads the workflow from the base branch,
so every check on the PR can pass while a new step never ran. To prove a `ci.yml`
change before merge, push the branch and run `gh workflow run ci.yml --ref <branch>`
without `-f pr_number`, which only bot release PRs take. The dispatched run uses the
branch's `ci.yml` on the pushed head, with the full matrix. It skips both publishing
jobs, so it publishes nothing: `publish-snapshot` runs only on a push to `main`, and
`prepare-pr-snapshot` only on `pull_request_target`. It also skips `review` and
`review-result`, so it never exercises `automated-code-review.yml`, the one workflow
`ci.yml` calls. The dispatched run does not satisfy the PR's required checks (see
`docs/sdlc/ci.md` § Diagnostic dispatch), so cite its run ID in the PR's
Verification section. Run `38979957113` proved the new `Lint workflows` step of
hearsay-tools/cezarion#1199.

A full local Vitest run (or one shard) that fails only under host load can still
back a PR. Record the load average (`uptime`) and the failed files, rerun those
files (`npm test -- <files>`) until they pass, state both in the PR's
Verification, and let CI's Vitest shards decide. Squeal reports and
`squeal why <check>` output are the same evidence. The rerun is not a full pass;
green CI shards are. A failure in a file the branch touches never qualifies: fix it.

Count a test file's observed CI failure annotations across rerun attempts with:

```bash
node .github/scripts/count-test-ci-failures.cjs live-preview.e2e.ts --repo hearsay-tools/cezarion --runs 20
# Or select runs by creation time (inclusive UTC timestamps):

node .github/scripts/count-test-ci-failures.cjs live-preview.e2e.ts --repo hearsay-tools/cezarion --since 2026-10-22T00:00:00Z --until 2026-10-23T00:00:00Z
```

The command uses authenticated `gh` reads and defaults to the current repository's
latest 20 `ci.yml` runs. It scans every attempt, including runs whose latest
conclusion is success. Use a literal file name or path; matching uses annotation
paths and titles, not stack references in messages. It prints each matching
failure and separate totals for failing runs, failing attempts and runs scanned.
These are observed annotated failures: no matching annotation does not prove a
test ran or passed, and the count is not a pass rate. Missing data, unfinished
attempts, changed run metadata, GitHub's date-query cap, or the 1,500-request /
12-minute limits produce an incomplete report and exit 1. Narrow the range and
repeat an incomplete scan. This evidence does not replace the reproduction or
before/after verification required for a changed wait.

**When filing a load-dependent test failure, preserve the diagnostic evidence.**
Quote the full error line verbatim, with nothing cut, including any list after
its `;`. Name the stack frame that throws the error, rather than an operation
named in the message. Give the full log location: the originating repo's
`.ai/cezar/runs/<runId>.ndjson` (or `.ndjson.br`), or `squeal why <check>`
with the check identifier and its worktree path.

Plain text searches do not read Brotli-compressed `.ndjson.br` logs. To read one,
replace `<file.ndjson.br>` with its path:

```bash
node -e "process.stdout.write(require('node:zlib').brotliDecompressSync(require('node:fs').readFileSync(process.argv[1])))" '<file.ndjson.br>'
```

CI's final gate covers:

```bash
npm run typecheck   # refresh server declarations, then check all four workspaces
npm test -- --shard=N/3 --maxWorkers=4  # vitest, N=1..3 — server + cockpit unit suites
npm run test:unit   # node:test — fast core-module coverage (packages/cezar/test/unit/)
npm run build       # tsc → dist/, vite → packages/cezar/web/dist/, then the check:pack tarball gate
npm run test:package # pack/install the release tarball and exercise the built CLI (packages/cezar/test/e2e/)
npm run test:e2e     # cockpit browser E2E in CI shards; skipped is not a pass
```

For web-only verification, use `npm run typecheck:web` or
`npm run typecheck -w @open-mercato/cezar-web`. Both rebuild server declarations
from this worktree before checking web sources; direct `tsc --noEmit` does not.
The full root typecheck runs web first, preparing declarations once for all four
workspace checks.

To typecheck without rebuilding `packages/cezar/dist`, for example while Squeal
is validating, run both server configs from `packages/cezar`. The root
`npm run typecheck` rebuilds `dist` first, and Squeal then marks dozens of
passing checks UNKNOWN (hearsay-tools/squeal#33).

```bash
./node_modules/.bin/tsc --noEmit -p tsconfig.json       # shipped sources only
./node_modules/.bin/tsc --noEmit -p tsconfig.test.json  # adds every test file
```

`tsconfig.json` leaves out every test file: on hearsay-tools/cezarion#1291 a
TS2353 in `src/runs/waits-store.test.ts` passed it and failed CI.
`tsconfig.test.json` sets `rootDir` to `.`, so only `tsconfig.json` reports a
shipped file that imports from outside `src/`. `tsconfig.test.json` also
compiles the `test/e2e/` imports of `../../dist/`, so in a worktree that was
never built it fails with TS2307: run `npm run build -w @wjarka/cezarion` once
first. For contract edits, also run `npm run typecheck:contract` from the repo
root. It checks `packages/contract/tsconfig.test.json`, because that package's
`tsconfig.json` leaves out its tests too. Run the root `npm run typecheck` once
before a PR when declarations matter: a cockpit edit, or a server change that
the cockpit reads through `AppType` or that a `test/e2e/` file imports from
`dist`. Expect the UNKNOWN burst then.

`npm test` and `npm run test:unit` are the fast unit gate: no server, no browser. They must stay that way. `npm run test:package` needs a completed `npm run build` (it packs the tarball). Pull request CI runs packaged CLI E2E and cockpit browser E2E as separate checks; the required aggregate fails if the cockpit suite is skipped or failed.

**When a manual Vitest run is needed, use npm, never `npx vitest`.** It is a devDependency of this repo, so `npm test`
uses the installed, version-pinned binary; `npx` will happily reach past it and fetch a different
version from the registry, which is a slow, networked, silently-different test run. To narrow a run,
pass vitest's own arguments after `--`:

```bash
npm test -- packages/web/src/routes/settings   # one directory
npm test -- --testTimeout=30000 path/to/one.test.ts
npm test -- -t "the name of one test"
```

When Squeal is unavailable, `npm run test:changed` compares the branch against
the merge-base with local `origin/main` (or `main`), including staged, unstaged,
and untracked files. Use
`-- --base=<ref>` to override, or `-- --plan` to inspect without running tests.
It selects Vitest tests through the import graph for ordinary source changes;
shared/configuration/unknown inputs, deletions, or unavailable Git/base information
fall back to full Vitest. Clean changes, and changes confined to CI's docs-only
list, explicitly skip iteration tests. `isDocsPath` in
`.github/scripts/change-surface.cjs` is the exact definition. The list includes
root Markdown and `LICENSE*`, `docs/`, `.ai/specs/`, `.ai/analysis/`, the
generated upstream scan data, and Markdown under `packages/` outside
`fixtures`, `__fixtures__` and `__snapshots__` directories. It excludes
`testReadDocuments`, the Markdown a Vitest test or cockpit browser spec reads,
which runs full Vitest. `.github/scripts/change-surface-readers.test.cjs` fails
when package code names a docs-only Markdown file by path. No matching tests is
an error: select the relevant test files explicitly and report any coverage gap
rather than treating it as a pass. Import graphs do not cover every runtime
dependency, so this command is only iteration feedback, never a replacement for
CI's final gate.

Cockpit browser E2E is a separate command from packaged CLI E2E — it boots the real app and
drives it in a real Chrome through the `agent-browser` provider (`.ai/browsers/agent-browser.md`):

```bash
npm run test:e2e    # .ai/scripts/e2e.sh → test-env-up.sh + vitest (packages/web/e2e/)
npm run test:e2e:local # explicitly requested full local browser run, four lanes (~8 GiB peak)
```

Use `npm run test:e2e` for focused local specs and CI's serial shards. Reserve
`npm run test:e2e:local` for an explicitly requested full local browser run or CI
failure investigation. The four-lane command prints the same
`TEST_E2E_STATUS` marker, exits nonzero on `skipped` or `failed`, and retains per-lane
logs under `.ai/qa/local-runs/`; see
`packages/web/e2e/README.md` for its isolation and cleanup details.

It boots the app on a free port with `CEZ_DRY_RUN=1` (agent CLIs mocked — no login, no
network) from the `VITE_CEZ_E2E=1` build that `.ai/scripts/build-e2e.sh` writes into the
ignored `.ai/qa/build/cezar` — never `packages/cezar/dist` or `packages/cezar/web/dist`, which
stay the production build — serves an isolated clone of the checkout at `.ai/qa/served/<name>`, never
the checkout itself, whose `.ai/cezar` may be the live cockpit's (specs seed state under
`servedRoot()`), reuses an already-healthy instance instead of double-booting, and writes
`.ai/qa/test-env.json` so QA skills attach to the same instance. Stop it with
`.ai/scripts/test-env-down.sh`. The server also stops on its own (hearsay-tools/cezarion#1448):
a watcher next to it stops it when its checkout or served clone is deleted, or after
30 minutes with no test-env lease holder. `TEST_ENV_IDLE_EXIT_MINUTES` changes that idle
period, and `0` turns the idle exit off, for example for a long QA session that attaches
without a lease. `TEST_ENV_WATCH_INTERVAL_SECONDS` (default 30, from 0.1 to 3600) sets how often it checks.
A run with other values for either variable boots a new server rather than reusing the running one.
Local exit contract:

| Exit     | Marker                    | Meaning                                                                                                           |
| -------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 0        | `TEST_E2E_STATUS=passed`  | every selected spec passed; a filtered run is not a full-suite pass                                                                                                 |
| 0        | `TEST_E2E_STATUS=skipped` | agent-browser could not be provisioned (no network / unsupported platform); prints a loud banner — **not** a pass |
| non-zero | `TEST_E2E_STATUS=failed`  | a spec failed, or the env could not boot                                                                          |

Pull request CI pipes that log through `.github/scripts/require-e2e-passed.cjs` and fails
on skipped or failed.

A red spec leaves evidence behind (hearsay-tools/cezarion#408): the seam in `packages/web/e2e/agent-browser.ts`
writes `.ai/qa/failures/<spec>/<test>-<n>/` — viewport `screenshot.png`, `snapshot.txt`
(`snapshot -i`) and `probe.json` (URL, the selector or predicate that timed out, focused
element, the target's count/rect/computed style and the element under its centre) — when a
`wait` gives up, and `packages/web/e2e/failure-setup.ts` writes the same bundle from
`onTestFailed` for a plain `expect` failure. The thrown error names the directory; CI
uploads it as the `cockpit-failures-shard-<n>` artifact and lists it in the step summary.
Read the bundle before theorizing about a flake. For CPU-dependent failures, see
[One-CPU load reproduction](#one-cpu-load-reproduction). Writing or fixing a spec starts at
`packages/web/e2e/README.md`: the wait rules the `e2e-wait-discipline` unit test enforces,
how to read a bundle, and the single-test reproduction with an env-gated server delay.

`CEZ_DRY_RUN=1 npm run dev` still exercises the whole cockpit offline for manual verification.

## Related documents

- `AGENT_PROTOCOL.md` — the agent protocol: the runner seam, the v1 `AgentEvent` + v2 `UiEvent` streams, per-backend mapping, the two parity matrices (§6 mapper capabilities, §7 session and lifecycle), the golden-fixture testing contract, and the checklist for adding a new runner.
- `SDLC.md` — ticket flow, label state machine, QA gate, claim protocol.
- `CODE_REVIEW.md` — what reviewers check and how severities are assigned.
- `BACKWARD_COMPATIBILITY.md` — the public surfaces you must not break silently.
- `.ai/agentic.config.json` — machine-readable pipeline config every om-* skill reads (base branch, validation commands, labels).

### Dev flow bindings

Concrete values for this repo, in one place so every contributor — human
or agent — reads the same ones. Rows are matched by label, so update a
row's value when the thing it names changes, rather than its label.

| Binding | Value |
|---|---|
| Default branch | `main` |
| Branching model | GitHub flow — feature branches off `main`, pull requests based on `main` |
| Code host | GitHub |
| CI provider | GitHub Actions |
| Issue tracker | GitHub Issues |
| Stack | TypeScript (Node ≥24.15), pnpm workspaces (npm script metadata retained); Hono + Zod server; React 19 + Vite + Tailwind v4 cockpit |
| Verification | Local: Squeal when installed and validating, otherwise focused npm checks. Full gate in CI: `npm run typecheck`, `npm test -- --shard=N/3 --maxWorkers=4` (N=1..3), `npm run test:unit`, `npm run build`, `npm run test:package`, `npm run test:e2e` |
| Automated reviewer | `AUTOMATED_REVIEWER=codex`. A pushback-only round needs a manual dispatch of `automated-code-review.yml` with `pr_number`, then a re-run of **Review / review-round** in the CI run. Re-running the CI run's failed jobs alone does not re-judge. |
| Automated review rounds | The `AUTOMATED_REVIEW_ROUNDS` repository variable, read with `gh variable get AUTOMATED_REVIEW_ROUNDS`; the review workflow falls back to 3 only when the variable is unset or empty |
| Commit convention | Conventional Commits |
| Specs and plans | unknown |
| Board | **Cezarion**, org `hearsay-tools`, project #1. For same-repository PRs targeting `main`, `.github/workflows/pr-readiness.yml` owns draft state and syncs existing PR and closing-linked issue cards: draft → In progress, ready → In review. Each new head returns the PR to draft; the workflow marks it ready when the head's required checks pass and no review thread is unresolved. Open a draft PR, fix its checks and review threads, and let the workflow move it to ready and In review; do not move the card to In review or run `gh pr ready` by hand. Board sync skips without project access and never moves Done cards back. The initial claim still moves the issue to In progress. |
| Auto-merge | Read `.ai/skills/auto-merge/SKILL.md` before you open a pull request into `main`, and after each push, CI result, review round or draft/ready change on one you opened with the `auto-merge` label. It decides whether the PR merges without owner review; every merge it makes is a squash. |
| Code quality | Read `.ai/skills/check-code-quality/SKILL.md` before opening a pull request. Check changed functions, make small fixes and file inherited refactors as labeled issues. |
| Task orchestrator | Cezar |
| SDLC feedback | `apptension/toolkit-dev` |
