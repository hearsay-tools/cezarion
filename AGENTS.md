# AGENTS.md — working in this repository

cezar is a **parallel coding-agents orchestrator**: a local cockpit (CLI + browser GUI) for running and tracking AI coding-agent tasks in a repo. Each task runs a workflow on one backend from `RUNNER_IDS` (`packages/cezar/src/core/agent-runner.ts`), or a mix per step, in its own git worktree; it ends at a review gate (never auto-merges) and can be pushed as a draft PR through `gh`. Everything is local: no accounts, no database server, no cloud. State lives under `.ai/cezar/`: one embedded SQLite run store (`runs.db`, `node:sqlite`) plus plain JSON, NDJSON and Markdown. The stack stays deliberately small: strict TypeScript (ESM, Node 24.21.0+), Hono + SSE, Zod at every boundary, YAML workflows, and a React 19 + Vite + Tailwind v4 + shadcn/ui cockpit compiled to static assets. Every module is meant to be read in one sitting.

Architecture decisions live in [docs/adr/](docs/adr/). Consult the relevant records before changing a mechanism.

This file holds what every task needs. A new agent rule goes in the narrowest document its tasks already read, as [docs/sdlc/friction.md § Where a new agent rule goes](docs/sdlc/friction.md#where-a-new-agent-rule-goes) says; this file gains at most a pointer to it. `.github/scripts/agents-md-budget.test.cjs` holds this file to a byte limit that only goes down.

## Issue and PR citations

This fork is `hearsay-tools/cezarion`; upstream is `open-mercato/cezar`. Both
trackers reuse numbers and upstream history predates the fork, so never infer the
tracker from the number or the current remote. Cite issues and PRs as
`hearsay-tools/cezarion#N` / `open-mercato/cezar#N`, `fork #N` / `upstream #N`,
or a repository-qualified GitHub link. When attribution is uncertain, check the
source link, tracker title and git history. A bare `#N` in older code is legacy,
not a style to copy: CI's `Check issue citations` step fails a change that adds
one. Run `node .github/scripts/check-citations.cjs` before a PR.

An archive may keep bare citations under a source note naming its repository and
snapshot; new prose in it still qualifies each reference. Upstream commit titles
and ledger fields follow [the ledger guide](.ai/upstream/README.md#citation-provenance).
Example protocol markers, test filters, UI sample numbers, spec numbers, colors
and shell syntax are not citations.

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

Replacing working behavior is the highest-risk change in this repo. It fails in a
characteristic way: the new mechanism is correct, the tests are green, the spec is
thorough — and the DEFAULT path quietly lost a **load-bearing** guarantee, one that
other code reaches a correct state *because of*, whether or not anyone wrote it down.
open-mercato/cezar#810 and open-mercato/cezar#811 both shipped a well-specified
improvement that left the zero-config user worse off than before.

**Name what the old mechanism was load-bearing FOR, not what it was for.**
`IDLE_TIMEOUT_MS` read as session hygiene, and open-mercato/cezar#661 removed it from
the monitoring branch for a good reason (it closed live sessions mid-CI and recorded
them as `done`). It was also the only liveness bound on `CEZ:MONITORING` and the only
reason a parked monitor released its `maxParallel` slot, so `monitoring` became a
state with no exit. Before deleting a timer, lock, cap or timeout, grep for
everything that reaches a terminal state *because* of it.

**Name the load-bearing guarantee before changing a test's expected outcome.** When a
change edits the expected outcome of an existing parity or regression test, the plan —
or the PR body when no plan exists — names the guarantee the old outcome pinned. It
explains how the change replaces that guarantee, or why it is dropped and where the
follow-up is tracked. Recording a follow-up does not itself authorize dropping a
guarantee (hearsay-tools/cezarion#1662: the P8 `permission-late` cell stopped
requiring a late permission card; the owner chose follow-up hearsay-tools/cezarion#1680).

**A replacement that ships OFF is not a replacement.** Diff the default path, not the
feature: *with every new knob at its shipped default, what does the old scenario do
now?* If the answer is "nothing", the change removed a mechanism and added a setting.
A spec's "Resolved assumptions" table answering a COST question with "opt-in, default
null" does not show that the zero-config path still works — cost-safe and functional
are separate reviews. See § Zero config: *never trade a working default for a knob*.

**Preserve queue-head reads when changing queue boundaries.** When splitting, merging
or re-keying a queue, list every value the old task read when it reached the queue
head, and read each one again at the head of the new queue. Carry stable identity
through the queue rather than an earlier copy of mutable settings
(hearsay-tools/cezarion#1639: dispatch-time snapshots kept removed webhooks and stale
URL, token and trigger settings until sends started). Test the boundary: hold the head
task, enqueue another, change the value, release the head, and assert what the queued
task used. Cover removal or deselection when applicable.

**Enumerate the transitions out of every state you add or keep.** "Who fires this?" is
the question that finds these bugs in one step. A parked run wakes only through a path
someone wrote: a human message, the turn-end nudge, the resolution of a durable wait it
registered (the wait kinds in `packages/contract/src/waits.ts`), conversation input from
a worker or parent, a usage-limit auto-resume, or native runner activity on a monitoring
or worker park (`workflows/run.ts`). No other event calls back, so a state whose only
on-by-default exit is "a human types something" is a dead end, however well it renders. The plan carries a **Transitions out** case table (below).

**Commit an outcome with what it depends on, or after it.** A write that records an
outcome (`delivered`, `charged`, `settled`, `answered`) must commit atomically with the
write holding what that outcome needs, or after that write commits. Check every crash
boundary between the writes: a delivered answer must already be saved, and a delivered
automatic wake must already be charged. A best-effort write in a cleanup path must
never throw past the cleanup and prevent it from finishing. Test the boundary by
reading the **committed row** at the point a crash would hit, rather than checking only
the final state or the in-memory object (hearsay-tools/cezarion#1250: a wake delivered
without its charge, a counter write blocking Finish, a Continue settling its human wait
before saving `continuationMessage`).

**Test the path with no live session.** When changing a path that reads
`this.active.get(runId)`, add a test with no session. Restart recovery and scheduler
continuations can reach the path before a session exists; an absent entry must still
produce the required durable outcome and a usable next step (hearsay-tools/cezarion#1250:
recovery wording that assumed cezar tools, a timer resuming a continuation without its
tool controller, a budget-cap wake cancelling its timer without opening the budget wait).

**Find every construction site of a shared in-memory object — grep the TYPE, not the
field.** `ActiveRun` is built in `execute` AND in `runContinuation`;
open-mercato/cezar#811 populated `state.skills` in the first only, so registry `/skill`
expansion silently failed on every Continue and every restart recovery. When you add a
field that a delivery path reads, add it everywhere in the same commit or route both
sites through one helper.

**List each handler's side effects, in order, before you merge handlers into one.** The
merged method can lose one step of a handler's order while every test stays green. For
each entry and each case, list what each handler does, in order: its input delivery,
the timers or waits it opens, the gates it calls, and the heartbeat or note it writes.
Pin each line with a test, or name the test row that already covers it, before you
delete the handler (hearsay-tools/cezarion#1534: merging the turn-end handlers into
`settleTurn` settled a mid-turn refusal before the turn ended, and skipped the
monitoring timer for a turn that also carried an ask).

**A fail-open helper needs a populated-input guarantee, or it lies.**
`expandRegistrySlashSkill` returning its input unchanged on no-match is right on its own —
a backend's own slash commands must survive. Against an empty registry that same branch
turns "cezar never loaded the list" into a confident user-facing "Unknown skill". Pair
every silent pass-through with a test that pins the *empty/absent input* case.

<a id="regression-proof"></a>

**Prove the regression test fails without the fix.** Pin the pre-fix commit as
`proof_base` and record the command, expected failure and fixed pass. A test written
after the diagnosis can pass against the bug; a green-either-way test does not prove
the fix. Keep the guard tests that pass both ways — they pin behavior you did NOT
want to change (park mode stays reachable; unknown slashes stay untouched) — but
know which is which. A **test-only change that removes a hidden dependency** (on a
catalog, a host setting or a default the test did not write) needs this proof even
when no failure has been observed. Run the proof in a disposable worktree or an
ignored scratch copy, never through the shared stash stack:
[`docs/sdlc/regression-proof.md`](docs/sdlc/regression-proof.md) has the recipes for
a source fix, a test-only fix and a removed hidden dependency, and how to cite the
evidence.

**Read the run-history evidence before theorizing, and cite it.** `.ai/specs/` records
the design, `git log -S` and `git merge-base --is-ancestor <commit> <tag>` settle "was
this in the release the user is on", and a user's "it worked in 0.9.1" is a testable
claim, not an opinion. open-mercato/cezar#810 was confirmed in one command before a
line of code was read.

### Case tables

Some changes fail in cases nobody listed. For these changes the spec or plan MUST
carry a **case table**, reviewed with the spec or plan before implementation starts:
one row per case, every required case covered, behavior shown at shipped defaults,
and a case that cannot happen stated with the reason.

| Change | Table and columns | Required cases |
| --- | --- | --- |
| Adds or changes a run state | **Transitions out**: State · Trigger · Who or what fires it · Behavior at shipped defaults | One row per exit of every state the change adds or keeps. Say so explicitly when a state's only default exit is a human action, and when it has no default exit. |
| Changes how `allowedTools` or `bashAllowlist` maps onto a runner's tool flags | **Tool-list kinds**, one per affected runner: Input kind · Emitted runner flags · Callable built-in, MCP and extension tools at shipped defaults | `allowedTools` unset; the step default from `allowedToolsForStep`; a list inherited from another runner's default (such as a pi worker spawned from a Claude parent); a hand-written copy of the default list; the default plus an extra built-in or custom name; the default plus an `mcp__` name; a narrowed list; an empty list; a list with a `bashAllowlist`. Show effective tool access, not only the flags sent, and say when a runner ignores a restriction or cannot distinguish two kinds. |
| Adds, replaces or removes files in a running task's worktree, such as skill copies from `packages/cezar/src/skills-provision.ts` or the personal config layer from `packages/cezar/src/agent-config/seed.ts` | **Worktree cases**: Case · Files written, kept or removed · Worktree state at the next step, Continue and restart | A catalog or source that has not loaded yet; the same name from two sources; records written by an older cezar version; a crash between two writes (see *Commit an outcome with what it depends on, or after it*); edits the agent made to the files, including files it added; the source removing the item. |
| Starts a process that outlives the command that started it: a detached server, watcher or daemon | **Process exits**: Case · What stops it · Behavior at shipped defaults | The normal stop; the starting command interrupted by SIGINT or SIGKILL in each phase, before and after the process starts; the leader exits before its children; a member ignores SIGTERM; members stay zombies because their parent never reaps them; the start identity cannot be read; the leader's PID is reused; the handle the stop reads, such as a descriptor or lock file, is deleted or forged. |

Each table exists because a plan named only the obvious case and review rounds found
the rest: hearsay-tools/cezarion#1305 and hearsay-tools/cezarion#1360 (tool lists with
extra MCP names and hand-written default copies), hearsay-tools/cezarion#1494 and
hearsay-tools/cezarion#1539 (three fix rounds on switched-off skill copies, then a
revert), hearsay-tools/cezarion#1406 and PR hearsay-tools/cezarion#1708 (five review
rounds on process exits). The table makes the cases explicit for design review; it
does not decide which ones share a policy. The phase tables in
[the unified-waits spec](.ai/specs/2026-10-17-unified-waits.md) (§ Transitions out
(phase 2a) and later) show the form.

<a id="reader-sweep"></a>

### Reader sweep

A change to a shared name, value or default needs a **reader sweep**: find every reader
of the thing you changed — code, unit tests, browser specs, packaged fixtures, messages
that name it — and update each one, or state in the plan or PR why it stays. Search for
the old and the new form, because a reader can assert that something is present or that
it is absent. Inspect every match: common names match unrelated text, and compatibility
names, intentional refusal tests, legacy-row conversion tests and historical references
stay. The construction-site rule above is the sweep for a shared in-memory object, and
the Task routing rows for run search, pending asks and skills list their readers.

Where readers hide, searched from the repo root (replace the example values):

- **A `RunRecord` field renamed, moved or removed**: packaged and browser fixtures, by
  its old and new names or paths (hearsay-tools/cezarion#1300).

  ```bash
  rg -l -F -e 'delegation.wait' -e 'waits' packages/cezar/test/e2e/*.test.ts packages/web/e2e/*.e2e.ts
  ```

- **An enum or discriminant value renamed** (a wait kind, outcome, status or attention
  label): the quoted old value in tests, searched before each push that renames one,
  not only before the PR opens. A rejection test that passes only because the
  old value is now unknown must be updated to test its intended constraint
  (hearsay-tools/cezarion#1504).

  ```bash
  rg -n -F -e "'ci'" -e '"ci"' packages --glob '*.test.*' --glob '*.e2e.ts'
  ```

- **A default removed** (a catalog, a source or a seeded entry): browser specs, by its
  entry names, source names and the `data-slot` of each list or view that renders those
  entries — a spec can depend on how many entries a list holds without naming any of
  them. A spec that counts, lists or scrolls the default's entries must seed its own, as
  [the e2e README](packages/web/e2e/README.md#seed-the-catalog-entries-a-spec-relies-on)
  says (hearsay-tools/cezarion#1541 broke `settings-skills.e2e.ts` only in CI, through
  its scroll case; hearsay-tools/cezarion#1572).

  ```bash
  rg -l -F -e 'open-mercato/skills' -e 'skill-row' packages/web/e2e/*.e2e.ts
  ```

- **Cockpit source changed**: browser specs, by the `data-slot`, `data-streamdown` and
  `data-testid` values and distinctive class names that the changed file and the local
  components it imports render. No tool maps a cockpit change to its specs:
  `npm run test:changed` holds no browser spec, and Squeal's browser-spec inputs include
  all of `packages/web/src/**`, so an edit marks every spec stale and names none. Walk
  down to what the file renders, never up to what renders it: going up reaches most of
  the suite. Shared renderers such as `packages/web/src/routes/task-thread/markdown.tsx`
  and `packages/web/src/components/diff/*` matter most, because one edit reaches specs
  written for other features — `markdown.tsx` renders no `data-slot`, yet an edit to it
  broke `artifact-project-links.e2e.ts` through its siblings `task-link.tsx` and
  `link-safety-dialog.tsx` (hearsay-tools/cezarion#1076).

  ```bash
  grep -lE 'link-safety|data-streamdown|thread-markdown' packages/web/e2e/*.e2e.ts
  ```

- **Visible copy added, renamed or removed** (a label, a tab, a heading, a button, an
  empty state): browser specs, by the new and the old string; the attribute search does
  not find text assertions (hearsay-tools/cezarion#1335: the attribute search found
  `quick-list.e2e.ts` and `mobile-task-controls.e2e.ts`, but `automations.e2e.ts`, which
  asserts the sidebar does not show "Automations" while the feature is off, failed in CI).

  ```bash
  grep -lF 'Automations' packages/web/e2e/*.e2e.ts
  ```

- **A cockpit control renamed or removed**: server and contract sources, by its old label
  and the navigation text that led to it. Update messages that tell users where to find
  the control, including API errors, CLI output and agent prompts; do not replace every
  match blindly (hearsay-tools/cezarion#1639: `NO_WEBHOOK_ERROR` still named the removed
  "Task webhook" control).

  ```bash
  rg -n -F -e 'Task webhook' -e 'Settings → General →' packages/cezar/src packages/contract/src
  ```

- **Dry-run turn-end behavior changed** — the `packages/cezar/scripts/mock-*.mjs` mocks,
  the turn-end rule, attention, or the human-ask summary: the browser and packaged
  fixtures that drive a dry-run task to a park (hearsay-tools/cezarion#1251). A
  `mock-*.mjs` edit counts when it changes the frames that an existing `mock:<scenario>`
  sends, or where that scenario's turn ends, for the configuration a runner sends at
  shipped defaults. A new scenario does not count, and neither does a branch that the
  shipped configuration never reaches, such as one for a misconfigured runner or for a
  configuration no runner sends yet (hearsay-tools/cezarion#1334). When a mock edit does
  not count, the PR's Verification section says why.

  ```bash
  P="waitForStatus\([^)]*'waiting'|hasPendingHumanAsk|attentionLabel|'mock:"
  grep -lE "$P" packages/web/e2e/*.e2e.ts packages/cezar/test/e2e/*.test.ts
  ```

Require passing results for the specs and fixtures the sweep selects. Read browser specs
through Squeal (`squeal status --wait 60000 <files>`, then `squeal run --slow --wait 60000`
if slow results are not current), or without it run `npm run test:e2e -- <specs>` (one
call takes several specs). Run packaged fixtures by hand after a fresh build
(§ Validation → *Packaged CLI E2E runs by hand*). Dry-run park fixtures also need the
unit parity suites in
[Runner regressions ship with shared coverage](#runner-regressions-ship-with-shared-coverage).

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
inside Squeal's per-file cap (`runner.timeoutMs` in `squeal.config.json`) on a
loaded host. When a parity suite grows past that, run its `RUNNER_IDS` cells
from one file per runner, defined once in a `*-cells.testkit.ts`, and add a
guard that every runner has its file. Split a runner's file again by row group
when one runner alone is too slow.
`core/harness-parity-cells.testkit.ts` and
`workflows/waits-parity-cells.testkit.ts` are the examples
(hearsay-tools/cezarion#1288). Vitest 4 fails a suite that registers no test,
so the file that runs the guard and the single-runner cells must not register
a `describe` whose body holds only runner cells; `describeRunners` in
`core/harness-parity-cells.testkit.ts` is the example
(hearsay-tools/cezarion#1375).

Before opening a PR that changes `packages/cezar/src/workflows/run.ts`'s wait,
turn-end, failure or step-settlement paths, verify every suite matching
`packages/cezar/src/core/*-parity.test.ts` and
`packages/cezar/src/workflows/*-parity.test.ts`: with Squeal, run
`squeal status --wait 60000 packages/cezar/src/core/*-parity.test.ts packages/cezar/src/workflows/*-parity.test.ts`
and require a passing verdict for every selected file that gets one. Repeat the
wait only for files that are still pending. When a file gets no verdict, follow
[the bound on a Squeal wait](#squeal-wait-bound): run the parity cells that the
change affects with `npm test -- <file> -t '<name>'`, record them in the PR's
Verification, and let CI's Vitest shards give the file's full verdict. Without
Squeal, run
`npm test -- packages/cezar/src/core/*-parity.test.ts packages/cezar/src/workflows/*-parity.test.ts`.

## The HTTP API

Four invariants. A feature that breaks any of them compiles on its own branch and stops working
when it lands — open-mercato/cezar#694 arrived with eleven unreachable routes for exactly this reason.

- **Every request and response shape is a zod schema in `packages/contract`, with its TypeScript
  type inferred from it (`z.infer`).** Never hand-write an API type, and never declare one in
  `server.ts` or in the api-client. The api-client re-exports the contract; the cockpit imports
  the schema when it wants to validate and the type when it wants to compile.
- **Register routes by CHAINING them into a family builder**, the way the ~24 families in
  `server.ts` already do. Hono accumulates route types through the chain only: a loose
  `app.get(…)` statement returns a value nobody keeps, so the route vanishes from `AppType`
  (`packages/cezar/src/server/app-type.ts`) and the typed client cannot see it — silently, with
  the server still serving it.
- **Validate bodies, path params and the query string as route MIDDLEWARE**, through the trio in
  `src/server/validators.ts` (`jsonZodValidator`, `paramZodValidator`, `queryZodValidator`), and
  read the result with `c.req.valid(…)`. Parsing inside a handler is invisible to hono, which is
  what let `POST /runs` accept `{ totalNonsense: 12345 }` from a typed client without complaint.
  The rejection shape is `{ error }` with 400/404/409.
- **Everything answers under `/api/v1`** (project-scoped: `/api/v1/p/:projectId/…`). The
  unversioned surface is gone.

The contract must describe EXACTLY what the route sends — no wider, no narrower. When a schema and
its route disagree, fix the SOURCE, never widen the schema; `contract-parity*.test.ts` asserts both
directions and a one-way check passes on real drift. An object-literal `type: 'x'` can widen to
`string` during hono's inference, erasing a discriminant consumers narrow on (`as const`).

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
handler's to refuse. In hearsay-tools/cezarion#1081 the create-project schema admitted names the
handler refused through `isValidCheckoutName`; one project-name pattern exported from the contract
now serves the schema, the handler and the New project dialog.

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

## Shared helpers

- **Shell quoting.** To build a POSIX shell word, use `shellQuote` from
  `packages/cezar/src/core/shell-env.ts`; `JSON.stringify` is not shell quoting, because `$()`
  and backticks still expand inside double quotes. Scripts in `.ai/scripts/` and root `scripts/`
  can import it from `packages/cezar/dist/core/shell-env.js` after a build, or keep a local copy
  with a test that runs its output through `sh` and checks that spaces, apostrophes, dollar
  signs, `$()` and backticks stay literal.
- **Source scanning.** The pinned TypeScript 7 package is the native compiler and offers no
  stable JavaScript compiler API (`typescript` exports only version fields). For
  source-scanning tests, reuse regex scans over `blank()` from
  `packages/cezar/src/test-wait-discipline.testkit.ts`; see
  `contract-import-boundaries.test.ts` and `test-wait-discipline.test.ts` for examples.

## Task routing

Before you change or review code in an area, read its *Read first* files. An area doc under `docs/areas/` holds that area's full rules; the row keeps only the rules a change most often breaks.

| When the task involves…                                                                                                                                                                                       | Read first                                                                                                                                                                                                                                    | Key rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI entry, `serve`/`run`/`init` subcommands, flags                                                                                                                                                            | `packages/cezar/src/index.ts`                                                                                                                                                                                                                                | Uses `node:util` `parseArgs`, no CLI framework. `serve` is the default command. Headless `run` treats `review` as a terminal success status (exit 0). `serve` boots in a fixed order: bind the listener, open the boot store and build its `RunManager`, `recover()` the boot project, then `startServer`. So anything a recovered run needs (its cockpit address, for one) must reach the boot manager at construction, not from `startServer`. `init` never overwrites existing files. Keep `.ai/cezar/.gitignore` maintenance (`ensureDataGitignore`) in sync with any new state file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Agent runners / backends | `AGENT_PROTOCOL.md` (the contract and the new-runner checklist), then `packages/cezar/src/core/agent-runner.ts`, `packages/cezar/src/core/runner-factory.ts` and the changed backend's `packages/cezar/src/core/*-runner.ts` | Every backend implements `AgentRunner`/`AgentSession` and must pass both parity matrices: `ui-parity.test.ts` (mappers) and `harness-parity.test.ts` (runners, including each runner's `specSupport`). Runner prose never counts runners. `CEZ_DRY_RUN=1` must keep working. The zero-config default includes unrestricted `Bash`, and each runner's `specSupport.allowedTools` says whether its wire honors the list (open-mercato/cezar#430). |
| HTTP server & API routes                                                                                                                                                                                      | `packages/cezar/src/server/server.ts`                                                                                                                                                                                                                        | Hono app, binds to `127.0.0.1` only. A global `/api/*` request-origin guard (open-mercato/cezar#426) runs before every route except `/api/v1/health`: it rejects non-loopback `Host` headers (DNS-rebinding) in local mode and cross-origin mutating requests (CSRF) in both modes — zero-config, no token, so the same-origin cockpit and the Vite dev proxy pass untouched. The loopback test is `isLoopbackHostHeader` (anchored 127.0.0.0/8, missing Host = untrusted); never match it with a `127.` string prefix. Routes, validation and shapes follow § The HTTP API. CORS is deliberately enabled for `/api/v1/health` only (cross-origin discovery); never widen it. SSE endpoints replay from NDJSON then stream live, deduped by `seq`.                                                                                                                                                                                                                                                                                                   |
| API request/response shapes (any new field, route or payload) | `packages/contract/src/*.ts`, then `packages/cezar/src/server/validators.ts` | Follow § The HTTP API: add the schema here FIRST, then chain the route and validate through the trio. `contract-parity*.test.ts` proves the schema and the route agree in both directions, and `typed-bodies.test.ts` proves the route reached `AppType` at all. |
| Real-time events (live UI signals, replacing polls) | `docs/areas/realtime-events.md`, then `.ai/specs/2026-07-23-websocket-subscriptions.md` and `.ai/specs/2026-10-08-browser-tab-coordination.md` | A new live signal is a topic on the one WebSocket bus (`/api/v1/ws`), never a `refetchInterval` or a new socket. Subscribe at the scope of the data's demand lifetime and return the unsubscribe; publish only on change. Topics are workspace-level and carry only data safe for any local page. |
| Workspace registry / per-user state (`~/.cezar/`) | `docs/areas/workspace-registry.md`, then `packages/cezar/src/paths.ts` | Every path goes through `cezarHomeDir()` (`CEZ_HOME`), and every `config.json` write through `mergeWriteWorkspaceConfig`. A corrupt or read-only home degrades to in-memory defaults with one warning, never a boot failure. Agent accounts live in their own file, `~/.cezar/agent-accounts.json`. |
| Project-scoped routes & contexts (`/api/v1/p/:projectId`, `/p/:projectId`) | `docs/areas/project-routes.md`, then `packages/cezar/src/server/project-context.ts` | Register each project route once in its family's chain; it answers under both `/api/v1/<path>` and `/api/v1/p/:projectId/<path>` (`route-parity.test.ts`). Workspace-level routes are single-mount. |
| Git / worktree logic | `docs/areas/git-worktree.md`, then `packages/cezar/src/git-worktree.ts` | A task diff's base comes only from `resolveTaskDiffBase` (`git-diff-base.ts`), given the run's `branch` and `startedAt`. Autosave commits only on the task branch, through `RunManager.saveWorktree`. Git helpers never throw, except `createWorktree`. |
| GitHub integration (issues/PRs tab, draft PRs)                                                                                                                                                                | `packages/cezar/src/server/github.ts`, `packages/cezar/src/server/pr.ts`                                                                                                                                                                                                    | Must degrade gracefully: no `gh`, no remote, offline all return `{ available: false, reason }` — never an error. `gh … --json` output is zod-validated at the boundary. `GITHUB_TOKEN` is the fallback when `gh` isn't authenticated. `createDraftPr` never throws; failures map to one-line human errors. `CEZ_DRY_RUN=1` fakes the PR URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Automations (GitHub polls and schedules) | `docs/areas/automations.md`, then `packages/cezar/src/automations/` | Opt-in behind `CEZ_AUTOMATIONS=1`. A schedule fire never advances `nextRunAt` on a lost lease. New skill lookups go through `RunManager.builtinSkills()`, and new session construction sites through `automationsPart()`. |
| Workflows (YAML chains, steps, retries)                                                                                                                                                                       | `packages/cezar/src/workflows/types.ts`, then `packages/cezar/src/workflows/load.ts`, `packages/cezar/src/workflows/run.ts`                                                                                                                                                                | A step is agent (`prompt`/`skill`) XOR check (`command`); a file has `steps` XOR the portable `skills` shorthand — both enforced by zod refinements. `onFail.retry` may only reference an _earlier_ step (`stepsIssue`). `{{task}}` is the substitution token. `quick-task` is the built-in zero-config workflow; built-ins always come back after delete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Run search (project tasks, All tasks, archived pages and ⌘K) | `packages/web/src/lib/tasks-table.ts`, `packages/web/src/routes/tasks-overview.tsx`, `packages/web/src/lib/global-tasks.ts`, `packages/web/src/routes/global-tasks.tsx`, then `packages/cezar/src/runs/run-search.ts`, `packages/cezar/src/server/server.ts`, `packages/cezar/src/runs/store.ts`, `packages/cezar/src/runs/run-index.ts` | `filterRuns` (`tasks-table.ts`) filters the project task list in `tasks-overview.tsx`. `haystack`, `filterGlobalTasks` and `tasksExcludingFacet` (`global-tasks.ts`) feed the All tasks list and its facet counts in `global-tasks.tsx`. On the server, `matchesRunQuery` and `sqlPrefilterTokens` (`run-search.ts`) serve `GET /api/v1/run-summaries/archived` (`server.ts`), `RunStore.searchRunSummaries` (`store.ts`) and the cold reader `searchRunIndexFromDisk` (`run-index.ts`) for the ⌘K palette. A new search field needs a [reader sweep](#reader-sweep) over every reader above, or the change explains why a reader leaves it out (hearsay-tools/cezarion#1637: archived pages, All tasks facet counts and server archive search each needed a follow-up fix). Preserve intentional differences: the palette excludes automation names because it shows no origin line, and the SQL prefilter must not discard a match the final predicate accepts. |
| Pending asks (`cezar_ask`, the ask card, a new field on the ask) | `packages/cezar/src/workflows/run.ts`, then `packages/cezar/src/runs/transcript-facts-fold.ts`, `packages/cezar/src/delegation/questions.ts`, `packages/web/src/routes/task-thread/thread-state.ts`, `packages/cezar/src/task-cli/projections.ts` | A pending ask has four kinds of reader. `workflows/run.ts` opens the human wait and emits the `ask.requested` event. `runs/transcript-facts-fold.ts` and `delegation/questions.ts` route a worker's question to its parent. `routes/task-thread/thread-state.ts` builds the cockpit ask card. `task-cli/projections.ts` (`projectStatus`, fed by `pendingQuestion` in `task-cli/cli.ts` and `runs/webhook.ts`) feeds `cez task status` and the task webhook; these read the `ask.requested` event, not the human wait, so a design that follows the wait misses them. A field added to the ask card needs a [reader sweep](#reader-sweep) over all four, or the spec says why a reader leaves it out (hearsay-tools/cezarion#1471: its `context` field missed the CLI and webhook projections). |
| Skills (Markdown playbooks, team repos) | `docs/areas/skills.md`, then `packages/cezar/src/skills.ts` | Fresh discovery goes through `discoverSkills`; a run's saved list is read through `provisionRunSkills` and `enabledSkills`. A change to which skills a run may use needs a [reader sweep](#reader-sweep) over every reader the area doc lists, or the spec says why a reader leaves it out. |
| Runs store / state persistence | `docs/areas/runs-store.md`, then `packages/cezar/src/runs/run-database.ts` | Only the live set is in memory: never keep or mutate a finished-run copy, and never rebuild a full scan of `runs` — add an indexed column. New `RunRecord` fields stay optional or defaulted. A store that cannot open never reads as empty. |
| Task handoff journal (`CEZ_HANDOFF_FILE`, `.ai/cezar/runs/<runId>.handoff.md`) | `docs/areas/handoff-journal.md`, then `packages/cezar/src/handoff.ts` | The top of `## Progress log` belongs to the agent. cezar writes its own records to a cezar-owned section, such as `## Autosave (cezar)`; only the lifecycle heartbeat lines go to the Progress log. |
| Web UI (cockpit) | `docs/areas/web-ui.md`, then `packages/web/src/app.tsx` | Keep one global SSE connection and patch the TanStack Query cache in place. Write query updates through `useSearchParamsWriter` (the area doc names the one exception). Preserve light/dark/system theming, mobile safe areas, keyboard access and unit coverage. |
| Agent config files (Settings → Agent config; grouped by agent, MCP as a per-agent subsection — spec 2026-07-17-agent-config-by-agent, descriptor table in `packages/web/src/routes/settings/agent-descriptors.ts`) | `packages/cezar/src/agent-config/` (`catalog.ts`, `files.ts`, `validate.ts`, `service.ts`, `seed.ts`), then `packages/cezar/src/paths.ts` and the `/api/v1/agent-config` routes in `packages/cezar/src/server/server.ts`                                                                      | Read and edit the coding agents' OWN config files (Claude/Codex/OpenCode settings, MCP, memory), raw and per-scope (spec open-mercato/cezar#404). `catalog.ts` is the ONLY place vendor knowledge about config FILES lives — paths + verbatim precedence strings; keep it accurate and dated. Its sibling `src/core/agent-profiles.ts` owns the other half: the env var that relocates each agent's whole home (spec `2026-07-29-agent-profiles`). Never re-serialize a file cezar opened (byte-exact round-trip). Files are addressed by catalog id, never a path. **Writing is a local-machine capability: every `PUT /api/agent-config/:id` 409s when `capabilities().localHandoff` is false — this closes a hooks-based RCE path, do not weaken it.** The gitignored personal layer is seeded into run worktrees (`seed.ts`, guarded by `git check-ignore`).                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Cockpit e2e specs (`packages/web/e2e/*.e2e.ts`, the browser seam, a flaky shard) | `packages/web/e2e/README.md`, then `packages/web/e2e/agent-browser.ts` and `packages/web/e2e/contrast.ts` | Wait, then read, as one step: `click`/`hover`/`fill` auto-wait for their selector, `waitForValue` polls an expression and returns the sample that passed (hearsay-tools/cezarion#409); a one-shot `expect(browser.…)` right after an action is a race. `packages/web/src/test/e2e-wait-discipline.test.ts` scans every spec on `npm test` against a baseline that only shrinks. A red shard leaves a failure bundle (`.ai/qa/failures/`); read it before theorizing, and no flake fix lands without one or a local reproduction. A wait added or changed to fix a flake must carry the [README provenance comment](packages/web/e2e/README.md#the-rules-the-ratchet-enforces): the full failure-bundle leaf path with a durable citation, the reproduction command or env-gated delay, and before/after run counts with both totals. |
| Follow-up or todo features (the retired generated inbox) | `BACKWARD_COMPATIBILITY.md` (the hearsay-tools/cezarion#1543 exception) | The generated follow-up inbox was removed in 0.17.0 without a compatibility window: do not restore `CEZ_FOLLOWUPS`, suggestion prompts, todo routes, watchers, synchronization or launch controls. Keep the handoff journal, Notes, Continue, live conversation follow-ups, worker messaging, ordinary task creation and issue-authoring skills independent of it. Native runner plan/todo wire events are unrelated to the removed inbox. |
| Feature specs / design history                                                                                                                                                                                | `.ai/specs/`                                                                                                                                                                                                                                  | Numbered and dated specs are the design record — code comments cite them (`spec 006`, `open-mercato/cezar#348`). Read the relevant spec before changing a feature it covers; keep new work consistent with it or update the spec.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Upstream drift (what open-mercato/cezar shipped, what we ported, declined, or solved differently) | `.ai/upstream/README.md`, then `.ai/upstream/ledger.yaml`, `.github/scripts/upstream-scan.cjs`, spec `.ai/specs/2026-09-18-upstream-ledger.md` | One entry per upstream commit since the fork point, keyed by sha; `pending` rows come from the weekly `upstream-scan.yml` PR and are decided by editing `status`, `fork` and `reason` in the YAML, then `node .github/scripts/upstream-scan.cjs render` so `LEDGER.md` matches. The unit gate validates every row. Before planning a port, run `node .github/scripts/upstream-scan.cjs targets <sha>` from current `main`: it re-checks the commit's files against the fork as it is now (hearsay-tools/cezarion#1002). **Never add a git remote named `upstream`**: `gh` prefers it over `origin` and cezar's GitHub tab starts showing the upstream repo; the scan fetches into `refs/cez-upstream/main` instead. |

## Validation

A fresh task worktree (`.ai/cezar/worktrees/<runId>`) has no `node_modules`. Run `pnpm install --frozen-lockfile` in that worktree before the commands below, unless the project's `worktreeSetup` already ran it — otherwise Node walks up to the main checkout, `@open-mercato/*` workspace packages resolve there, and typecheck/tests compile against that tree's sources, not this one.

### Iterate

**With Squeal.** If Squeal is installed and validating this worktree, it runs the
tests after each edit: follow its installed skill and its `SQUEAL` reports, and
leave those runs to it rather than starting `npm test`, `npm run test:unit`,
`npm run test:e2e` or `npm run test:changed` yourself. `squeal.config.json`
covers the four unit Vitest projects, both fast `node:test` groups from
`npm run test:unit`, and the cockpit browser suite (`npm run test:e2e`) in its
slow tier. It does not cover packaged CLI E2E (hearsay-tools/cezarion#1281
removed it from the config); see *Packaged CLI E2E runs by hand* below.
Under Codex, use the absolute Squeal command printed in its messages when
`squeal` is not on PATH. Report known failures, pending, stale and unknown
results accurately; zero known failures is not a full pass.

<a id="squeal-wait-bound"></a>

**A wait for one file's verdict has a bound.** Squeal's skill says to wait again
when `squeal status --wait` returns on timeout. In this repo, stop waiting for a
unit test file's verdict when either case holds:

- Squeal reports the file unknown: for example, it timed out at the per-file
  cap (`runner.timeoutMs` in `squeal.config.json`), or it was never queued.
  Waiting again does not change an unknown result, and `squeal retry` runs the
  file again under the same cap.
- The file is still pending after the per-file cap plus five minutes, counted
  from your first wait at the revision you will push.

Then do these three things:

1. Run the tests in that file that the change adds, changes or reads:
   `npm test -- <file> -t '<name>'`. Check that each run reports passed tests,
   not only skipped ones. Run the whole file (`npm test -- <file>`) only when no
   test name covers the change, for example after an edit to a shared testkit.
2. In the PR's Verification, record the file and its Squeal state (unknown and
   its reason, or pending and for how long). Also record the load average
   (`uptime`), the logical CPU count (`nproc`), and each command with its passed
   and skipped counts.
3. Let CI's three Vitest shards give the file's full verdict. A focused pass is
   not a full pass, and the PR does not merge until the shards pass.

A file that gets a verdict must pass: the bound covers a missing verdict, never
a failure. The bound also covers a test file that Squeal re-runs only because
the change edited a document it reads. For example, an edit to
`AGENT_PROTOCOL.md` prose re-runs
`packages/cezar/src/core/harness-parity.test.ts`, and the focused run is
`npm test -- packages/cezar/src/core/harness-parity.test.ts -t "counted roster"`
(hearsay-tools/cezarion#1326).

**Without Squeal.** Squeal is optional. If it is absent, no daemon is validating, or a needed result
is unknown, run affected test files/test names through npm. Inspect
`npm run test:changed -- --plan` before using `npm run test:changed`; if the plan
falls back to a full run, choose focused checks and leave the full gate to CI.
The browser project's globalSetup uses
the existing test environment bootstrap to prepare or reuse the app and Chrome;
a missing browser is an error in a Squeal run. `npm test` and `npm run test:watch` select
only the four unit projects. Typecheck and build remain separate checks;
run them when the change needs them. When Squeal is unavailable, use focused
browser specs for affected UI flows, e.g.
`npm run test:e2e -- smoke.e2e.ts -t 'test name'` (see `packages/web/e2e/README.md`).

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
`.github/scripts/change-surface.cjs` is the exact definition. To classify the
current branch's commits as CI does, run
`git diff --name-only --no-renames origin/main...HEAD | jq -R . | node .github/scripts/change-surface.cjs`;
it prints `docs-only`, `infra-only` or `full-matrix`. Markdown that a Vitest
test or cockpit browser spec reads (`testReadDocuments`) is never docs-only.
`.github/scripts/change-surface-readers.test.cjs` fails
when package code names a docs-only Markdown file by path. No matching tests is
an error: select the relevant test files explicitly and report any coverage gap
rather than treating it as a pass. Import graphs do not cover every runtime
dependency, so this command is only iteration feedback, never a replacement for
CI's final gate.

**Packaged CLI E2E runs by hand.** Packaged tests (`npm run test:package`,
`packages/cezar/test/e2e/*.test.ts`) exercise built output, and Squeal never runs
them, with or without its daemon. Run `npm run build` from the repo root after
relevant source changes; then, from `packages/cezar`, run
`node --import ../../scripts/test-git-env.mjs --import tsx --test <files>` with
paths relative to that directory (e.g. `test/e2e/task-cli.test.ts`). Pass packaged
paths to `node --test`, never to `squeal status`: it gives them no result and no
warning (hearsay-tools/squeal#83). In an unbuilt worktree they fail with a
`Cannot find module` error naming a missing `dist/` module; an assertion failure
is a real failure that needs investigation.

**Browser E2E.** Cockpit browser E2E is a separate command from packaged CLI E2E — it boots the real app and
drives it in a real Chrome through the `agent-browser` provider (`.ai/browsers/agent-browser.md`):

```bash
npm run test:e2e    # .ai/scripts/e2e.sh → test-env-up.sh + vitest (packages/web/e2e/)
npm run test:e2e:local # explicitly requested full local browser run, four lanes (~8 GiB peak)
```

Use `npm run test:e2e` for focused local specs and CI's serial shards. Reserve
`npm run test:e2e:local` for an explicitly requested full local browser run or CI
failure investigation. Both print a `TEST_E2E_STATUS` marker: `skipped` means
agent-browser could not be provisioned and is not a pass, and a filtered run's
`passed` is not a full-suite pass. The server runs under `CEZ_DRY_RUN=1` from a
separate e2e build against an isolated clone, never this checkout or its
production build; stop it with `.ai/scripts/test-env-down.sh`. A red spec leaves a
failure bundle under `.ai/qa/failures/`: read it before theorizing about a flake.
Start at `packages/web/e2e/README.md` to write or fix a spec; it also holds the
exit contract, the served clone, the bundle contents and the four-lane run.

`CEZ_DRY_RUN=1 npm run dev` still exercises the whole cockpit offline for manual verification.
To check a UI change by hand in a real browser, run `node .ai/scripts/qa-fixture.mjs up`
(hearsay-tools/cezarion#1406); `packages/web/e2e/README.md` § Checking a UI change by hand
says what it serves and how it stops.

**Typecheck.** For web-only verification, use `npm run typecheck:web` or
`npm run typecheck -w @open-mercato/cezar-web`. Both rebuild server declarations
from this worktree before checking web sources; direct `tsc --noEmit` does not.
The full root typecheck runs web first, preparing declarations once for all four
workspace checks.

To typecheck without rebuilding `packages/cezar/dist`, for example while Squeal
is validating, run the three server configs from `packages/cezar`. The root
`npm run typecheck` rebuilds `dist` first, and Squeal then marks dozens of
passing checks UNKNOWN (hearsay-tools/squeal#33).

```bash
./node_modules/.bin/tsc --noEmit -p tsconfig.json          # shipped sources only
./node_modules/.bin/tsc --noEmit -p tsconfig.test.json     # adds every test file
./node_modules/.bin/tsc --noEmit -p tsconfig.scripts.json  # .ai/scripts/*.ts probes
```

The `.ai/scripts/*.ts` probes import server internals and CI never runs them,
so `tsconfig.scripts.json` is their only check (hearsay-tools/cezarion#1702).

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

### Before opening a PR

1. Finish the [reader sweep](#reader-sweep) for every shared name, value or default the
   change alters, and require passing results for the specs and fixtures it selects.
2. For a change to `packages/cezar/src/workflows/run.ts`'s wait, turn-end, failure or
   step-settlement paths, verify the parity suites
   ([Runner regressions ship with shared coverage](#runner-regressions-ship-with-shared-coverage)).
3. Run the root `npm run typecheck` once when declarations matter (*Typecheck* above).
4. Run the code-quality check and the auto-merge decision that the Dev flow bindings
   name.

### CI owns the final gate

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

CI's final gate covers:

```bash
npm run typecheck   # refresh server declarations, then check all four workspaces
npm test -- --shard=N/3 --maxWorkers=4  # vitest, N=1..3 — server + cockpit unit suites
npm run test:unit   # node:test — fast core-module coverage (packages/cezar/test/unit/)
npm run build       # tsc → dist/, vite → packages/cezar/web/dist/, then the check:pack tarball gate
npm run test:package # pack/install the release tarball and exercise the built CLI (packages/cezar/test/e2e/)
npm run test:e2e     # cockpit browser E2E in CI shards; skipped is not a pass
```

`npm test` and `npm run test:unit` are the fast unit gate: no server, no browser. They must stay that way. `npm run test:package` needs a completed `npm run build` (it packs the tarball). Pull request CI runs packaged CLI E2E and cockpit browser E2E as separate checks; the required aggregate fails if the cockpit suite is skipped or failed.

Read [`docs/sdlc/ci.md`](docs/sdlc/ci.md) before you:

- investigate, cite or file a CI or load-dependent test failure, or back a PR
  with a full local run that failed only under load (§ Investigating a CI or load
  failure, which includes the one-CPU load reproduction);
- edit `ci.yml` or a workflow it calls (§ Proving a `ci.yml` change);
- add or split a Vitest unit test file that takes longer than about one minute
  on CI (the duration manifest, after the Vitest sequencer paragraph).

## Related documents

Read the matching document before you:

- change a runner, the event streams or a parity matrix: `AGENT_PROTOCOL.md` (§6 mapper
  capabilities, §7 session and lifecycle, the new-runner checklist);
- change a CLI command, flag or exit code, an HTTP route, a state file under `.ai/cezar/`
  or `~/.cezar/`, the workflow or skill format, the npm package surface, the event
  protocol or an in-band marker: `BACKWARD_COMPATIBILITY.md`, the section for that surface;
- apply a label, claim an issue, pass the QA gate or change the process itself: `SDLC.md`;
- review a change or assign a severity: `CODE_REVIEW.md`;
- change what the `om-*` pipeline skills read (base branch, validation commands, labels):
  `.ai/agentic.config.json`;
- investigate CI or change a workflow: [`docs/sdlc/ci.md`](docs/sdlc/ci.md).

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
| Stack | TypeScript (Node ≥24.21.0), pnpm workspaces (npm script metadata retained); Hono + Zod server; React 19 + Vite + Tailwind v4 cockpit |
| Verification | Local: Squeal when installed and validating, otherwise focused npm checks. Full gate in CI: `npm run typecheck`, `npm test -- --shard=N/3 --maxWorkers=4` (N=1..3), `npm run test:unit`, `npm run build`, `npm run test:package`, `npm run test:e2e` |
| Automated reviewer | `AUTOMATED_REVIEWER=codex`. A pushback-only round needs a manual dispatch of `automated-code-review.yml` with `pr_number`, then a re-run of **Review / review-round** in the CI run. Re-running the CI run's failed jobs alone does not re-judge. |
| Automated review rounds | The `AUTOMATED_REVIEW_ROUNDS` repository variable, read with `gh variable get AUTOMATED_REVIEW_ROUNDS`; the review workflow falls back to 3 only when the variable is unset or empty |
| Commit convention | Conventional Commits |
| Specs and plans | `.ai/specs/`, `.ai/specs/` (tracked; new files are `YYYY-MM-DD-<slug>.md`, and plans end in `-plan.md`) |
| Board | **Cezarion**, org `hearsay-tools`, project #1. For same-repository PRs targeting `main`, `.github/workflows/pr-readiness.yml` owns draft state and syncs existing PR and closing-linked issue cards: draft → In progress, ready → In review. Each new head returns the PR to draft; the workflow marks it ready when the head's required checks pass and no review thread is unresolved. Open a draft PR, fix its checks and review threads, and let the workflow move it to ready and In review; do not move the card to In review or run `gh pr ready` by hand. Board sync skips without project access and never moves Done cards back. The initial claim still moves the issue to In progress. |
| Auto-merge | Read `.ai/skills/auto-merge/SKILL.md` before you open a pull request into `main`, and after each push, CI result, review round or draft/ready change on one you opened with the `auto-merge` label. It decides whether the PR merges without owner review; every merge it makes is a squash. |
| Code quality | Read `.ai/skills/check-code-quality/SKILL.md` for file/function/module quality stats and before opening a pull request. Use its measurement path for requested stats and its pre-PR path for changed-function checks, small fixes and inherited-refactor issues. |
| Design track label | An issue labeled `friction-design` takes `/dev-flow`'s Design Track, even when Direct or Micro fits; read labels before the design gate. [docs/sdlc/friction.md § Handling automations](docs/sdlc/friction.md#handling-automations). |
| Task orchestrator | Cezar |
| SDLC feedback | `apptension/toolkit-dev` |
| Friction inbox | Post friction findings, never file them: [docs/sdlc/friction.md § Friction inbox](docs/sdlc/friction.md#friction-inbox) |
