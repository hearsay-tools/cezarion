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
