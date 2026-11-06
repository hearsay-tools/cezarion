# CLI entry and subcommands

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/index.ts`

## Rules

Uses `node:util` `parseArgs`, no CLI framework. `serve` is the default command. Headless `run` treats `review` as a terminal success status (exit 0). `serve` boots in a fixed order: bind the listener, open the boot store and build its `RunManager`, `recover()` the boot project, then `startServer`. So anything a recovered run needs (its cockpit address, for one) must reach the boot manager at construction, not from `startServer`. `init` never overwrites existing files. Keep `.ai/cezar/.gitignore` maintenance (`ensureDataGitignore`) in sync with any new state file.

## Task environments and the cockpit home

`CEZ_HOME` stays in the cockpit. No child receives it, including with
`CEZ_AGENT_ENV_FULL=1` or `CEZ_ENV_PASSTHROUGH=CEZ_HOME`. Task commands
(`artifact`, `message`, `worker`, `task`, `automation`, `webhook`, `discover`)
do not read the cockpit home. Artifact links use the supplied `CEZ_PROJECT_ID`;
without it they keep the unprefixed task link.

Operator commands (`projects`, nested `run`, `remote-settings`, `backup`,
`install`, `update`, `versions`, `use`, `link`, `unlink`) retain their home access.
Inside a task they now resolve the default home because the cockpit's
`CEZ_HOME` override is absent. Their command behavior is otherwise unchanged.
