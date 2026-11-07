# Workspace registry and per-user state (`~/.cezar/`)

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/paths.ts`, then `packages/cezar/src/workspace/config.ts`, `packages/cezar/src/workspace/projects.ts`, `packages/cezar/src/workspace/migrations.ts`, `packages/cezar/src/workspace/semaphore.ts`

## Rules

`~/.cezar/config.json` is the per-user workspace config **and** the project registry — every repo cezar has been booted in (spec `2026-07-20-multi-project-workspace`). Entry points resolve a `Home` once and pass it through the migrated path mechanisms ([ADR 0059](../adr/0059-resolve-home-at-entry-points.md)). `home/resolve.ts` owns cockpit path formulas, including the legacy cache that ignores `CEZ_HOME`. Runtime config, accounts, model policy, launch, delegation, webhooks and project contexts also receive that object. Library APIs require an explicit Home or a path derived from it. The compatibility shim and ambient library defaults are removed in P1a-2 (hearsay-tools/cezarion#2810). `CEZ_HOME` keeps registry and install writes in tests and containers off a real home. Schema rules are load-bearing: every field optional with `.catch`, `.passthrough()` at every object level, per-entry salvage for `projects` (one bad row never evicts the registry), and writes only through `mergeWriteWorkspaceConfig` (read-modify-write + atomic tmp/rename, `0600`) so two processes converge. A corrupt or read-only home degrades to in-memory defaults with ONE warning — never a boot failure. Migrations are config-files-only, idempotent, additive and non-blocking; run state never migrates. `maxParallel`/`memoryLimitMb` are workspace-wide (`resources`): the per-repo keys are imported once by migration 001 and ignored by enforcement afterwards. Registration is suppressed for task worktrees and `$HOME` itself (`shouldRegisterProject`). A merge-write resolves its path ONCE and uses it for both halves — resolving it twice let a `CEZ_HOME` that changed mid-flight read one home and write another, wiping the user's registry. Two guards back that up: `assertCezarHomeWriteIsSandboxed` refuses any write into the real `~/.cezar` from Vitest, node:test, Jest or Stryker, using the OS account home even when HOME is pinned, and `packages/cezar/vitest.setup.ts` and the node:test preload `scripts/test-home-env.mjs` pin `CEZ_HOME` to a per-worker sandbox so no case ever runs unpinned. Every write that leaves projects behind also snapshots `config.json.bak`, which `loadWorkspaceConfig` restores from when the config is missing, empty or corrupt (a config that parses and is simply empty is the user's own state and is never overridden).

**Agent accounts** (spec `2026-07-29-agent-profiles`) live in this directory too, but in their OWN file — `~/.cezar/agent-accounts.json`, never a key in `config.json`, so a cezar that has never heard of accounts cannot drop them; `src/workspace/agent-accounts.ts` owns the store, `src/core/agent-profiles.ts` the vendor knowledge and `src/workspace/agent-profiles.ts` the resolution.

Changed writes to `config.json` and `agent-accounts.json` first copy the previous content to `backups/<file>/<UTC>-<sha8>.json` under the same home. Private snapshots keep the last 20 plus one per day for 30 days. Backup failures warn once per file and do not block writes. HomeStore preflights the backup directory chain before the write lock. If a backup directory is unavailable, dangling or resolves outside the canonical home, it skips backup creation and pruning while the primary save proceeds. This also skips backups linked to another disk; that backup layout remains a known limit. `cez backup list [<file>]` lists them; `cez backup restore <file> [--at <time>]` restores the newest snapshot at or before that UTC time through the normal writer, which backs up the replaced file. Restore covers JSON only, not account config directories. The separate `config.json.bak` recovery behavior remains unchanged. Its path and version journal are auxiliary too: failed preflight or publication skips the snapshot with one warning; the primary save still succeeds.

### Explicit home paths

Library readers and writers require the caller's `Home` or a path derived from it.
CLI dispatch resolves it once at the operator entry point; task subcommands do not
resolve or receive one. OS-user paths, such as a user-authored tilde skill source,
keep their separate meaning. `cez/home-boundary` enforces this boundary and checks
the shrink-only OS-user reader list (hearsay-tools/cezarion#2810).

Tests select `Home.sandbox(dir)` and use the shared setup's selector for process
entry tests. The factory contains cache and config paths under that directory and
creates a test `install.json` marker without replacing an existing one. Seed fixtures
with `Home.seed` or `Home.seedBytes`; both use HomeStore. A direct file write belongs
only in a test that deliberately simulates an outside writer.

### HomeStore

`home/store.ts` owns registry file reads and writes, including `config.json.bak`,
remote grants, server instance state and install locks. Existing tolerant readers
keep their schema and error behavior. Merge writers hold one short per-root lock
across the read, mutation and replacement. The lock lives in `<home>/.locks/write.lock/`.
It uses unique process claims; stale claims use the process identity checks in
`delegation/process-liveness.ts`. Serving cockpits hold independent
`<home>/.locks/cockpits/<pid>.lease` files. A lease does not block a CLI writer.
Mutual exclusion requires one PID namespace; cross-container bind-mounted homes
are a stated limit. An unconfirmed process claim expires after 30 seconds to recover
from PID reuse. A confirmed live process token never expires. See ADR 0060 for
the long-running-holder trade-off and cross-namespace lease collisions.

Serve, init, run and backup restore prepare an install marker unconditionally.
Other authorized operator entries prepare existing registry files at entry. On an
empty home, they record authorization in process memory and create nothing until
the first write. That write creates the marker and seeds HEAD under the same lock.
Help, invalid commands and pure reads leave an empty home untouched. Managed-layout
writes consume their entry authorization after validation too. Library writes
without entry authorization still require a marker. The marker check uses the actual process to refuse
a `live` home under Vitest, node:test, Jest or Stryker. An env argument cannot bypass
it. The passwd-home guard remains a separate check. Read-only homes stay readable,
even when their auxiliary lock or version directory cannot be written.

The first entry seeds each existing registry file's committed version without
changing its bytes or mode. Each later write stores content by hash, writes `PENDING`,
replaces the live file, advances `HEAD`, then clears `PENDING`. A read finishes an
interrupted commit or records an outside write and pins its original restore target.
Outside-write enforcement stays **off** in P1b (hearsay-tools/cezarion#2811). Later
writes still work and cannot change the pinned target. P1c
(hearsay-tools/cezarion#2812) owns blocking, the banner, and restore/accept routes.
See [ADR 0060](../adr/0060-serialize-home-files-through-homestore.md) for the caller
audit, write ordering and remaining limits.
