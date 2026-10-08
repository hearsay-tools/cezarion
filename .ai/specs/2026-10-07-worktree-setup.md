# Worktree setup (hearsay-tools/cezarion#917)

> Design record for hearsay-tools/cezarion#917. Approved 2026-10-07.

A project declares, in `.ai/cezar/config.json`, the commands that prepare a
freshly created task or worker worktree. Cezar runs them after it creates the
worktree and before the agent's first turn, shows them in the task thread, and
tells the agent how they went.

## Problem

Every task and worker starts in a fresh `git worktree add` checkout with no
installed dependencies. The agent finds out after its first test or build
fails, then runs `npm ci` (or the project's equivalent) itself. Tools that run
beside the agent pay too: in task `5062d7f6` (hearsay-tools/cezarion#890) Squeal
validated the whole suite for 40 minutes against a worktree without
`node_modules`, then again after the agent's install, and the worker's own
tests waited 23 minutes behind it (hearsay-tools/cezarion#914).

What a ready worktree needs differs per project (a package install, generated
code, copied env files, nothing), so it is a project setting.

## Decisions

| Question | Decision |
| --- | --- |
| What can be configured | An ordered list of shell commands and a per-command timeout. No package-manager presets, no lockfile detection |
| Default | Off. A project without the key behaves exactly as before: setup spends network and processes, so it is opt-in (AGENTS.md § Zero config) |
| When it runs | Blocking, before the first workflow step. Tasks and workers alike |
| Failure | The agent starts anyway and is told what failed |
| Reuse of installs | Out of scope. npm, pnpm and uv caches already do the heavy lifting |
| Where it is edited | `config.json`, and Settings → Worktrees on a local cockpit |

## Config

```jsonc
// .ai/cezar/config.json
"worktreeSetup": {
  "commands": ["npm ci", "cp \"$CEZ_PROJECT_ROOT/.env\" .env"],
  "timeoutSeconds": 900
}
```

- `commands`: 0 to 20 strings, each trimmed, non-empty, at most 4,000
  characters. Each runs as `bash -lc <command>` in the worktree root, in order,
  stopping at the first non-zero exit or timeout. `[]` means no setup.
- `timeoutSeconds`: optional integer, 1 to 7,200, per command. Default 900.
- The config is read from the project root (the main checkout) when the setup
  runs, never from the task's branch, so a task cannot change the commands
  that prepare its own worktree.

`configSchema` carries the key as `z.unknown().optional()`. The strict schema
lives in `src/worktree-setup.ts`, whose resolver answers one of:

- `none`: key absent, or `commands` empty.
- `invalid`, with a reason: the value does not parse. The rest of `config.json`
  is unaffected (a strict field in `configSchema` would reset the whole file to
  defaults), and the run reports the setup as skipped rather than silently
  ignoring a setting the user wrote.
- `commands`, with the parsed commands and the timeout in milliseconds.

## When setup runs

| Situation | Setup |
| --- | --- |
| New task in an isolated worktree | Runs in `RunManager.execute`, after the worktree is ready, the personal agent config is seeded and the handoff file is seeded, before the first workflow step |
| Owned worker | Same place, same commands |
| Continue after retention reclaimed the worktree | Runs in `runContinuation` when `rematerializeReclaimedWorktree` rebuilt the directory, before the session opens |
| A run whose setup was interrupted (`worktreeSetup.status === 'running'`) | Runs again, from `execute` or `runContinuation`, whichever picks the run up |
| Continue, resume or requeue on a worktree whose setup finished | Does not run |
| A run recorded before this feature (no `worktreeSetup`) whose agent step already started | Does not run |
| `worktree: false` (in place) or a non-Git project | Does not run: that is the user's own checkout |
| Opening a draft PR rebuilds a reclaimed worktree | Does not run: the route only pushes |

In `execute`, "not yet run" means the record has no `worktreeSetup` and no
agent step of the workflow has an iteration.

## How it runs

- **Blocking.** The run is `running` and holds its `maxParallel` slot while
  setup works.
- **Process group.** Commands run through the process-group runner extracted
  from `runCheckStep`, shared with check steps: Stop sends SIGTERM to the
  group, SIGKILL after the grace period, and the run settles as cancelled. A
  timeout does the same and records the command as timed out.
- **Output.** Setup keeps the last 20,000 characters of a command's output
  (install errors come last). Check steps keep their head-first capture.
- **Environment.** `buildCommandEnv` (the curated env the live preview gives
  model-written dev servers: base allowlist, plain `CEZ_*`,
  `CEZ_ENV_PASSTHROUGH`, `CEZ_AGENT_ENV_FULL`; no backend auth, no `gh`
  token), plus:
  - the run's own `TMPDIR`/`TEMP`/`TMP` (#785);
  - `CEZ_TASK_ID`;
  - `CEZ_PROJECT_ROOT`, the project root, so a command can copy untracked
    files such as `.env` from the main checkout.

  Private-registry tokens reach setup through `CEZ_ENV_PASSTHROUGH` or the
  tool's own config file under `HOME`.
- **Autosave.** Autosave is armed before setup and commits with `git add -A`.
  A file setup creates that Git does not ignore becomes part of the task's
  changes. The docs say to keep generated files gitignored, as `node_modules`
  and `.venv` already are.

## Run record and recovery

`RunRecord.worktreeSetup` (optional, additive):

```ts
{
  status: 'running' | 'done' | 'failed',
  startedAt: string,
  finishedAt?: string,
  durationMs?: number,
  /** One line: "`npm ci` exited 1", "`npm ci` timed out after 900s", "invalid config: …". */
  error?: string,
}
```

Written `running` before the first command and settled after the last. It is
what recovery reads. Without it, a Cezar restart during setup leaves a `running`
run with no agent session, which `recover()` marks failed and then cannot
Continue ("no agent session to resume"). That window used to last
milliseconds; with an install in it, it lasts minutes.

Recovery, for a `running` run whose `worktreeSetup.status` is `running`:

- No agent session yet (setup ran from `execute`): requeue the run at its first
  workflow step, as an interrupted check step is requeued. The next `execute`
  sees `running` and runs setup again.
- A session exists (setup ran from `runContinuation` after a rematerialize):
  the ordinary interrupted-run Continue, whose `runContinuation` sees `running`
  and runs setup again before the session reopens.

A Stop during setup settles the record `failed` with "stopped" and the run
`cancelled`, as before. When an interrupted setup is picked up and the config
no longer has commands, the stale `running` record is cleared and nothing runs.

## What the thread shows

Existing v1 events, no new event type, no step-rail change:

- `note` at start: "preparing the worktree — N commands from worktreeSetup in
  .ai/cezar/config.json".
- One `check-output` event per command. The thread already renders it as a
  "Ran `<command>`" card with an exit-code pill and the output. A timeout has
  exit code `-1` and ends with "(timed out after 900s)".
- `note` at the end: "worktree setup done in 41s", "worktree setup failed —
  `npm ci` exited 1 after 12s; starting the agent anyway", the timed-out
  equivalent, or "worktree setup skipped — worktreeSetup in
  .ai/cezar/config.json is invalid (<reason>)".
- The same outcome line is appended to the handoff file through
  `appendHandoffHeartbeat`.

## What the agent is told

One paragraph appended to the opening message of the first agent step (where
attachment paths go, so workers get it too), or to the continuation's opening
message when `runContinuation` ran setup:

- Done: "Cezar prepared this worktree before your session started: `npm ci`,
  `cp …` (41s). Dependencies are installed; do not repeat this setup."
  Commands are shortened to 120 characters each.
- Failed, timed out or invalid: the command, its exit code or timeout, that the
  later commands did not run, and the last 4,000 characters of its output in a
  fenced block, then: "Dependencies or generated files may be missing. Fix
  the cause or run the setup yourself before tests or builds."

## Settings → Worktrees

A "Prepare new worktrees" field below retention: a monospace textarea (one
command per line), a timeout input in seconds, and "Save setup". Hint: "Runs in
every new task and worker worktree before the agent starts, in order, stopping
at the first failure. Empty = none."

- `GET /config` gains `worktreeSetup: { commands, timeoutSeconds } | null` and
  `worktreeSetupIssue: string | null` (the invalid reason). An issue renders in
  the danger tone with "saving replaces it".
- `PUT /config` accepts `worktreeSetup: { commands, timeoutSeconds? } | null`.
  `null` or an empty list deletes the key. `timeoutSeconds` is written only
  when the request carries it, and the field omits it at the default, so
  defaults never materialize into the file.
- Hosted mode (`capabilities.localHandoff === false`): the server answers 409
  `{ error: 'Worktree setup commands can be edited only on the machine running cezar.' }`
  to any `PUT /config` carrying `worktreeSetup`, the way Agent config writes are
  refused (setup commands are host command execution). The field renders
  read-only with that sentence. The other `PUT /config` keys are unaffected.
- Every shape is a zod schema in `packages/contract`.

## Compatibility

All additive: the `config.json` key, the optional `RunRecord.worktreeSetup`,
and the optional `GET/PUT /config` fields. `BACKWARD_COMPATIBILITY.md` records
each. `CEZ_PROJECT_ROOT` joins the "set by cezar for child processes" list in
`.env.example`.

Without the key nothing changes: no note, no event, no record field, and the
opening prompt is byte-identical. Check steps keep their behaviour while
sharing the runner; `check-stop-kill.test.ts` stays green unchanged.

## Testing

- `src/worktree-setup.test.ts`: the resolver (none, invalid with reason,
  bounds, default timeout); the runner (order, stop at first failure, timeout
  kills the group, tail capture); the env (no `GITHUB_TOKEN` or
  `ANTHROPIC_API_KEY`; `CEZ_PROJECT_ROOT`, `CEZ_TASK_ID` and the run `TMPDIR`
  present); the agent note text.
- `config.test.ts`: an invalid `worktreeSetup` keeps every other key.
- RunManager with the dry-run mock: setup runs before the first agent step and
  the opening prompt carries the done note; a failed setup still starts the
  agent with the failure note; a worker runs setup; Stop during setup cancels
  and kills the group; a restart during setup requeues and reruns it (proved
  red without the fix); Continue after a reclaim runs setup, Continue on a
  live worktree does not; no key, no change.
- One `RUNNER_IDS` cell through `HARNESS_ADAPTERS`: the setup note reaches each
  runner's native mock wire in the opening message.
- Server: `GET/PUT /config` contract parity for the new fields; hosted 409.
- Cockpit unit: the field renders, saves (no default timeout sent), is
  read-only when hosted, and shows the invalid-config issue.
- One focused browser spec: save setup commands in Settings, start a dry-run
  task, see the "Ran …" card and the done note in the thread.

## Docs

- README "Configuration (optional)": the `worktreeSetup` key, and a "Preparing
  new worktrees" subsection with npm, pnpm, Python (uv) and Go/Rust examples,
  the `.env` copy from `$CEZ_PROJECT_ROOT`, the curated env and
  `CEZ_ENV_PASSTHROUGH`, failure and timeout behaviour, and the gitignore note.
- `.env.example`: `CEZ_PROJECT_ROOT`.
- AGENTS.md: the Git/worktree routing row names `src/worktree-setup.ts`.

## Out of scope

Reusing installs across worktrees (copy, hardlink, shared store), lockfile
detection, setup running in parallel with the agent, Squeal changes, and
keeping the main checkout's install current with `origin/main`.
