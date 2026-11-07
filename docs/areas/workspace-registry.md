# Workspace registry and per-user state (`~/.cezar/`)

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/paths.ts`, then `packages/cezar/src/workspace/config.ts`, `packages/cezar/src/workspace/projects.ts`, `packages/cezar/src/workspace/migrations.ts`, `packages/cezar/src/workspace/semaphore.ts`

## Rules

`~/.cezar/config.json` is the per-user workspace config **and** the project registry — every repo cezar has been booted in (spec `2026-07-20-multi-project-workspace`). Entry points resolve a `Home` once and pass it through the migrated path mechanisms ([ADR 0059](../adr/0059-resolve-home-at-entry-points.md)). `home/resolve.ts` owns cockpit path formulas, including the legacy cache that ignores `CEZ_HOME`. Runtime config, accounts, model policy, launch, delegation, webhooks and project contexts also receive that object. Library APIs require an explicit Home or a path derived from it. The compatibility shim and ambient library defaults are removed in P1a-2 (hearsay-tools/cezarion#2810). `CEZ_HOME` keeps registry and install writes in tests and containers off a real home. Schema rules are load-bearing: every field optional with `.catch`, `.passthrough()` at every object level, per-entry salvage for `projects` (one bad row never evicts the registry), and writes only through `mergeWriteWorkspaceConfig` (read-modify-write + atomic tmp/rename, `0600`) so two processes converge. A corrupt or read-only home degrades to in-memory defaults with ONE warning — never a boot failure. Migrations are config-files-only, idempotent, additive and non-blocking; run state never migrates. `maxParallel`/`memoryLimitMb` are workspace-wide (`resources`): the per-repo keys are imported once by migration 001 and ignored by enforcement afterwards. Registration is suppressed for task worktrees and `$HOME` itself (`shouldRegisterProject`). A merge-write resolves its path ONCE and uses it for both halves — resolving it twice let a `CEZ_HOME` that changed mid-flight read one home and write another, wiping the user's registry. Two guards back that up: `assertCezarHomeWriteIsSandboxed` refuses any write into the real `~/.cezar` from Vitest, node:test, Jest or Stryker, using the OS account home even when HOME is pinned, and `packages/cezar/vitest.setup.ts` and the node:test preload `scripts/test-home-env.mjs` pin `CEZ_HOME` to a per-worker sandbox so no case ever runs unpinned. Every write that leaves projects behind also snapshots `config.json.bak`, which `loadWorkspaceConfig` restores from when the config is missing, empty or corrupt (a config that parses and is simply empty is the user's own state and is never overridden).

**Agent accounts** (spec `2026-07-29-agent-profiles`) live in this directory too, but in their OWN file — `~/.cezar/agent-accounts.json`, never a key in `config.json`, so a cezar that has never heard of accounts cannot drop them; `src/workspace/agent-accounts.ts` owns the store, `src/core/agent-profiles.ts` the vendor knowledge and `src/workspace/agent-profiles.ts` the resolution.

Changed writes to `config.json` and `agent-accounts.json` first copy the previous content to `backups/<file>/<UTC>-<sha8>.json` under the same home. Private snapshots keep the last 20 plus one per day for 30 days. Backup failures warn once per file and do not block writes. `cez backup list [<file>]` lists them; `cez backup restore <file> [--at <time>]` restores the newest snapshot at or before that UTC time through the normal writer, which backs up the replaced file. Restore covers JSON only, not account config directories. The separate `config.json.bak` recovery behavior remains unchanged.

### Explicit home paths

Library readers and writers require the caller's `Home` or a path derived from it.
CLI dispatch resolves it once at the operator entry point; task subcommands do not
resolve or receive one. OS-user paths, such as a user-authored tilde skill source,
keep their separate meaning. `cez/home-boundary` enforces this boundary and checks
the shrink-only OS-user reader list (hearsay-tools/cezarion#2810).

Tests select `Home.sandbox(dir)` and use the shared setup's selector for process
entry tests. The factory contains cache and config paths under that directory and
creates a test `install.json` marker without replacing an existing one. Marker
validation and HomeStore remain deferred to P1b.
