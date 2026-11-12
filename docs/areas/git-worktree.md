# Git and worktree logic

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/git-worktree.ts`, `packages/cezar/src/git-diff-base.ts`, `packages/cezar/src/server/git.ts`

## Two project directories before P5

Recognize managed worktrees under both `.ai/cezar/worktrees/` and
`.ai/squawk/worktrees/`, including owned-workspace receipts and orphan protection.
New worktrees and receipts retain the legacy write paths. Never remove or change
fallback worktree bytes. Retention and orphan cleanup skip them and print one
count per sweep. Legacy-only resource cleanup keeps all existing ownership checks.
Git common-directory discovery remains independent of either directory name.
The project migration engine (P4b2, [project routes](project-routes.md#project-state-migration-engine))
moves task worktrees with their directory, runs `git worktree repair` for them, and rewrites
only `workspace.path` in this project's owned-workspace receipts and cleanup checkpoints
(`delegation/workspace.ts` exports the checked receipt-file readers it uses). The admin
directory, its identity marker and the branch identity do not change, so ownership checks
still pass at the new path.

## Rules

One worktree per task at `.ai/cezar/worktrees/<runId>`, branch `cez/<id8>` off the configured base branch. Helpers never throw (except `createWorktree`) — degradation is the caller's policy. Diffs are capped (`DIFF_CAP`). Orphaned worktrees are pruned at startup. **"Which ref anchors *this task's* diff" lives in exactly one place** — `resolveTaskDiffBase` (`git-diff-base.ts`): the merge-base against the **freshest** base ref (`origin/<base>` when the local branch is behind it — agents fetch, they never pull, and a stale local `main` is what turned an eight-line fix into `+59514 −12160`), and, when the agent checked another branch out into the worktree, that branch **as the run found it** (`<branch>@{<run start>}`), whichever of the two attributes fewer changed lines. Attributing a checked-out branch's history to this task is what produced five-figure numbers on review and QA runs (open-mercato/cezar#591 fixed the Changes tab, open-mercato/cezar#751 the stored `diffStat`); anchoring those runs at `HEAD` instead then reported `+0 −0` for work they really did commit. A new task-diff surface resolves through that helper and passes the run's `branch` **and** `startedAt`; `worktreeDiff`/`worktreeDiffStat` deliberately keep the whole-branch anchor and each carry a comment saying why.

**Autosave commits only on the task branch** (hearsay-tools/cezarion#1004): the turn-end and run-finalize flushes and the periodic timer go through `WorktreeAutosave.saveWorktree`, which hands `autosaveCommit` the run's recorded `branch`; when the agent checked another branch out (or detached HEAD), nothing is committed and an autosave record in the run store (`RunRecord.handoffRecords`, shown in the handoff's Squawk-owned records block, so the agent's Progress log stays its own) plus a cockpit note name the branch and the uncommitted path count. A turn-end or run-finalize commit is reported the same way, with the `git reset --soft <sha>~1` that folds it into the agent's own commits while it is still HEAD; the timer's commits go to the records only, as one merged `periodic:` record per run of consecutive periodic commits on one branch (`recordHandoffPeriodicAutosave`), since a clean closing flush reports nothing. A change to how `autosaveCommit` writes must state its guarantee against the agent's concurrent checkout, merge, cherry-pick, revert and commit in the `autosaveCommit` comment that starts "The save is not atomic", the only list of what the save guarantees today and which races it accepts (hearsay-tools/cezarion#1111). The pre-PR flush names no branch and commits on whatever HEAD is. Worktree creation itself installs nothing (AGENTS.md § Validation gives the install step); a project's optional `worktreeSetup` commands (`packages/cezar/src/worktree-setup.ts`, hearsay-tools/cezarion#917, spec `.ai/specs/2026-10-07-worktree-setup.md`) run after creation and before the first agent turn, from `RunManager.execute` (tasks and workers) and `runContinuation` (a reclaimed worktree rebuilt on Continue), with the durable `RunRecord.worktreeSetup` that restart recovery reads.

**A cockpit route reaches a run's worktree only through the run checkout module** (`server/run-checkout.ts`, [ADR 0062](../adr/0062-one-module-decides-run-checkout-access.md)): it picks the directory and the guards for each checkout intent, and the module removes nothing: run worktrees leave through `releaseThenRemoveWorktree`, owned worker workspaces through `releaseThenRemoveOwnedWorkspace` (delegation cleanup). Each route follows this rule once a slice of hearsay-tools/cezarion#3158 has migrated it. Until then the route keeps its own handler checks, and a change to it follows its Table A row in the [run checkout spec](../../.ai/specs/2026-11-10-run-checkout-module.md#table-a-each-route-and-its-checks-in-todays-order).

**Tools whose reports name a commit must resolve it once, then route every subsequent git call through one pinned helper**: pass `--attr-source=<sha>`, use a private index populated from that commit for index-based operations, and pass `--no-textconv` for raw-content reads. Require a PATH-shim call-log test that fails if any call after resolution bypasses the pin; see `.github/scripts/upstream-scan.cjs` (`pinnedGit`) and `.github/scripts/upstream-targets.test.cjs`.
