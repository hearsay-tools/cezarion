---
name: campaign
description: Orchestrate a set of issues or a phased epic with governed Cezar workers. Use for cleanup waves, feature delivery across dependent issues, or a whole epic through integrated acceptance.
---

# Campaign

Coordinate approved work through integrated acceptance. Workers implement;
you own dependencies, slots, scope review, phase evidence and worker cleanup.
Use the repo's planning skills for unresolved design and
[land-pr](../land-pr/SKILL.md) for PR landing.

Pick the mode from the prompt:

- **Batch:** a label, issue list or one epic phase. Run the loop below.
- **Epic:** the whole epic across phases. First read
  [epic mode](references/epic-mode.md); each phase has its own coordinator.

Pick a work type per issue. Cleanup preserves existing behavior; feature work
delivers approved behavior, including bug fixes. Mixed campaigns use both
paths. Read only the selected type's references at the step that needs them.

## Controls and state

Use the prompt's controls, with these defaults:

| Control | Default |
|---|---|
| Source | Required: a label, issue list or epic |
| Worker | Codex `gpt-6.1-sol-fast`; confirm with runner and model discovery before spawning |
| Live workers | 4; start one minute apart to avoid startup rate limits |
| Hot file | At most two assigned workers; the second opens its PR after the first merges |
| Integration | Independent PRs into `main`, as the repo's branching binding requires |
| Merge | Owner merges; coordinator merges only with explicit permission |

A **hot file** is edited by two or more queued issues. File distance estimates
patch conflicts; shared contracts, stored state and side-effect order determine
whether work is independent. Plans that require stacked PRs or a shared
integration branch return to planning for independently landable slices.

Keep `.ai/qa/campaign/state.json` in this worktree and link it from the handoff.
Read [state](references/state.md) before inventory and on every resume. Record
each transition there, including the plan revision, worker baseline, reviewed
head, landing result and acceptance evidence. Reconcile it against Cezar, Git
and GitHub before resuming work.

## 1. Admit work

Fetch `origin` and fast-forward this coordinator to `origin/main`; record its
SHA. Read each issue's body, comments, plan and open PRs touching its scope.
Classify each issue from a quoted acceptance criterion:

- **Cleanup:** confirm the behavior-neutral contract and measure the named
  target with [cleanup delivery](references/cleanup-worker-brief.md).
- **Feature:** use [feature delivery](references/feature-delivery.md) to check
  the approved plan, preserved guarantees and acceptance evidence.
- **Unclear:** ask the owner to resolve scope. An unattended automation leaves
  it out and reports why; it grants no product authority.

Approve each item's technical dispatch facts yourself within the approved
scope. A product change goes to the owner, through the epic planner when
present. The planner can relay an existing decision; a new product decision
still needs the owner.

Done when each admitted item has a current plan, work type, acceptance checks
and dependencies. Each other item has an exclusion reason or named blocker.

## 2. Schedule

Map expected file regions on the recorded main SHA. List semantic dependencies
and shared resources as well as patch overlap. For each dependency, name the
condition that releases it: for example, a contract merged and its consumer
check passed on main. Topologically order the work; resolve cycles by changing
the approved slices before dispatch.

Different files can run together when they are semantically independent. In
one file, hunks at least 40 lines apart are candidates for parallel work, after
checking shared imports, pins and contracts. Pair a change with many call sites
only with work local to one module. Apply the hot-file control after these checks.

Done when every item has a region, prerequisite conditions and a slot order.
Post the plan and continue unless the prompt requires schedule approval.

## 3. Dispatch eligible items

For each free slot:

1. Confirm every prerequisite holds on current main. Claim the issue using the
   repo's board binding.
2. Fetch and fast-forward to main. When main or the plan changed, recheck scope,
   regions and prerequisite evidence against the open PRs. Record the new SHA.
3. Write the per-issue facts and the selected delivery brief under
   `.ai/qa/campaign/`: [cleanup](references/cleanup-worker-brief.md) or
   [feature](references/feature-delivery.md#worker-brief). Include the merge
   authority verbatim, the coordinator id, the expected evidence and any
   PR-opening gate for a hot file.
4. Use `cez worker spawn --baseline parent-head --request-id <UUID>
   --context-file <brief> '<task>'` with the discovered runner/model. Reuse the
   request id only for an exact retry.
5. Record the accepted worker id and register a wait covering every live worker.

Done when the accepted worker and its baseline are recorded and a wait covers
it. A request to a live worker needs an explicit reply when a decision depends
on it. A settled worker needs `cez worker resume`; a message alone cannot wake it.

## 4. Review and resolve

Read every commit as it lands. Apply
[cleanup review](references/cleanup-review.md) or
[feature review](references/feature-delivery.md#review), plus the cross-issue
contracts from the schedule. Send findings for one commit as one request.
Record the reviewed SHA and the evidence for each acceptance criterion.

If a worker settles before producing the required evidence, collect its latest
result and record the gap. Resume it for repair or assign a replacement with
the preserved work; a partial result does not advance to landing.

Answer technical questions within the approved scope. Route product decisions
to the owner. A scope change invalidates the affected plan, reviews and
dependent dispatch conditions; pause affected items, update the plan and
recheck them before resuming. Independent work can continue.

Done when every commit is read and all required findings and scope decisions
are resolved at the current head. Green CI alone is not scope acceptance.

## 5. Land and accept

Invoke [land-pr](../land-pr/SKILL.md) with the PR, reviewed head, approved scope,
review evidence, dependencies and recorded merge authority. Follow its blocked
or waiting result; only its observed merge result counts as merged. A new head
returns to step 4 before another landing attempt.

After merge, fast-forward to main. Run or read the item's acceptance checks on
the integrated code; record the SHA, command and result, and cleanup metrics
where applicable. Recheck semantic dependencies and conflicts of remaining
PRs. Request a rebase only when required by a conflict or an invalidated contract.

Done when the merged item passes its acceptance checks on main. If it fails,
block its dependents and send the repair to its worker or a named repair task.
An issue closed by GitHub is not evidence that acceptance passed.

## 6. Release and refill

Once the landing outcome and evidence are saved, settle and collect the worker's
latest revision, preserve its artifacts, then follow
[teardown](references/teardown.md). A failed or abandoned item keeps its patch
and evidence before cleanup, with a named repair or explicit scope decision.
Refill from step 3 when capacity is available. Awaiting-owner PRs keep a durable
wait; do not consume new slots past the controls.

Done when each released worker is destroyed with no remaining resources and
the next eligible item is dispatched, or the queue has no eligible work.

## 7. Close

Check each phase exit against integrated main, including checks that span
several issues. Report merged PRs, acceptance evidence, cleanup metrics and
explicit exclusions. Required blocked work keeps the campaign incomplete;
route the blocker or scope decision instead of reporting success.

Done when every required item and phase exit is accepted, every exclusion
follows the prompt or admission rule, every worker is collected and destroyed,
and friction is deduplicated
and posted under [the friction inbox rules](../../../docs/sdlc/friction.md#friction-inbox).
Cleanup behavior questions become linked issues. Send the phase report to the
epic planner too. Update the handoff and call `cezar_done`.

## Holds

- **Main CI fails:** hold landing through land-pr. Find the repair task with
  `cez message tasks` (its title names the issue and "repairing main ci"). Keep
  repair with that task; if absent, establish one named repair owner. Report it
  and wait. land-pr owns which CI failures block landing.
- **PR check fails:** read its log. A flake needs a tracking issue; retry failed
  jobs once, then return a second failure to the worker or named repair issue.
- **No eligible work:** name the unmet prerequisite, pending decision or owner
  merge and register the matching wait. A dependency cycle returns to planning.
- **Owner pauses:** record state, park workers on their waits and stop Squeal
  with `squeal stop --until-start`. Spawn and land only after the owner resumes.
