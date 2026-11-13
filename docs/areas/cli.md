# CLI entry and subcommands

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/index.ts`

## Two project directories

Project entry points use `projectPaths`: the write root is the first read root, the
other directory is the fallback. The write root is `.ai/cezar/`, or `.ai/squawk/` for a
fresh or moved project (a completed migration's marker in the Git common directory,
hearsay-tools/cezarion#3150). `init`,
generated task paths, task state and config writes go to the write root; `init` skips a
starter whose workflow or skill name already exists in the fallback.
Singleton config/context files use whole-file presence precedence. Reads never
create a fallback directory or an empty legacy run store that hides its data.
Git excludes cover both runtime trees and `.ai/squawk-migration.json`; tracked
workflows, skills and `context.yaml` keep their existing committable paths.
A project that still writes `.ai/cezar/` gets one legacy-directory notice. A blocked automatic move prints
one detailed notice; later readers omit the generic notice for that cause. Fresh means no
`.ai/cezar` path, including no empty directory. Such a project starts in `.ai/squawk/`
and preparation or its first CLI write records the same Git marker as a completed move.
`init` help names `.ai/squawk/`.

## Project migration fence

Every CLI operation that touches project data checks the migration fence
([project routes](project-routes.md#project-migration-fence)) and exits 1 with a
one-line `ProjectMigrationFencedError` message. `serve` checks in its ownership claim
before the listener and before any directory is created. `run`, `init` and a
single-project `projects` listing check in `cli-dispatch.ts` (`admitProjectCommand`);
Every CLI write that follows an await re-checks admission right before it runs
(`admittedWrite`): `init` before its directories, each starter file and `.gitignore`; the
headless store open before `.gitignore` and the open (later store writes pass the store's
backstop, and the run's claims keep another process's fence from passing its preflight);
the artifact writer before each mkdir, write, rename and removal.
`artifact publish` checks the data directory of `CEZ_ARTIFACTS_DIR`; `versions` skips
the run lookup of a fenced project. `task`, `automation`, `webhook`, `worker`,
`message`, `discover` and `remote-settings` reach the project only through the
cockpit, whose project routes refuse. `backup`, the managed install commands and
`server-*` touch no project data. Git excludes also cover `.ai/squawk-migration.lock*`.

Before that check, `serve`, `run`, `init`, the single-project `projects` listing,
`artifact publish` and `versions` finish an unfinished migration journal
([early recovery](project-routes.md#project-migration-command-and-early-recovery)); a
journal that cannot finish ends the command with its cause, exit 1. No CLI write targets a
path the migration moved: `artifact publish` refuses (exit 1, nothing written, never
recreating the old directory) when its `CEZ_ARTIFACTS_DIR` or its task's handoff file moved to
`.ai/squawk/` (`movedProjectPath`); the task gets its new paths when it continues.

## `migrate-project`

`migrate-project [--dry-run] [--repo <dir>]` (`project-migration/cli.ts`) is registered,
listed in help and dispatched. Only the user runs it, and it runs
offline: it refuses while a cockpit serves the project (the `cockpit.lock` owner, or a live
cockpit of the user's legacy or split home whose registry lists the project) or any task of it is live, and
names each pid, URL, port or task to stop. It cannot see a cockpit of another home that
lists the project but never opened it: stop such a cockpit yourself first (while the
fence holds, the write backstop refuses its store and listed state writes). It then takes `cockpit.lock` and the migration
fence, moves the state and releases both. A dry run first completes and reports an
unfinished migration, if one exists. It then holds `cockpit.lock`, passes admission and
plans; planning the remaining migration changes nothing. It prints the plan, then `Dry run:
nothing was moved or rewritten.` (or, after such a recovery, `Dry run: planning changed
nothing; the completed migration above did.`) or `Migration complete.`; it prints the `git mv` commands for
tracked files and never runs them. A dry run with plan blockers or conflicts keeps
that output on stdout and exits 1, including when the plan has no moves. Other refusals (in use, a held fence, conflicts, an untrusted
journal) print one message to stderr and exit 1. A cockpit moves each
registered project by itself at start, and a project added later when it is added, when
nothing else is live and its plan has no blocker or conflict; otherwise the project stays
in place and its single notice names the blocker or conflict, even with no planned moves
([automatic move](project-routes.md#project-migration-command-and-early-recovery)); CLI
entries (`run`, `init`, `artifact`, ...) only recover journals and never start a move.

## Rules

Uses `node:util` `parseArgs`, no CLI framework. `serve` is the default command. Headless `run` treats `review` as a terminal success status (exit 0). `serve` boots in a fixed order: bind the listener, open the boot store and build its `RunManager`, `recover()` the boot project, then `startServer`. So anything a recovered run needs (its cockpit address, for one) must reach the boot manager at construction, not from `startServer`. `init` never overwrites existing files. Keep `.ai/cezar/.gitignore` maintenance (`ensureDataGitignore`) in sync with any new state file.

## Task environments and the cockpit home

`CEZ_HOME` and `HSQ_HOME` stay in the cockpit. No child receives either, including with
`HSQ_AGENT_ENV_FULL=1` (`CEZ_AGENT_ENV_FULL` fallback) or `HSQ_ENV_PASSTHROUGH=CEZ_HOME,HSQ_HOME` (`CEZ_ENV_PASSTHROUGH` fallback). Task commands
(`artifact`, `job`, `message`, `worker`, `task`, `automation`, `webhook`, `discover`)
do not read the cockpit home. Artifact links use the supplied `HSQ_PROJECT_ID` (`CEZ_PROJECT_ID` fallback);
without it they keep the unprefixed task link.

Operator commands (`projects`, nested `run`, `remote-settings`, `backup`,
`install`, `update`, `versions`, `use`, `link`, `unlink`) retain their home access.
Inside a task they now resolve the default home because the cockpit's
`HSQ_HOME` (`CEZ_HOME` fallback) override is absent. Their command behavior is otherwise unchanged.

## Long commands (`hsq job`)

`hsq job start <name> -- <command>` runs a command under a supervisor that leads its own session,
so it outlives the shell call, the turn and the agent session on every runner
(hearsay-tools/cezarion#3097). `jobs/job.ts` owns the supervisor, its claim of the name and the
`<name>.<run>.log`, `<name>.<run>.exit` and `<name>.job.db` files; they live in `$TMPDIR` unless
`--dir` names another directory, and `$TMPDIR` goes when the task ends. The launch prompt's
"Long commands" part (`jobs/command.ts`) gives agents the full command; the `cezar_wait`
description names it only as `hsq job start`, because the tool list also loads inside omp. A result is one JSON object on stdout and an error is one on stderr; `--help` prints text. The rules are in
[the unified waits spec](../../.ai/specs/2026-10-17-unified-waits.md#the-job-command-2026-11-10).

## Legacy home recovery

The host operator can use `hsq backup import <file>` or
`hsq backup ignore <file>` for a legacy-change row. Both use the same recovery
writer as the cockpit. Import applies legacy deltas after a required backup;
Ignore keeps the live file. Both record the current legacy hash and next merge
base. Deleted legacy files allow Ignore only. `hsq backup --help` lists these
actions.

Remote-settings grants remain host-CLI-only, even for a local cockpit. Their
legacy banner rows show these commands. Existing `backup list` and `backup
restore` behavior is unchanged.

Before migration, `hsq migrate --resolve-legacy <file> restore|accept` resolves
an outside-write or reset incident on the legacy home. It uses the pinned restore
or acceptance writer directly, without preparing or migrating the split home.
Help lists both actions. See `BACKWARD_COMPATIBILITY.md` for output and exit codes.

Product task-context reads accept `HSQ_*` first with `CEZ_*` fallback during
the deprecation window. The `CEZ_HOME` fallback is permanent.
Generated child entries carry both names and the same value. Empty context values remain
intentional clears. `core/product-env.ts` owns both selection and generation.

Fresh project writes also require an absent or real `.ai/squawk` directory. A
symlink or file keeps legacy writes and is never marked fresh. The destination
check is shared with migration planning. If a cockpit is known but its live tasks
cannot be read, migration still refuses and lists both the cockpit and the read
failure. It does not treat the failed read as an empty task list.

## CLI metadata

Every binary name accepts `--version` and `-v`. Both print the package version to
stdout and exit 0 without resolving or preparing a home. Old names still print
their notice only to stderr. Top-level help shows the resolved home's versions
directory; reading this path does not prepare or migrate the home. If resolution
fails, help describes the data folder without a path and still exits successfully.
Discovery's missing-cockpit hint uses the preferred command.

## Dependency wait bounds

`cezar_wait`, `hsq worker wait` and `hsq message wait` accept worker, request
and peer deadlines of 1–7,200 seconds, default 600. Ordinary `hsq message request`
deadlines use the same range; a settled worker resume request can reach 86,400
seconds. Timeout refusals name the accepted range. A wait does not extend a
request deadline or cancel its dependency when it expires.

An empty dependency deadline (worker, request, peer or process) wakes the task
without spending automatic-wake budget. Peer messages and substantive peer and
process outcomes retain their charging rules. Explicit timer and native-subagent
safety deadlines remain charged. See [ADR 0061](../adr/0061-one-wait-engine-executes-wait-kind-rows.md#longer-dependency-waits-and-empty-deadline-wakes)
for mixed batches, spent budgets and restart behavior.
