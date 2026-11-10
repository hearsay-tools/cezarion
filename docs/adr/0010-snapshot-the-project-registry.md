# Write registry snapshots with bounded recovery

The project registry is a user-curated list, even though it is optional state. Save JSON
through unique per-write temp files and atomic rename. Resolve its path once for each merge
write. A best-effort `.bak` snapshot gives reads a recovery source if the primary is lost.

## Consequences

Every successful write refreshes the backup, including an empty registry, so removal of the
last project cannot resurrect an older list. Reads restore a non-empty valid backup in memory;
a valid empty primary is intentional. Deleting the whole cezar home resets both copies.

Merge writes reread and save inside one HomeStore transaction under the home's `write.lock`
([ADR 0060](0060-serialize-home-files-through-homestore.md)). That lock serializes the
read-to-rename interval across processes. Atomic replacement prevents partial JSON. Merges
can still lose updates where the lock cannot exclude a writer; ADR 0060 § Limits lists those
cases. A backup can also lag when another version does not maintain it.

## Considered Options

- **Use one fixed temp name.** Rejected because concurrent writers can truncate or rename each other’s staging file.
- **Back up only non-empty registries.** Rejected because an old backup can restore a project the user removed.

Implementation: [config.ts](../../packages/cezar/src/workspace/config.ts), [store.ts](../../packages/cezar/src/home/store.ts), [write-lock.ts](../../packages/cezar/src/home/write-lock.ts).

Coverage: [config.test.ts](../../packages/cezar/src/workspace/config.test.ts).
