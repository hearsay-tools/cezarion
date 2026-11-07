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

## Split home roots (staged)

ADR 0059 defines `Home.config`, `state`, `data`, `cache` and `runtime`.
`root` remains the config root. `resolveHome({ purpose, env?, layout?, platform? })`
selects legacy by default while `REBRAND_SWITCH` is false. Tests select split
explicitly; do not mock the switch. `Home.sandbox(dir, { layout: 'split' })`
creates a test marker under `<dir>/config` and keeps every kind under dir.

In split layout, registry, accounts and remote settings use config. UI state,
server files and locks, backups and application updates use state. Managed
versions and bin use data. Skills and dry caches use cache. Runtime has no file
consumer yet. Legacy paths and managed launcher fixtures remain unchanged.
`home/file-location.ts` exports the single `homeFileKind(key)` map and
`homeFileLocation(home, key)` for unchanged HomeFile keys. Config, its `.bak`,
accounts and remote grants use config. UI state, server state, named instances
and install locks use state. HomeStore uses the owning root for `write.lock`
and `.versions/<key>/`; readers of state paths pass their Home explicitly.
The marker check always reads `<config>/install.json`; presence leases stay in
`<config>/.locks/cockpits/`. Backups of both kinds use `<state>/backups/<key>/`.
Recovery scans live families and journals in both roots, including deleted files,
and watches both roots and their journal families only while subscribed.
Entry seeding holds the config lock through marker publication and seeds each
file under its owning lock. Transactions that need both roots take config first.
Legacy roots coincide, so their paths and existing recovery formats stay intact.

`HSQ_HOME` selects one-root subdirectories and wins over `CEZ_HOME`; an explicit
legacy-default `CEZ_HOME` counts as unset in split layout. Both names belong to
`HOME_LOCATING_ENV` and are always removed from child environments. The separate
`HOME_LAYOUT_ENV` list contains platform layout values, which still reach agents.
The resolver has no filesystem access. New roots and the Windows current-user
private ACL stay behind the disabled release switch.

## Legacy migration (staged)

`home/migrate.ts` exports synchronous `migrateLegacyHome(legacy, target,
{ commit = true, env?, onStep? })`. Entry points call it only while
`REBRAND_SWITCH` is enabled; tests inject a split Home. It returns
`{ status: 'fresh' | 'migrated' | 'unchanged' | 'pending', record? }`.
`home/migration-plan.ts` exports the shared read-only `planLegacyMigration`
used by `cez migrate --dry-run`. The command is absent with the switch off.

The legacy `.migrating` claim contains `{ pid, startToken? }`, uses exclusive
creation, and reclaims proven-dead holders under the legacy write lock.
Steps 2–8 run synchronously under that lock, then target config and state
locks, without extending the short-lock protocol. HomeStore checks for the
claim before waiting and inside its transaction. This one safety change is
unconditional; ordinary reads do not probe `.migrating`.
Boot refuses live migration holders and lets migration reclaim dead holders,
including a pending copy left by a hard crash. Only a finished
`commit: false` copy is a staged server group: its record has `stagedAt` and
boot serves it read-only. A pending home without `stagedAt` is a failed or
crashed run, and boot restarts it at step 4. Step 5's recovery refusal runs
before the first target write, so a refused run leaves no pending home.
Recovery inspections recheck the claim and pending marker under their lock.
They then run the normal journal interpretation on a report-only VersionLog,
which keeps every record change in memory: a reset interrupted after its
replacement (PENDING, stale HEAD) still reports, and no journal file changes.

`installMarkerSchema.state` is `pending | committed | undefined`.
`writeMigrationMarker` is the migration's only marker writer; ordinary marker
creation never overwrites one. A pending home refuses HomeStore writes and
permits reads and cockpit leases. Boot detects `install.json.state ===
'pending'` with a staged record and skips migration and seeding so P2c can
check the group read-only.
`prepareHomeLifecycle(home, instance?)` passes the instance into its lease.

For P2c, `migrateLegacyHome(..., { commit: false })` leaves a pending copy.
`commitLegacyMigration(target, env?)` rechecks the legacy hashes, commits the
marker and writes `MOVED.json`. After the marker commits, a retry only finishes
publication and PATH updates; later legacy changes belong to the canary.
Profile symlinks stay intact; a profile inside the legacy home stays unchanged
with a warning. `rollbackLegacyMigration(target)` renames a
pending marker to `install.json.failed`; the next explicit migration overwrites
the recorded pending destinations. Rollback never rewrites legacy registry data.

`home/migration-record.ts` owns `migrationRecordSchema` (version 1) and the
private `readMigrationRecord(home)` / `writeMigrationRecord(home, record)` pair.
Writers hold config then state locks. A record contains `legacyRoot`, all five
`roots`, `createdAt`, `backup`, `files`, `deferredAccounts`, `notMoved`, and
the optional `stagedAt`.
Each file has its legacy-relative `path`, SHA-256 `hash`, `mtimeMs`, and a
nullable `target: { kind: config | state | data, path }`. Unmapped legacy files
are observed but not imported. `movedHomeSchema` is
`{ version: 1, roots, migratedAt }`.

Step 7 uses VersionLog under the migration locks to rewrite target account
paths while pending. It preserves the legacy bytes and publishes HEAD; it
does not add a HomeStore bypass. Deferred accounts finish at a later boot
through ordinary HomeStore writes once no live registered run can use them.
The read-only run-store probe uses live run rows and a live family owner's PID
and start token. It defers unknown selections or unreadable stores too; dry-run
lists the same deferrals. A non-cockpit owner can keep a closed session's account
deferred until its claim ends. Live legacy cockpit leases already stop step 2.
An internal omp account stays in place and records `notMoved` with reason
`omp-profile-root-inside-legacy-home`; the warning asks to move `PI_CONFIG_DIR`
outside the legacy home (planner decision for hearsay-tools/cezarion#2933).
Account inventory reads accounts through the loader's own source,
`readAgentAccountSource`: `agent-accounts.json` with the loader's salvage
(a non-array `accounts` names no account), or, when that file is absent, the
one-time `config.json` `agentProfiles` import. An imported account relocates
like a stored one; the rewrite publishes the store that import would persist.
Account inventory uses the loader's first-wins ID rule. Later duplicate IDs
stay in place and record `notMoved` with reason `duplicate-account-id`.
Each pending account or managed tree is rebuilt in a fresh staging directory.
Deferred retries first check the target registry: an already rewritten
configDir repairs the migration record without copying over live credentials.

`isCezarMigrationJson` defines the strict JSON set. It covers cezar's live registry,
state, grants, connections and update JSON. Historical backups and version
snapshots are opaque bytes, even when their filenames end in `.json`.
An exact legacy `ACCEPTED` journal record follows its copied registry bytes;
other journal records do not migrate. A recopy drops acceptance if its hash
no longer matches, so an unrelated later state cannot inherit it.
Opaque vendor account
trees and managed `versions/` are verified byte for byte, since their `.json`
files can be JSONC. Copies, archives, records and journals use private files
and split-layout Windows ACLs. Every tree copy keeps the owner-execute bit:
a file is 0700 when its owner could execute the source (managed executables,
launchers, account profile hooks) and 0600 otherwise. The old launchers remain
unchanged. Archive entries record the same 0700 or 0600 mode. Launchers come from `writeLaunchers`, and the PATH line update
replaces the line `pathHook` defines for `cez install`.
The managed package link at `versions/<id>/node_modules/@wjarka/cezarion`
keeps an external checkout only when its version manifest records that same
checkout with `source: 'link'`. Other escaping links refuse migration.
Staged tree copies compute link targets against the final destination;
absolute links and Windows junctions never retain staging paths.
The archive writes one gzip member per tar entry, followed by tar end blocks.
This standard concatenated gzip stream bounds buffers by the largest file,
while retaining legacy journal history and backups in the archive.
