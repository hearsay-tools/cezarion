# Release a patch hold

The coordinator owns PR-opening release. Planned files and line distance predict
work; they do not prove a ready branch conflicts. The old per-file cap protected
against patch collisions by serializing PRs. This check replaces that default
with actual patch evidence while preserving semantic dependencies, worker-slot
limits and every review, QA and land-pr gate. Release permits opening a ready
PR, never merging it.

## Capture complete evidence

On every worker's ready request, fetch origin/main and record its full SHA
as `base`. Capture the candidate's committed head and every other outstanding
campaign branch/PR head whose work could interact. Include branches not yet
released, not just the original blocker. Require each worker's confirmation
that its patch is complete, its worktree clean and its readiness evidence
current. Predicted hot files are estimates, never a condition for checking:
older briefs with a `none` gate still require coordinator release. A partial diff, missing branch, dirty tree or missing confirmation
cannot clear a hold. Record the owner, next action and matching worker/request,
PR or human wake; unrelated eligible work can continue.

Recheck semantic prerequisites and shared resources from the schedule: imports,
contracts, pins, stored state and side-effect order. Disjoint files or a clean
rebase do not prove semantic independence. Keep a semantic hold until its named
release condition passes, even if there is no patch overlap.

## Compare actual patches

1. For each captured head, inspect its complete branch delta with
   `git diff --no-relative --name-status -z --no-renames <merge-base> <head>`, where
   `<merge-base>` is `git merge-base <base> <head>`. Treat paths as NUL-delimited
   data, not shell words or newline-delimited names. Confirm Git commands
   succeeded; empty output from a failed command is not an empty patch.
2. The early disjoint-path shortcut is valid only when both merge-bases equal
   `base`: both branches already contain the captured current main. Otherwise
   a main-side rename can map an old path onto a peer's new path; the original
   path sets do not prove independence. Renames appear as deletion plus addition
   with `--no-renames`, so both paths participate. Paths overlap if equal or if
   one is an ancestor of the other at a `/` component boundary: `widget` and
   `widget/index.ts` overlap, while `widget` and `widgets.ts` do not. Apply this
   rule to original and normalized path sets; a file/directory collision cannot
   receive automatic disjoint-path release.
3. For any pair not cleared by that shortcut, normalize both complete patches
   onto the same current-main base before deciding even path independence. Make disposable local clones outside worker worktrees, with no checkout
   hooks, and import the captured commits from the local repository. Check out
   each head detached and trial-rebase its branch-only commits onto `base`
   (`git rebase --onto <base> <merge-base>`, with hooks disabled). Never rebase a
   live worker's branch yourself. A conflict, missing object, uncertain merge
   history or failed comparison retains the hold; preserve the worker's original
   branch and record the failure before removing only the disposable copies.
4. In each successful trial, inspect
   `git diff --no-relative --no-ext-diff --no-textconv --no-renames --unified=0 <base> <trial-head>`.
   Use the **old-side** hunk coordinates: both diffs now describe the same base.
   Recompute the NUL-delimited changed path sets against `base` using the trial
   heads and the same `--no-relative --name-status -z --no-renames` flags. Check
   ancestor/descendant collisions as well as equal paths. Only these normalized
   paths can clear a previously stale pair as
   disjoint. Preserve both the original and normalized path evidence.
   Check name/status as well. Shared creation/deletion, rename-related paths,
   binary changes, mode/type changes or other whole-file operations require
   explicit resolution; do not automatically clear them from text hunks. Track
   rename-related paths from the original patch too. If trial rebasing changes
   scope or loses intended work, return to the worker for repair.
5. Compare every candidate pair in the relevant outstanding set. For a hunk
   `@@ -s,n +... @@`, an omitted count means `1` on either side: for example,
   `@@ -10 +10 @@` consumes one base line and adds one line. Explicit counts
   keep their value. `n > 0` consumes base lines `[s, s+n-1]`; `n = 0` inserts
   at the gap after base line `s` (0 is before the first line). Consumed intervals
   intersecting each other conflict. Equal insertion anchors conflict. An anchor
   in `[s-1, s+n-1]` conflicts with that consumed interval, including both edit
   boundaries. Unclear mappings stay held. Different hunks less than 40 lines
   apart can clear when these ranges/anchors and semantic checks are disjoint.

## Preserve progress when patches overlap

Do not turn pairwise overlap into mutual holds. Use the schedule's existing
topological slot order to name a predecessor among otherwise eligible ready
branches; record the choice before replying. An already released/open PR keeps
precedence. If neither is released, the earlier eligible item may open its PR
while the later item keeps the patch hold. This clears only the predecessor's
patch hold: its own semantic prerequisites, complete evidence, review and other
gates must still pass. Record a directed predecessor-to-successor edge for each
overlap; a successor waits for all its overlapping predecessors to merge and
pass integrated acceptance, then reruns the check on current main. Disjoint
branches need no such edge. A missing or unfinished peer cannot be used to infer
non-overlap or manufacture a new release; keep its unresolved hold and use the
recorded schedule to identify the prerequisite owner. A semantic cycle returns
to planning; never choose precedence that bypasses a semantic prerequisite.

The coordinator owns releasing each predecessor, so the first overlapping PR
can reach landing. Reconcile existing PRs and saved edges before resuming;
never reverse precedence while its predecessor PR remains outstanding.

Trial rebases are comparison evidence, not reviewed replacement heads. If a live
branch needs rebasing before PR opening or landing, request it from its owner.
A settled worker requires explicit resume. Its new head needs fresh review,
affected verification and this release check before release; use the worker
brief's existing push rules. A release without a live rebase remains tied to the
captured original heads and the trial evidence.

## Record and reply

Save the base, original and trial heads, compared paths/hunks, semantic checks,
readiness evidence and decision in the existing campaign ledger. Immediately
before replying, fetch main and query current worker/PR heads and readiness
again. Changed base, head, plan or readiness invalidates the evidence: recheck,
do not send the stale release. Reply explicitly with the authorized candidate
head, base and evidence; the worker rechecks these identities before PR opening
and requests a new release if they changed. Retain superseded evidence as history.
On coordinator restart, reconcile live facts and recompute before reusing a saved
release. Older ledger entries without comparison evidence remain unverified.

## Cases

| Complete patches on the same base | Patch decision (semantic checks still apply) |
|---|---|
| No equal or ancestor/descendant changed path on current main | Release |
| One patch adds file `widget`, another adds `widget/index.ts` | Hold for explicit file/directory collision resolution |
| Original paths disjoint but either branch predates main | Normalize first; a main-side rename may make them overlap |
| Same short file: replace line 10 vs line 20 | Release; no distance threshold |
| Both consume line 10 | Release the eligible predecessor; hold its successor |
| Both insert after line 10 | Release the eligible predecessor; hold its successor |
| Insert after line 9 or 10 vs consume line 10 | Order predecessor/successor; edit boundary |
| Insert after line 11 vs consume line 10 | Release |
| Main deleted earlier lines | Use rebased old-side coordinates, never pre-rebase line numbers |
| Shared binary, rename, file deletion or mode change | Hold for explicit resolution |
| Clean rebase but shared contract changes | Hold for semantic prerequisite |
| Missing/unfinished branch, rebase conflict, stale head/base | Hold with owner and next action |

## Transitions out

| Situation | Exit trigger and owner | Recovery with no live session |
|---|---|---|
| Missing complete evidence | Worker supplies committed patch and readiness | Collect saved result; explicitly resume worker for gaps; restore wait |
| Patch overlap | Coordinator releases the eligible predecessor; successors wait for predecessor merge and integrated acceptance | Reconcile existing PRs and directed order; recompute on current main |
| Semantic hold | Prerequisite passes its release condition, or approved scope changes | Reconcile main/GitHub and ledger, then recompute |
| Comparison/rebase failure | Named owner resolves missing evidence or worker resolves conflict | Keep original branch and reason; resume settled worker for repair |
| Independent patches held | Coordinator records evidence and replies with release | Recompute current identities before sending or reusing reply |
| Released evidence changes | Coordinator/worker invalidates release and returns to review/check | Reconcile heads, base and readiness; do not reuse stale approval |
| Deletion-chain successor queued | Predecessor merges and integrated acceptance passes | Verify both recorded facts against live main before dispatch |

These are campaign coordination states, not new runtime run states. No daemon,
new configuration or store is required. Work is bounded by the existing live
worker limit and the ready branches being compared. Nothing enables automation
or widens merge authority.
