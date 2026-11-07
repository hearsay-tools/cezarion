# Workspace registry and per-user state (`~/.cezar/`)

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/paths.ts`, then `packages/cezar/src/workspace/config.ts`, `packages/cezar/src/workspace/projects.ts`, `packages/cezar/src/workspace/migrations.ts`, `packages/cezar/src/workspace/semaphore.ts`

## Rules

`~/.cezar/config.json` is the per-user workspace config **and** the project registry — every repo cezar has been booted in (spec `2026-07-20-multi-project-workspace`). Entry points resolve a `Home` once and pass it through the migrated path mechanisms ([ADR 0059](../adr/0059-resolve-home-at-entry-points.md)). `home/resolve.ts` owns cockpit path formulas, including the legacy cache that ignores `CEZ_HOME`. Runtime config, accounts, model policy, launch, delegation, webhooks and project contexts also receive that object. Library APIs require an explicit Home or a path derived from it. The compatibility shim and ambient library defaults are removed in P1a-2 (hearsay-tools/cezarion#2810). `CEZ_HOME` keeps registry and install writes in tests and containers off a real home. Schema rules are load-bearing: every field optional with `.catch`, `.passthrough()` at every object level, per-entry salvage for `projects` (one bad row never evicts the registry), and writes only through `mergeWriteWorkspaceConfig` (read-modify-write + atomic tmp/rename, `0600`) so two processes converge. A corrupt or read-only home degrades to in-memory defaults with ONE warning — never a boot failure. Migrations are config-files-only, idempotent, additive and non-blocking; run state never migrates. `maxParallel`/`memoryLimitMb` are workspace-wide (`resources`): the per-repo keys are imported once by migration 001 and ignored by enforcement afterwards. Registration is suppressed for task worktrees and `$HOME` itself (`shouldRegisterProject`). A merge-write resolves its path ONCE and uses it for both halves — resolving it twice let a `CEZ_HOME` that changed mid-flight read one home and write another, wiping the user's registry. Two guards back that up: `assertCezarHomeWriteIsSandboxed` refuses any write into the real `~/.cezar` from Vitest, node:test, Jest or Stryker, using the OS account home even when HOME is pinned, and `packages/cezar/vitest.setup.ts` and the node:test preload `scripts/test-home-env.mjs` pin `CEZ_HOME` to a per-worker sandbox so no case ever runs unpinned. Every write that leaves projects behind also snapshots `config.json.bak`, which `loadWorkspaceConfig` restores from when the config is missing, empty or corrupt (a config that parses and is simply empty is the user's own state and is never overridden).

**Agent accounts** (spec `2026-07-29-agent-profiles`) live in this directory too, but in their OWN file — `~/.cezar/agent-accounts.json`, never a key in `config.json`, so a cezar that has never heard of accounts cannot drop them; `src/workspace/agent-accounts.ts` owns the store, `src/core/agent-profiles.ts` the vendor knowledge and `src/workspace/agent-profiles.ts` the resolution.

Every changed HomeStore file is backed up before replacement or removal under
`Home.backups/<home-relative file>/<UTC>-<sha8>.json`, including remote grants,
server instances and raw install locks. Private snapshots keep the last 20 plus
one per day for 30 days. Backup failures warn once per file and never block the
primary write. HomeStore checks the backup directory chain before the write lock;
unavailable, dangling or escaping paths disable both backup creation and pruning.
`cez backup list [<file>]` discovers every supported file, including backups whose
live file is gone. Legacy root-file snapshots and nested named-instance snapshots
remain readable. `config.json.bak` is listed as the newest config backup; the
loader still restores it only when the primary is missing, blank or corrupt.
`cez backup restore <file> [--at <time>]` uses the same recovery writer as the
cockpit. The default restores a pinned recovery target when one exists; an explicit
UTC time selects a retained snapshot. Restoring config/accounts keeps tolerant
schema parsing. Other home files, including locks, restore their exact bytes.
Account config directories are not restored. The `.bak` snapshot and its journal
stay auxiliary: a failure warns and leaves the primary save committed.

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
changing its bytes or mode. Marker publication and seeding hold one write lock.
Each file seeds best effort; an unreadable file cannot stop other files or an
unrelated primary save. Every entry and the first authorized transaction retry
missing HEAD records even when the marker exists. Each later write stores content by hash, writes `PENDING`,
replaces the live file, advances `HEAD`, then clears `PENDING`. A read finishes an
interrupted commit or records an outside write and pins its original restore target.
Outside-write enforcement is **on** in P1c (hearsay-tools/cezarion#2812). All
HomeStore mutations, including exclusive lock creation, refuse a flagged file until
an explicit restore or acceptance. The pinned target cannot absorb later writes.
Emptying nonempty projects or accounts records a durable reset flag with the prior
version. Recovery demand also detects an empty registry whose newest backup has
projects. Acceptance records the current hash, so an accepted empty registry does
not raise the same banner again.

`GET /api/v1/home/recovery` exposes file names, reasons, times and restore availability;
it never exposes file contents. Metadata and content fingerprints avoid repeated
HomeStore transactions for unchanged files, including on coarse-timestamp filesystems.
The trusted-only `home:recovery` topic uses
filesystem watches only while subscribed, including journal directories so another
cockpit's acceptance clears the banner. Restore and accept POST routes use the
normal origin guard, `localHandoff`, and the contract's HomeStore file allowlist.
Remote grant files remain host-CLI-only. Remote banner rows are read-only. Actions
carry the incident time; resolved retries do nothing, while a different incident
returns a conflict. See ADR 0060 for
write ordering and the remaining version-retention and staging-file limits.
