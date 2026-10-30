# Sweep proven-merged branches after retention

Retention reclaims a finished task's worktree directory and keeps its branch, so Continue can
recover local-only commits. A sweep then deletes the local branches that hold no local-only work:
the bulk-safe classes `merged` and `empty` of ADR 0048. It runs at startup and at project open,
and after each post-terminal retention pass, at most once every five minutes per repository.
`worktreeRetention: 0` turns it off with retention. It never deletes a remote branch, a tag or
task history.

## Consequences

The sweep reads `refs/heads`, not the worktree directories, so it finds a branch whose directory
is gone or whose run record was deleted. A missing owner never permits a delete on its own: an
ownerless branch goes only on ancestry or exact merged-PR evidence, and one with commits that are
not on the base stays an `orphan` that needs a typed delete.

Each delete goes through `deleteBranches`, which reclassifies first. So the sweep keeps every
guarantee in ADR 0048: run claims, the worktree mutation lock, rechecks of checkouts and
owned-workspace receipts, and a ref transaction that verifies the base and the tip. The sweep
also holds the cockpit's branch switch and pull claim. A receipt-owned worker branch is `active`
and is never swept; hearsay-tools/cezarion#911 owns its cleanup.

A configured base `origin` resolves to the concrete branch that `refs/remotes/origin/HEAD` names,
as `git` resolves it when a worktree forks from it. A ref that git reads before the alias, such as
a tag `origin`, makes the base ambiguous, and then nothing reads as merged. Merged-PR evidence is
read per branch head, so it does not depend on how many PRs the repository has. A head that GitHub
does not answer in full stays kept, and its row says why.

A branch outside `cez/*` is swept only as the exact merged PR that a finished run recorded: same
head, same tip, same base, and the merge commit on the base. Any other branch outside `cez/*` is
the user's and is never deleted from the cockpit.

Continue on a run whose branch was swept recreates `cez/<id8>` from the base. That loses nothing,
because a swept branch held no commits that the base or another ref lacks.

## Considered Options

- **Delete the branch with the worktree directory.** Rejected: Done does not prove the work
  merged, so a reclaim would destroy local-only commits.
- **Lower the retention keep-count.** Rejected: it bounds directories, not branch refs.
- **Read the newest 500 PRs as the whole history.** Rejected: older squash merges lost their only
  merge evidence.

Implementation: [repo-branch-sweep.ts](../../packages/cezar/src/server/repo-branch-sweep.ts), [repo-branches.ts](../../packages/cezar/src/server/repo-branches.ts), [repo-branch-forge.ts](../../packages/cezar/src/server/repo-branch-forge.ts), [2026-07-18-worktree-retention.md](../../.ai/specs/2026-07-18-worktree-retention.md).

Coverage: [repo-branch-sweep.test.ts](../../packages/cezar/src/server/repo-branch-sweep.test.ts), [repo-branch-lifecycle.test.ts](../../packages/cezar/src/server/repo-branch-lifecycle.test.ts), [repo-branch-forge.test.ts](../../packages/cezar/src/server/repo-branch-forge.test.ts), [run-settlement-branch-sweep.test.ts](../../packages/cezar/src/workflows/run/run-settlement-branch-sweep.test.ts), [retention-rematerialize.test.ts](../../packages/cezar/src/runs/retention-rematerialize.test.ts).
