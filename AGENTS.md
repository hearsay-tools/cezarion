# AGENTS.md — working in this repository

Squawk runs parallel coding agents through a local CLI and browser cockpit. Use `hsq`. Each task runs a workflow on one backend from `RUNNER_IDS` (`packages/cezar/src/core/agent-runner.ts`), or a mix per step, in its own git worktree; it ends at a review gate (never auto-merges) and can be pushed as a draft PR through `gh`. Everything is local: no accounts, no database server, no cloud. Project state lives in `.ai/squawk/` (`.ai/cezar/` until moved): one SQLite run store (`runs.db`, `node:sqlite`) plus JSON, NDJSON and Markdown. The stack stays deliberately small: strict TypeScript (ESM, Node 24.21.0+), Hono + SSE, Zod at every boundary, YAML workflows, and a React 19 + Vite + Tailwind v4 + shadcn/ui cockpit compiled to static assets.

Architecture decisions live in [docs/adr/](docs/adr/). Consult the relevant records before changing a mechanism.

This file holds what every task needs. A new agent rule goes in the narrowest document its tasks already read, as [docs/sdlc/friction.md § Where a new agent rule goes](docs/sdlc/friction.md#where-a-new-agent-rule-goes) says; this file gains at most a pointer to it. `.github/scripts/agents-md-budget.test.cjs` holds this file to a byte limit that only goes down.

## Issue and PR citations

This fork is `hearsay-tools/cezarion`; upstream is `open-mercato/cezar`. Both
trackers reuse numbers, so never infer the tracker from the number or the current
remote. Cite issues and PRs as `hearsay-tools/cezarion#N` / `open-mercato/cezar#N`,
`fork #N` / `upstream #N`, or a repository-qualified GitHub link. A bare `#N` in older
code is legacy; CI's `Check issue citations` step fails a change that adds one. Run
`node .github/scripts/check-citations.cjs` before a PR. Archives, upstream commit
titles and ledger fields follow
[the ledger guide](.ai/upstream/README.md#citation-provenance).

## Zero config

Squawk ships no config file the user must create and no setting they must set before it works. Every capability is discovered from what is already there — the repo, the environment, `gh`, the running processes — or it degrades quietly. The project's `config.json` is optional and every key has a working default; `.env` is never auto-loaded.

State may be **written**, never **required**. User state uses the [platform roots](docs/migration.md#home-directories). Squawk rebuilds deleted state. User-authored, migrated or repaired state is configuration and needs a reason. The registry retains `config.json.bak`, so deleting only `config.json` restores it. See [migration and rollback](docs/migration.md) before resetting a home.

Practical rules:

- When a feature seems to need configuration, the design is wrong. Discover it, or default it.
- Features that widen exposure or cost use opt-in `HSQ_*` flags (`CEZ_*` fallback). [Automations](docs/areas/automations.md)
  and [workers](docs/adr/0058-task-workers.md) are opt-out.
- A missing dependency, an absent peer, a read-only home: degrade to a smaller working cockpit, never fail the boot.
- Prefer a proxy-free, daemon-free mechanism when one exists — and when it doesn't, keep the mechanism invisible: no process to manage, no port to remember, no file to edit.
- Never trade a working default for a knob.
- Adding, renaming, or removing an `HSQ_*`/`CEZ_*` env var — or changing what its default does — MUST update `.env.example` in the same commit (and the README env table when the var is user-facing). `npm run lint` checks source reads against `.env.example`, the env contract.

## Changing what already works

Follow [CODE_REVIEW.md § Changing working behavior](CODE_REVIEW.md#changing-working-behavior)
when replacing working behavior or changing a shared name, value or default.
Use the case tables in [the spec template](.ai/specs/TEMPLATE.md#case-tables).

## Repository layout

Four pnpm workspaces under a `private` root. Read
[`docs/areas/packages.md`](docs/areas/packages.md) before you add a dependency, move code
between packages or import across them.

| Path | Package | What it is |
| --- | --- | --- |
| `packages/cezar` | `@wjarka/cezarion` | Service/CLI workspace; publishes as `@hearsay-tools/squawk` with the cockpit in `web/dist` |
| `packages/contract` | `@open-mercato/cezar-contract` | Every HTTP request and response as a zod schema; Node-free |
| `packages/api-client` | `@open-mercato/cezar-api-client` | The typed client over `AppType`; Node-free; the service imports it only in tests |
| `packages/web` | `@open-mercato/cezar-web` | The cockpit SPA, built into `packages/cezar/web/dist` |

## Shared helpers

- **Shell quoting.** To build a POSIX shell word, use `shellQuote` from
  `packages/cezar/src/core/shell-env.ts`; `JSON.stringify` is not shell quoting, because `$()`
  and backticks still expand inside double quotes. Scripts in `.ai/scripts/` and root `scripts/`
  can import it from `packages/cezar/dist/core/shell-env.js` after a build, or keep a local copy
  with a test that runs its output through `sh` and checks that spaces, apostrophes, dollar
  signs, `$()` and backticks stay literal.

## Task routing

Before you change or review code in an area, read its *Read first* files. Each area doc
holds that area's rules.

| When the task involves… | Read first |
| --- | --- |
| CLI entry, `serve`/`run`/`init` subcommands, flags | [`docs/areas/cli.md`](docs/areas/cli.md) |
| Agent runners / backends, parity matrices | [`docs/areas/runners.md`](docs/areas/runners.md), then `AGENT_PROTOCOL.md` |
| HTTP server, API routes, request/response shapes (any new field, route or payload) | [`docs/areas/http-api.md`](docs/areas/http-api.md) |
| Real-time events (live UI signals, replacing polls) | [`docs/areas/realtime-events.md`](docs/areas/realtime-events.md) |
| Workspace registry / per-user state | [`docs/areas/workspace-registry.md`](docs/areas/workspace-registry.md) |
| Project-scoped routes & contexts (`/api/v1/p/:projectId`, `/p/:projectId`) | [`docs/areas/project-routes.md`](docs/areas/project-routes.md) |
| Git / worktree logic | [`docs/areas/git-worktree.md`](docs/areas/git-worktree.md) |
| GitHub integration (issues/PRs tab, draft PRs) | [`docs/areas/github.md`](docs/areas/github.md) |
| Automations (GitHub polls and schedules) | [`docs/areas/automations.md`](docs/areas/automations.md) |
| Workflows (YAML chains, steps, retries) | [`docs/areas/workflows.md`](docs/areas/workflows.md) |
| Run search (project tasks, All tasks, archived pages and ⌘K) | [`docs/areas/run-search.md`](docs/areas/run-search.md) |
| Pending asks (`cezar_ask`, the ask card, a new field on the ask) | [`docs/areas/pending-asks.md`](docs/areas/pending-asks.md) |
| Skills (Markdown playbooks, team repos) | [`docs/areas/skills.md`](docs/areas/skills.md) |
| Runs store / state persistence | [`docs/areas/runs-store.md`](docs/areas/runs-store.md) |
| Task handoff journal (`HSQ_HANDOFF_FILE`, `CEZ_HANDOFF_FILE` fallback) | [`docs/areas/handoff-journal.md`](docs/areas/handoff-journal.md) |
| Web UI (cockpit) | [`docs/areas/web-ui.md`](docs/areas/web-ui.md) |
| Agent config files (Settings → Agent config) | [`docs/areas/agent-config.md`](docs/areas/agent-config.md) |
| Cockpit e2e specs, the browser seam, a flaky shard | [`packages/web/e2e/README.md`](packages/web/e2e/README.md) |
| Feature specs / design history | `.ai/specs/` says why a design was chosen. Code, tests and ADRs win; a plan binds until its work ends |
| Upstream drift: what open-mercato/cezar shipped, ported, declined | [`.ai/upstream/README.md`](.ai/upstream/README.md); fetch upstream into `refs/cez-upstream/main`, as its scan does |

## Validation

In a fresh task worktree (`.ai/cezar/worktrees/<runId>`), run `pnpm install --frozen-lockfile`
unless `worktreeSetup` already did.

- When Squeal validates this worktree, it runs the unit tests after each edit: read its
  verdicts and let it run them. Follow the [wait bound](docs/sdlc/ci.md#squeal-wait-bound).
- Run Vitest through `npm test -- <args>`, the repo's pinned binary.
- CI owns the final gate and full-suite runs. Locally, run what the change affects.
- In a unit test, wait on the product's own signal. A timeout is only a hang guard, with a
  `// bound: <reason>` comment at the call site. A test that proves something did not happen
  uses fake timers or states at the call site why it needs real time.
- `npm run typecheck`: no build or `dist` writes; after a build: `npm run typecheck:package`.
- CLI E2E: `npm run test:package -- <repo-root paths>`; parity: `npm run test:parity`.
- Browser: `npm run test:e2e:affected`, `npm run test:e2e` / `npm run test:e2e:local`;
  see [e2e guide](packages/web/e2e/README.md).
- Selection: `npm run test:changed -- --help`.

### Before opening a PR

1. Finish the reader sweep for every shared name, value or default the change alters.
2. For a change to wait, turn-end, failure or step-settlement paths in
   `packages/cezar/src/workflows/run.ts` or `workflows/run/`, run `npm run test:parity`.
3. Before the first push of a `packages/**` source or test change, require `npm run lint`
   to pass. If a pinned source shrinks, first run `FILE_LENGTH_UPDATE=1 npm run lint`.
4. Run the root `npm run typecheck` once when declarations matter.
5. Run the code-quality check and the auto-merge decision that the Dev flow bindings
   name.

## Related documents

Read the matching document before you:

- change a runner, the event streams or a parity matrix: `AGENT_PROTOCOL.md` (§6 mapper
  capabilities, §7 session and lifecycle, the new-runner checklist);
- change a CLI command, flag or exit code, an HTTP route, a state file under `.ai/cezar/`
  or the user home, the workflow or skill format, the npm package surface, the event
  protocol or an in-band marker: `BACKWARD_COMPATIBILITY.md`;
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
| Verification | Local: Squeal when installed and validating, otherwise focused npm checks. Full gate in CI: `npm run typecheck`, `npm test -- --shard=N/4 --maxWorkers=4` (N=1..4), `npm run test:unit`, `npm run build`, `npm run test:package`, `npm run test:e2e` |
| Automated reviewer | CodeRabbit App (`347564`, `coderabbitai`), automatic draft/incremental reviews via `.coderabbit.yaml`. The native `Automated Code Review` job requires fresh admission and resolved threads; see `docs/sdlc/ci.md`. |
| Review recovery | Missing check: request `@coderabbitai full review`, then let reconciliation retry. Dispatch `Reconcile CodeRabbit admission` with `pr_number` after thread changes or missed events. Other recovery: `docs/sdlc/ci.md`. |
| Commit convention | Conventional Commits |
| Specs and plans | `.ai/specs/` (tracked; new files are `YYYY-MM-DD-<slug>.md`, and plans end in `-plan.md`) |
| Board | **Cezarion**, org `hearsay-tools`, project #1. Open PRs ready: no `--draft`. For same-repository PRs targeting `main`, `.github/workflows/pr-readiness.yml` syncs existing PR and closing-linked issue cards and never changes draft state: a ready PR whose head has passing required checks, fresh review admission and no unresolved review thread → In review; anything else, a human's draft too → In progress. Fix checks and threads; do not move the card to In review by hand. Board sync skips without project access and never moves Done cards back. The initial claim still moves the issue to In progress. |
| Auto-merge | Read `.ai/skills/auto-merge/SKILL.md` before you open a pull request into `main`, and after each push, CI result, review round or draft/ready change on one you opened with the `auto-merge` label. It decides whether the PR merges without owner review; every merge it makes is a squash. |
| Code quality | Read `.ai/skills/check-code-quality/SKILL.md` for file/function/module quality stats and before opening a pull request. Use its measurement path for requested stats and its Squeal one-shot pre-PR path, without a bundled fallback, for changed-function checks and findings. |
| Design track label | An issue labeled `friction-design` takes `/dev-flow`'s Design Track, even when Direct or Micro fits; read labels before the design gate. [docs/sdlc/friction.md § Handling automations](docs/sdlc/friction.md#handling-automations). |
| Task orchestrator | Squawk |
| SDLC feedback | `apptension/toolkit-dev` |
| Friction inbox | Post friction findings, never file them: [docs/sdlc/friction.md § Friction inbox](docs/sdlc/friction.md#friction-inbox) |
