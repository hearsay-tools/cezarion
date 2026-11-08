# CLI entry and subcommands

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/index.ts`

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
