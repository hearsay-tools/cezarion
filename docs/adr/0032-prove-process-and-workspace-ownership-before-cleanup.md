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

Ordinary cleanup claims an idle test environment before stopping its app and scanning holders.
The claim remains durable through worktree removal, while the SQLite handle is closed
so it does not itself prevent Windows deletion. An active lease, unverified app identity
or failed stop retains the worktree. Windows has no cwd scan, so that refusal must not
depend on a later scan finding the app.

Explicit destruction of a verified owned worker follows the owner's later policy:
new contents, a live holder, or a stale, forged, or unreadable lease do not revoke
ownership. Persist the evidence snapshot before signalling or deletion. Check the
receipt, generation, root and registration again at destructive boundaries; retain
external resources, replaced roots and branches that fail their compare-and-swap.
Use independent OS path evidence or a trusted generation record to select processes,
check their incarnation before bounded termination and retry after OS failures.
Do not signal a PID solely because an untrusted lease names it. A process can start
after a scan, and a token check and POSIX signal are not atomic. This policy does not
claim hard isolation or that every future same-user process can be prevented.
Destroy remains incomplete until owned worktree, branch and scratch are gone.

For explicit worker destruction on macOS, the owner accepts a narrow permission-repair
race. Pin the no-follow parent, verify the target directory identity, add owner access
without clearing existing mode bits, then reopen through that parent and compare its
identity. A final-name replacement can have its permissions changed before the mismatch
is detected. A mismatch or failed check retains the resources and never authorizes
deletion. Recheck destroy intent, ownership, mount boundaries and holders at the existing
mutation boundaries. Ordinary run cleanup does not use this exception.

Implementation: [session-process.ts](../../packages/cezar/src/core/session-process.ts), [process-liveness.ts](../../packages/cezar/src/delegation/process-liveness.ts), [workspace.ts](../../packages/cezar/src/delegation/workspace.ts).

Coverage: [session-process.test.ts](../../packages/cezar/src/core/session-process.test.ts), [process-liveness.test.ts](../../packages/cezar/src/delegation/process-liveness.test.ts), [workspace.test.ts](../../packages/cezar/src/delegation/workspace.test.ts).

### Waiting for the test-app watcher

For ordinary cleanup, the watcher starts with the system temporary directory as its working directory.
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
