# CLI entry and subcommands

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/index.ts`

## Two project directories before P5

Project entry points use `projectPaths`: `.ai/cezar/` is the write root and the first
read root; `.ai/squawk/` is the fallback. Dual reads work with the release switch
off. `init`, generated task paths, task state and config writes stay legacy; `init`
skips a starter whose workflow or skill name already exists under `.ai/squawk/`.
Singleton config/context files use whole-file presence precedence. Reads never
create a fallback directory or an empty legacy run store that hides its data.
Git excludes cover both runtime trees and `.ai/squawk-migration.json`; tracked
workflows, skills and `context.yaml` keep their existing committable paths.
Only the release switch enables the legacy-directory notice; boot does not migrate.

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
journal that cannot finish ends the command with its cause, exit 1.

## Staged `migrate-project`

`migrate-project [--dry-run] [--repo <dir>]` (`project-migration/cli.ts`) is registered,
listed in help and dispatched only behind `PROJECT_MIGRATION_SWITCH`, false until P5.
`REBRAND_SWITCH` never registers it. With the gate off it is an unknown command, and the
command module is never loaded. With the gate on, a cockpit that owns the project runs
the migration through its route; with no owner the CLI locks the project itself. It
prints the plan, then `Dry run: nothing was moved or rewritten.` or `Migration
complete.`; it prints the `git mv` commands for tracked files and never runs them.
Refusals (live tasks, a held fence, another owner, conflicts) print one message to
stderr and exit 1. hearsay-tools/cezarion#3142, hearsay-tools/cezarion#3146 and
hearsay-tools/cezarion#3136 must close before P5 turns the gate on.

## Rules

Uses `node:util` `parseArgs`, no CLI framework. `serve` is the default command. Headless `run` treats `review` as a terminal success status (exit 0). `serve` boots in a fixed order: bind the listener, open the boot store and build its `RunManager`, `recover()` the boot project, then `startServer`. So anything a recovered run needs (its cockpit address, for one) must reach the boot manager at construction, not from `startServer`. `init` never overwrites existing files. Keep `.ai/cezar/.gitignore` maintenance (`ensureDataGitignore`) in sync with any new state file.

## Task environments and the cockpit home

`CEZ_HOME` and `HSQ_HOME` stay in the cockpit. No child receives either, including with
`CEZ_AGENT_ENV_FULL=1` or `CEZ_ENV_PASSTHROUGH=CEZ_HOME,HSQ_HOME`. Task commands
(`artifact`, `message`, `worker`, `task`, `automation`, `webhook`, `discover`)
do not read the cockpit home. Artifact links use the supplied `CEZ_PROJECT_ID`;
without it they keep the unprefixed task link.

Operator commands (`projects`, nested `run`, `remote-settings`, `backup`,
`install`, `update`, `versions`, `use`, `link`, `unlink`) retain their home access.
Inside a task they now resolve the default home because the cockpit's
`CEZ_HOME` override is absent. Their command behavior is otherwise unchanged.

## Legacy home recovery (staged)

Behind `REBRAND_SWITCH`, the host operator can use `cez backup import <file>` or
`cez backup ignore <file>` for a legacy-change row. Both use the same recovery
writer as the cockpit. Import applies legacy deltas after a required backup;
Ignore keeps the live file. Both record the current legacy hash and next merge
base. Deleted legacy files allow Ignore only. `cez backup --help` lists these
actions only when the switch is enabled; both refuse while it is disabled.

Remote-settings grants remain host-CLI-only, even for a local cockpit. Their
legacy banner rows show these commands. Existing `backup list` and `backup
restore` behavior is unchanged.

Before migration, `hsq migrate --resolve-legacy <file> restore|accept` resolves
an outside-write or reset incident on the legacy home. It uses the pinned restore
or acceptance writer directly, without preparing or migrating the split home.
Help lists both actions. The command is registered only with `REBRAND_SWITCH`
enabled. See `BACKWARD_COMPATIBILITY.md` for output and exit codes.

Product task-context reads accept `HSQ_*` first with permanent `CEZ_*` fallback.
Generated child entries keep the legacy names with the release switch off; with
it on they carry both names and the same value. Empty context values remain
intentional clears. `core/product-env.ts` owns both selection and generation.
