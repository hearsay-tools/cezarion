# Attribute diff summaries to the task’s work

A task can fetch a newer base or check out another branch. A diff against a stale local
base can count upstream work. A diff against the checked-out branch can count work that
predates the task. Task summaries and structured changes therefore share one anchor resolver.
It selects the local base only when it contains the remote base. For a changed task branch,
it compares the branch reflog at run start with the merge-base and selects the anchor with
fewer changed lines.

## Consequences

Without a usable start time or branch reflog, a repointed task uses `HEAD` and reports
uncommitted work only. That can omit committed work, but avoids an unsupported ownership claim.
The result records when narrowing occurred.

The text `/diff` endpoint and variant comparisons retain their whole-branch merge-base
semantics. The text endpoint is a protected API. Settlement also uses it to avoid declaring
reviewable work empty; a review gate still depends on the run’s settings.

## Considered Options

- **One merge-base for every surface.** Kept for whole-branch consumers; insufficient for task attribution after a branch change.
- **Always use `HEAD` after a branch change.** Retained as the fallback; otherwise it loses commits the task made on its new branch.

Implementation: [git-diff-base.ts](../../packages/cezar/src/git-diff-base.ts), [git-worktree.ts](../../packages/cezar/src/git-worktree.ts), [BACKWARD_COMPATIBILITY.md](../../BACKWARD_COMPATIBILITY.md).

Coverage: [git-diff-base.test.ts](../../packages/cezar/src/git-diff-base.test.ts), [git-changes.test.ts](../../packages/cezar/src/server/git-changes.test.ts).
