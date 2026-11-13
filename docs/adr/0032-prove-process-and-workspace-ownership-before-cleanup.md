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

The ownership policy (`delegation/workspace-record.ts`, used by `workspace.ts` and
`workspace-removal.ts`) reaches these files only through the
`IdentityFileStore` port (`delegation/identity-file-store.ts`): directory, read, write and
replace. The POSIX store (`posix-workspace-identity.ts`) is the default on a non-Windows host.
On Windows the policy has no default and throws until a store is installed. Each process entry
that reaches the policy calls `installWindowsIdentityStore()` from `windows-identity-store.ts`.
Only process entries reach that module or the native helper `windows-workspace-identity.ts`,
so the policy's importers never load the Windows store.
`identity-store-entries.test.ts` holds both rules.

Destroy stops no tool of its own. After it proves the worktree is the one its receipt and
identity marker name, at its own real path, it runs the project's optional `worktreeTeardown`
commands there (hearsay-tools/squawk#914), before the termination proof and the holder scans.
They stop what the worktree started for itself, such as a test server or a file watcher. A
missing hook, a failed command or a timeout changes nothing else: the scans still decide, a
remaining holder is named by its pid and executable name (never its arguments, which may hold secrets) and never signalled, and the next scheduled
attempt runs the teardown again.

Implementation: [session-process.ts](../../packages/cezar/src/core/session-process.ts), [process-liveness.ts](../../packages/cezar/src/delegation/process-liveness.ts), [workspace.ts](../../packages/cezar/src/delegation/workspace.ts), [workspace-record.ts](../../packages/cezar/src/delegation/workspace-record.ts), [workspace-removal.ts](../../packages/cezar/src/delegation/workspace-removal.ts), [worktree-teardown.ts](../../packages/cezar/src/delegation/worktree-teardown.ts).

Coverage: [session-process.test.ts](../../packages/cezar/src/core/session-process.test.ts), [process-liveness.test.ts](../../packages/cezar/src/delegation/process-liveness.test.ts), [workspace.test.ts](../../packages/cezar/src/delegation/workspace.test.ts), [workspace-destruction-identity.test.ts](../../packages/cezar/src/delegation/workspace-destruction-identity.test.ts), [workspace-destruction-refs.test.ts](../../packages/cezar/src/delegation/workspace-destruction-refs.test.ts) [workspace-generic-cleanup.test.ts](../../packages/cezar/src/delegation/workspace-generic-cleanup.test.ts) and [service-destroy-holder.test.ts](../../packages/cezar/src/delegation/service-destroy-holder.test.ts).

The test environment's lease, its idle-app watcher and their holder reclamation belong to the
repository's own scripts (`.ai/scripts/test-env-lease.mjs`), not to destroy: the product ships
no test-environment code (hearsay-tools/squawk#3515).
