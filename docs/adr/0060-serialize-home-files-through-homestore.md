# Serialize home files through HomeStore

Accepted for hearsay-tools/cezarion#2811, P1b of the
[home layout spec](../../.ai/specs/2026-11-06-rebrand-and-home-layout.md).
Paths keep the legacy layout in ADR 0059. No env variable or user setting changes.

## Decision

HomeStore owns reads and writes for `config.json`, `config.json.bak`,
`agent-accounts.json`, `ui-state.json`, `remote-settings/<port>.json`, `server.json`,
`server-instances/<slug>.json`, and default/named server install locks.
The existing store APIs retain their return values, tolerant parsing, unknown fields,
backup recovery, and caller-selected error handling. `backupBeforeWrite` runs inside
HomeStore for config and account JSON. Extending rotating backups to every file is P1c.

A synchronous read or read-modify-write holds `<root>/.locks/write.lock/`.
Atomic Lamport bakery claims have unique names and record pid, process start identity
and ordering ticket. Recovery removes only dead process claims. A canonical root
identifies nested transactions in one process. No lock spans an event-loop yield.
Claims use atomic replacement without fsync: they coordinate live processes and
need no crash persistence. Data and journal records retain their durable write order.
Cockpit lifetime leases use `<root>/.locks/cockpits/<pid>.lease` and the same process
liveness helper. Each cockpit has its own lease; leases never exclude writers.

Before a mutation, target files and parent directories must resolve inside the
canonical home and pass the passwd-home guard. The same check covers install.json
and the lock and version directory chains used by the operation. Backup preflight
checks the backup root and per-file directory before the first lock claim. An
unavailable, escaping or dangling backup path disables every backup mutation,
including pruning, and warns once per file; the primary save still succeeds. A named
instance whose basename is config.json keeps its historical nested backup path.
Checks inspect only those path components, never retained version entries. Atomic
replacement replaces a file symlink; pruning unlinks the local snapshot name and
cannot remove its target.
An auxiliary failure during a read always falls back to the live file. This includes
full disks, malformed auxiliary records and permission failures. Only failure to read
the live file may propagate to the tolerant parser.

Only sandbox construction and operator entry preparation create install markers.
Preparation selects `test` under the actual test process, `dev` for dry `serve`/`init`,
and `live` otherwise. An existing marker keeps its identity and kind. Tests cannot
write a live marker home, even through a different env object. The canonical
passwd-home guard runs before marker, lock or journal mutation as a second check.

## Entry and caller audit

CLI `index.ts` prepares the selected Home before operator dispatch. Managed commands
use the same lazy factory. `startServer` also prepares its injected Home for embedded
server consumers. Task subcommands still receive no Home and do no home preparation.
The following library calls now refuse an unmarked home. At shipped defaults each
is reached after one of those entry points:

| Library write | Operator paths |
| --- | --- |
| `mergeWriteWorkspaceConfig` and `.bak` recovery | project registration/tagging, workspace migrations, backup restore, managed update channel, server settings |
| `mergeWriteAgentAccounts` and legacy import | server account routes and backup restore; import on a read-only/unmarked home still works in memory |
| `mergeWriteWorkspaceUiState` | workspace migrations and server UI routes |
| `enableRemoteSettings`, `disableRemoteSettings` | remote-settings CLI and server install/uninstall |
| `saveServerState`, `deleteServerState`, `acquireLock` | server install/deploy/uninstall engine |
| `atomicWriteJsonSync` | compatibility helper; no remaining product caller outside its definition |

The marker-creating command set includes `serve`, `init`, `run`, `projects`, `backup`,
`remote-settings`, `install`, `update`, `use`, `link`, `unlink`, `server-install`,
`server-deploy`, and `server-uninstall`. Preparation failure warns and leaves boot
available; each actual write keeps its caller's existing failure contract.

The reader sweep covers the existing five store modules, workspace migrations,
model policy, scripts, CLI tests, browser source and e2e fixtures. Project-scoped
`.ai/cezar/config.json` and `.ai/cezar/ui-state.json` remain separate stores.
Fixtures use Home sandbox seed helpers. Before-build JS tools use
`scripts/test-install-marker.mjs`. Benchmarks that retain an inherited `CEZ_HOME`
refuse a live marker before starting work.

## Version log and preserved cases

Each file has `<root>/.versions/<relative-file>/`. Content-addressed files hold
immutable bytes. `HEAD` names the committed hash; null means absent. The first
entry seeds existing and absent files without changing live bytes, permissions or
mtime. Each replacement flushes the new bytes, flushes `PENDING`, atomically replaces
the live file, flushes `HEAD`, then removes and flushes `PENDING`.

Install locks retain the historical exclusive-create contract for older binaries.
HomeStore stores durable bytes and PENDING, flushes a private staging file, then
publishes it with an exclusive hard link. HEAD advances only after publication.
An EEXIST result clears PENDING before the original held/stale/self checks and single
reclaim retry. It never replaces another live holder. Crashes before or after the
link recover through PENDING. If an older writer creates its lock during a failed
exclusive attempt, a crash in the EEXIST window can flag that real outside write.

| Observed state on next read | Result |
| --- | --- |
| Actual hash matches HEAD, no pending write | Read normally |
| Old bytes, PENDING present | Cancel interrupted replacement |
| New bytes match PENDING | Finish the interrupted commit |
| HEAD advanced, PENDING still present | Clear PENDING |
| Actual hash differs from HEAD and PENDING | Record OUTSIDE and pin the previous HEAD |
| Later HomeStore write after OUTSIDE | Succeed; retain the original pinned restore target |
| Restore after later writes | Restore the pinned bytes, then remove OUTSIDE |
| Auxiliary state is read-only | Return readable live data; do not substitute defaults |
| Config is missing, empty or corrupt and .bak is valid | Preserve the existing .bak recovery contract |

P1b ships outside-write enforcement off. One internal constant in `version-log.ts`
controls the write refusal. P1c turns it on with the banner and restore/accept routes.
No public setting exposes it. Marker, lock, journal and replacement files are private
(`0600` files, `0700` directories on Unix).

## Limits

Canonical passwd-home checks cover existing symlinks and unresolved descendants.
Marker checks read the selected directory, so lexical aliases of the same home see
the same kind. Locks use the canonical root for nested transactions. An outside
process can still change a path after a check or write between inspection and atomic
replacement. It does not honor our lock; P1b cannot exclude it.

Crash recovery clears PENDING. A process killed during a staging write can leave a
private `*.tmp` file. It is not treated as a committed version or an outside write.
Pruning it is deferred: an old-looking staging file can still belong to a live
process, and deleting it is unnecessary for recovery. Content versions are retained
so a pinned restore target cannot be pruned. Retention policy belongs to a follow-up after P1c; P1b does not add retention.
