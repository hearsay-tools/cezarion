# Isolate Git reads and serialize shared mutations

Git diff operations can refresh an index, and intent-to-add writes it. Cezar reads diffs
through a private index so concurrent autosave and inspection do not compete for the task’s
real index. The copy retains the source mtime so same-size edits in Git’s racy timestamp
window remain visible.

## Consequences

Scratch indexes try the OS temp directory and then the Git directory. If neither works,
the read uses the real index instead of reporting an empty diff. That fallback is not the
normal isolation guarantee.

Worktree mutations use a separate cross-process lock keyed by the canonical Git common
directory. A short-lived keeper owns the lock and its Git children until they exit, even if
the caller disconnects. Task branches use `--no-track`; explicit base refs make upstream
configuration unnecessary and avoid a shared config write.

## Considered Options

- **Read through the live index.** Retained only as a degraded fallback; normally it races staging and commits.
- **Expire a mutation lock by heartbeat.** The keeper instead ties release to child completion, so a slow or stopped Git command cannot overlap a new mutation.

Implementation: [git-index-copy.ts](../../packages/cezar/src/git-index-copy.ts), [git-worktree-lock.ts](../../packages/cezar/src/git-worktree-lock.ts), [git-worktree.ts](../../packages/cezar/src/git-worktree.ts).

Coverage: [git-index-copy.test.ts](../../packages/cezar/src/git-index-copy.test.ts), [git-worktree-lock.test.ts](../../packages/cezar/src/git-worktree-lock.test.ts), [git-changes.test.ts](../../packages/cezar/src/server/git-changes.test.ts).
