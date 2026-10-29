# Prove process and workspace ownership before cleanup

Session cleanup must reach owned descendants without signalling a reused process id.
POSIX sessions start in their own groups. Record live member incarnations and retain a group
only while recorded evidence still matches. After leader exit, bounded output drain precedes
cleanup. Windows uses the owned child’s process tree mechanism.

## Consequences

A process that leaves the group is outside group cleanup. If the last recorded member exits
before a child can be vouched for, cezar can retain that child rather than risk a reused group.
Do not state that every descendant is always killed.

Worker destroy and path reuse require fresh resource proof, not just controller death or boot
identity. Unknown evidence retains resources and retries. Persist intent before deletion and
compare branch tip/reflog content, not inode identity, before removing owned Git state. Cleanup
and admission checks must not yield between their final ownership proof and mutation.

On Windows, receipt directories, receipts, cleanup checkpoints and Git administration
markers use protected ACLs owned by the current user. Only that user, SYSTEM and
administrators may have access. An existing broader ACL is refused, never silently
repaired. The native helper validates the security descriptor and object type through
the open handle; it rejects reparse points and hard-linked identity files. It pins
ancestor directories without delete sharing while reading, creating or replacing an
identity. Checkpoints use a flushed temporary file and a handle-based atomic rename,
so an interruption preserves either the old or the new checkpoint. An incomplete
temporary file cannot authorize cleanup. This store requires a local drive with Windows
ACL support; unsupported or unreadable evidence retains resources.

Cleanup claims an idle test environment before stopping its app and scanning holders.
The claim remains durable through worktree removal, while the SQLite handle is closed
so it does not itself prevent Windows deletion. An active lease, unverified app identity
or failed stop retains the worktree. Windows has no cwd scan, so that refusal must not
depend on a later scan finding the app.

Implementation: [session-process.ts](../../packages/cezar/src/core/session-process.ts), [process-liveness.ts](../../packages/cezar/src/delegation/process-liveness.ts), [workspace.ts](../../packages/cezar/src/delegation/workspace.ts).

Coverage: [session-process.test.ts](../../packages/cezar/src/core/session-process.test.ts), [process-liveness.test.ts](../../packages/cezar/src/delegation/process-liveness.test.ts), [workspace.test.ts](../../packages/cezar/src/delegation/workspace.test.ts).

### Waiting for the test-app watcher

The watcher starts with the system temporary directory as its working directory.
A checkout cwd scan therefore cannot prove that it has closed its log and SQLite
handles. Before Git removal, cleanup scans full process command lines for the
checkout's `test-env-lease.mjs watch-app` process, on Windows as well as POSIX.
This scan authorizes no signal. An ambiguous match, failed scan or timeout keeps
the checkout for retry. Cleanup performs it even for an already-stopped app.

| Case | What stops it | Behavior at shipped defaults |
| --- | --- | --- |
| App stopped normally | Existing watcher observes the leader exit | Cleanup waits for watcher exit before removing files |
| Starting command interrupted before watcher start | No watcher exists | Successful process scan permits cleanup |
| Starting command interrupted after watcher start | Watcher observes the leader exit | Command-line scan finds it regardless of cwd or missing descriptor watcher identity |
| App descriptor deleted or forged | Existing app ownership checks refuse uncertain cleanup | Watcher scan never signals a process |
| Watcher remains live beyond 32 seconds | Existing watcher policy still applies | Cleanup refuses; a later destroy retries |
| Process table unavailable | No process is signalled | Cleanup refuses |

### Reclaiming exited test-environment holders

Destroy and the test-environment lease writer share the holder probes and reclamation
policy in `detached-process.ts`. Inside a write transaction, a row can be reclaimed
only when its process incarnation is gone (including a verified reused PID) and its
recorded group is absent. Unknown probes and surviving descendants retain the row.
Supervision release also reclaims exited joined shells; it never releases the rows
of still-live participants merely because its command leader exited.

A missing descriptor with a safe lease database can be idle. Destroy claims that
database before continuing, signals no app without a descriptor, and still requires
the watcher and worktree process scans. Corrupt or unreadable metadata and redirected
paths remain refusals. Refusals report the lease path and bounded PID/start/group
evidence, or explain metadata uncertainty. The durable claim stays through removal
and is reclaimed after an interrupted destroy only with the same death proof.

| Case | What stops it | Behavior at shipped defaults |
| --- | --- | --- |
| Command exits normally, with an error, SIGINT or SIGTERM | Supervisor settles its child and releases its lease | Reclaims joined participants only after their incarnation and group are gone |
| Supervisor dies before or after child start | No supervisor cleanup is assumed | Surviving joined participants keep their protection; later acquisition/destroy reclaims only proven-dead rows |
| Dead leader leaves live or uncertain group | Last group member exits and a later probe proves absence | Retains checkout until then |
| Descriptor missing | No signal is authorized | Validated idle lease plus watcher and process scans can permit removal |
| Descriptor corrupt, unreadable or redirected | Human repairs metadata | Retains checkout and reports the blocker |
| Destroy dies after claiming | Later destroy/acquisition proves its incarnation gone | Reclaims stale claim inside the next write transaction |
