# Task completion controls

Tasks and automation templates have two optional switches. Both default to off.
`cez task start` and `cez automation add` accept `--archive-when-done` and
`--auto-merge-pr`. JSON uses `archiveWhenDone` and `autoMergePr` on the task.
Automation edits affect future tasks and every variant. Existing tasks keep their choices.

Archive when Done files a task after it reaches Done. Auto-merge PR asks GitHub to
merge only PRs created by that task on its owned branch. It verifies repository,
branch and commit identity. It may mark that PR ready for review. It requires at
least one CI check, every check passing on the current head, and GitHub's review,
permission and branch requirements. It uses a permitted repository merge method
and never overrides rules. Review, Failed and Cancelled do not trigger these actions.

With both switches on, merging comes first. Archiving follows confirmed success.
A task with no PR archives on Done. A referenced PR or unresolved ownership keeps
the task visible with a reason. Turning off Auto-merge PR invalidates pending
merge work. A GitHub mutation already accepted cannot be retracted; filing still
rechecks the task's current choices before it commits.

Completion and its intent share a database transaction. Archive-only completion
can file in that transaction. Merge work uses a durable action ID. It resumes
after restart without an agent session or browser. A merged PR reconciles a lost
merge response without repeating the mutation. Polling visits at most four
projects and four tasks per project per tick. Blocked work backs off to five
minutes. A keyset cursor prevents a blocked task from holding the queue.

## One archive operation

Manual Archive, Archive when Done, and archive after merged PRs use the same
atomic task-family write. They retain worktrees, branch refs, history and live
processes. Process termination, worktree removal and history deletion remain
separate operations with their own safety checks. A leftover QA process does not
prevent filing.

Automatic filing requires settled task work, settled worker execution, valid
ownership, and no unanswered question or permission request. Archive when Done
uses the Done settlement as its trigger. The existing archive-on-merge preference
uses terminal task status and complete repository-qualified PR merge evidence.
Its immutable merge facts include actual merge times. Missing or invalid PRs,
including worker PRs, keep the whole family visible. The task header shows the
reason, a link to the affected task or PR, and a manual Archive action.

Manual Archive is an explicit override of completion, pending-input and merge
prerequisites. It does not answer questions or stop work. It still obeys store
ownership and write fences. Unarchive restores the family and cancels pending
completion actions. Unrelated writes and restart do not file it again. Continue
restores the task; a later Done can trigger its enabled completion controls.
Archive-on-merge also retains its merge fingerprint and manual-restore cutoff,
so an old merge cannot undo a manual restore.

See [merge observations](../sdlc/merge-observations.md) for authoritative evidence
and its consumers.

## Transitions out

| State | Trigger | Who or what fires it | Behavior at shipped defaults |
| --- | --- | --- | --- |
| Queued / Running / Waiting | Existing execution, input and wait transitions | Run manager and scheduler | Unchanged; both controls are off |
| Review | Accept or Continue | User | Existing human review gate; neither action runs |
| Failed / Cancelled | Continue | User | No automatic completion action |
| Done, no action | Continue or enable a completion control | User | Remains visible; controls are off |
| Done, pending action | Verified merge, no-PR completion, or blocker | Background coordinator | Entered only by an explicit opt-in |
| Done, blocked action | Retry, disable, manual Archive, or Continue | Bounded coordinator or user | Opt-in work retries; reason stays visible |
| Done, completed action | Continue, manual Archive, or Unarchive | User | Does not rearm on unrelated writes or restart |
| Archived | Unarchive or Continue | User | No automatic exit; history and work remain recoverable |
