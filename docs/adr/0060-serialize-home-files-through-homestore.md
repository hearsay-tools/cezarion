# Serialize home files through HomeStore

Accepted for hearsay-tools/cezarion#2811, P1b of the
[home layout spec](../../.ai/specs/2026-11-06-rebrand-and-home-layout.md).
Paths keep the legacy layout in ADR 0059. No env variable or user setting changes.

## Decision

HomeStore owns reads and writes for `config.json`, `config.json.bak`,
`agent-accounts.json`, `ui-state.json`, `remote-settings/<port>.json`, `server.json`,
`server-instances/<slug>.json`, and default/named server install locks.
The existing store APIs retain their return values, tolerant parsing, unknown fields,
backup recovery, and caller-selected error handling. The config.json.bak path and
its own journal are auxiliary: failed preflight or publication warns once, skips
that snapshot and never blocks the primary save. `backupBeforeWrite` runs inside
HomeStore for config and account JSON. Extending rotating backups to every file is P1c.

A synchronous read or read-modify-write holds `<root>/.locks/write.lock/`.
Atomic Lamport bakery claims have unique names and record pid, process start identity
and ordering ticket. Recovery removes dead claims and expires unconfirmed claims
as described below. A canonical root
identifies nested transactions in one process. No lock spans an event-loop yield.
The current process start token is read lazily once, including an unavailable
result. Prepared peer-free reads never invoke macOS ps; only an existing peer
claim needs a fresh peer liveness check. Claims use atomic replacement without fsync: they coordinate live processes and
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

Only sandbox construction and authorized operator entries create install markers.
Preparation selects `test` under the actual test process, `dev` for dry `serve`/`init`,
and `live` otherwise. An existing marker keeps its identity and kind. Tests cannot
write a live marker home, even through a different env object. The canonical
passwd-home guard runs before marker, lock or journal mutation as a second check.

## Entry and caller audit

CLI `index.ts` authorizes the selected Home before operator dispatch. Managed commands
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

`serve`, `init`, `run` and `backup restore` prepare unconditionally. `projects`,
`remote-settings`, `install`, `update`, `use`, `link`, `unlink`, `server-install`,
`server-deploy` and `server-uninstall` record their entry and marker kinds in process
memory. If any registry file exists, they also prepare the marker and seed HEAD
at entry. Otherwise their help, validation failures and pure reads create no home,
marker, lock or journal. Backup listing remains read-only too.

The first authorized HomeStore write preflights all seeding paths, takes write.lock,
creates the marker, seeds HEAD and performs the write without releasing the lock.
Entry preparation uses that same transaction, including marker publication. Each
registry file seeds independently; unreadable files and unsafe auxiliary paths
cannot stop other seeds, boot or an unrelated primary write. Existing HEAD records
stay unchanged. Missing HEAD records are retried at every entry and at the first
authorized transaction even when a marker already exists. Incomplete attempts
remain eligible for retry in process memory; no additional persisted state is used.
An unmarked library writer without that process-local authorization still refuses.
Authorization is not inherited by child processes. Managed-layout writers remain
outside HomeStore; after validation, their first mutation consumes the same entry
authorization before writing versions or links. A layout library caller with no
entry authorization keeps its existing passwd-home guard contract.
Preparation failure warns and leaves boot available; actual writes keep their
caller's existing failure contract.

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

Mutual exclusion supports cockpits in one PID namespace. A bind-mounted home shared
across container PID namespaces can lose exclusion: local liveness may remove a
foreign claim whose PID is absent or whose readable start token differs. Writes
then have the pre-P1b last-writer-wins behavior. Advisory `<pid>.lease` files can
also overwrite each other across namespaces. Cross-namespace identity belongs to
a follow-up after P1b; this slice does not add it.

An undefined recorded token or unreadable current token makes a live PID count as
the holder. To recover from a crashed holder followed by PID reuse, an unconfirmed
claim expires after its mtime is more than 30 seconds old, three times the 10-second
wait. A confirmed matching token never expires. This trades exclusion for recovery
on Windows and unreadable-token systems. An unconfirmed claim expires more than
30 seconds after publication, whether its holder is waiting, stalled or still
working. A later waiter can then take the lock, so a long-running write can lose
updates. Cross-namespace identity and advisory lease collisions are tracked by
hearsay-tools/cezarion#2906. Cross-namespace homes remain unsupported.

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

## Secondary-write audit

| Write besides the primary file and its journal | Contract |
| --- | --- |
| config.json.bak and its version log | Auxiliary; preflight best effort before the primary transaction, skip on any failure, warn once. Recheck before publication; a later failure leaves the committed primary intact. |
| Rotating snapshots and pruning under backups/<file> | Auxiliary; preflight before the first claim, skip every backup mutation on failure, warn once. |
| Cockpit presence lease and stale-lease cleanup | Advisory operation; lifecycle preparation and close handlers catch failures. It never blocks another writer. |
| Short lock claims and their staging files | Required serialization protocol, not another application-state write. Failure cannot be ignored safely. |
| Primary/journal staging, HEAD, PENDING, OUTSIDE and pinned content | Required journal protocol for that file. Snapshot journals are auxiliary with their snapshot. |
| install.json entry authorization | Required before a state write; operator preparation catches failure so a read-only cockpit can still boot. |

Accounts merge/import and UI-state transactions have one primary file; account
import does not rewrite its source config. Remote grant removal may name several
primary grants. Install-lock release removes its own primary lock best effort.
No other HomeStore transaction writes an application-state companion file.
