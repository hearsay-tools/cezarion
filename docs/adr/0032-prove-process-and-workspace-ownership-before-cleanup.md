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

Implementation: [session-process.ts](../../packages/cezar/src/core/session-process.ts), [process-liveness.ts](../../packages/cezar/src/delegation/process-liveness.ts), [workspace.ts](../../packages/cezar/src/delegation/workspace.ts).

Coverage: [session-process.test.ts](../../packages/cezar/src/core/session-process.test.ts), [process-liveness.test.ts](../../packages/cezar/src/delegation/process-liveness.test.ts), [workspace.test.ts](../../packages/cezar/src/delegation/workspace.test.ts).
