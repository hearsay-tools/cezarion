# Distinguish final autosave flushes from periodic saves

The periodic autosave timer is opt-in, while turn-end, finalization and pre-PR flushes keep
finished task state on a branch. Record the reason and a structured result so an opted-out
timer cannot be confused with a required flush.

## Consequences

Turn-end, finalization and periodic saves require HEAD to remain on the task branch. They do
not commit work on a branch the agent checked out. The pre-PR save follows the current branch
and must report refusal or failure, since pushing without final work is visible data loss.

A save remains non-atomic across Git’s staging and commit operations. Retain the nearby race,
holder and operation-state checks; an ADR does not replace those safety notes. No-change,
skipped, refused and failed results must stay distinct so callers can choose the right action.

Implementation: [git-worktree.ts](../../packages/cezar/src/git-worktree.ts), [run.ts](../../packages/cezar/src/workflows/run.ts).

Coverage: [git-worktree.test.ts](../../packages/cezar/src/git-worktree.test.ts), [autosave-task-branch.test.ts](../../packages/cezar/src/autosave-task-branch.test.ts), [autosave-gate.test.ts](../../packages/cezar/src/workflows/autosave-gate.test.ts), [autosave-report.test.ts](../../packages/cezar/src/workflows/autosave-report.test.ts).
