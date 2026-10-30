---
name: cleanup-campaign
description: Campaign over many issues of one kind that must keep behavior. Confirms each issue is behavior-neutral, then runs them in waves of governed workers to merged PRs. Use when asked to work on all issues with a label or of one type (code quality, complexity, refactors, flaky tests), on every open sub-issue of an epic or phase, or on a list of issues in waves.
---

# Cleanup campaign

A campaign takes a set of behavior-neutral issues to merged pull requests. You
are the coordinator. Workers change the code; you plan the slots, review each
commit, merge on the gate and tear down each worker. You write no product code.

**Behavior-neutral** means every existing test keeps its expected outcome and no
user sees a difference: a refactor, a move, a complexity split, a test-only fix
for a flaky test. A behavior question that a worker finds becomes its own issue,
linked from the campaign issue or epic; the campaign PR keeps the old behavior.

Pick the mode from the prompt:

- **Batch mode:** the prompt names a label or a list of issues. Run the loop
  below once, until the queue is empty.
- **Epic mode:** the prompt names an epic with phases. Read
  [references/epic-mode.md](references/epic-mode.md) first. You are the planner
  there, and each phase runs this loop in its own coordinator task.

## Controls

Read each control from the prompt. When the prompt is silent, use the default.

| Control | Default | Why |
|---|---|---|
| Issue source | Required: a label, a list, or an epic phase | |
| Worker model | Codex `gpt-6.1-sol-fast`, after a fresh `discover models` | In epic 2051 Phase 4, sol-fast finished 9 of 9; terra-fast handed back 3 of 7 starts before any change |
| Live workers | 4 | Load on this host; six independent workers also worked (12afbac2) |
| Hot-file cap | 2 open PRs per hot file, and the second PR opens after the first merges | Each conflicting pair cost a rebase and a second full CI run |
| Merge | You merge on the gate | If the prompt says the owner merges, stop at a gate-passing PR and ask |

A **hot file** is a file that two or more queued issues edit. A PR that the
auto-merge check flags as "gate or test harness", or that edits `AGENTS.md`,
needs the owner's approval before you merge it, even inside a campaign.

## State

Keep the campaign in `.ai/qa/campaign/state.json` in your worktree (git-ignored).
Per issue: number, kind, region (file and line ranges on a named main SHA),
order gate, status, worker id, model, PR, reviewed head, merge SHA and the metric
before and after. Also keep the friction lines and the behavior questions. Write
it at every transition, and point to it from the handoff's resume notes. On a
resume, read it before anything else.

## Steps

### 1. Inventory and confirm

List the issues. For each one, read the body and the comments, and list the open
PRs that touch its files (`gh pr list`, then `gh pr diff <n> --name-only`).
Measure each target on current main:
`node .ai/skills/check-code-quality/scripts/metrics.mjs <file> --json`.

Then confirm that each issue is behavior-neutral. Read its done line and
acceptance criteria, and classify it:

- **Neutral:** it changes structure, tests or test waits only. Every expected
  test outcome, API shape, CLI output, UI and stored state stays the same.
- **Changes behavior:** some criterion changes one of those.
- **Unclear:** the issue does not say enough to decide.

Quote the line that decides each classification in `state.json`. When every
issue is neutral, continue. Otherwise, show the owner each issue that changes
behavior or is unclear, with its deciding line, and ask with `cezar_ask` which
of them stay in the campaign. In a task an automation started, nobody answers:
leave them out and list them in the final message.

Done when every issue in the campaign is confirmed neutral and has its target
measured at a named main SHA. Each other issue is left out with its reason, is
closed with evidence that main already fixed it, or carries a named blocker.

### 2. Map regions

Record the file and line ranges that each issue will change, on current main.
Then order the slots:

- Different files run in parallel.
- Two issues in one file run in parallel when their hunks are 40 or more lines
  apart. Measure the spans; method names alone mislead.
- A change with many call sites pairs only with a change local to one module.
- Shared pins (the `file-length.baseline.json` line, an import block) always
  conflict. They are rebase work, not overlap.
- An order gate that an issue or the epic names comes first.

Done when every issue has a region and a place in the slot order in
`state.json`. Post the plan in one short message and continue; wait for approval
only when the prompt asks for it.

### 3. Spawn

For each free slot:

1. Move the issue to In progress and assign it, as the Board binding in
   `AGENTS.md` says.
2. Bring your worktree to `origin/main` (`git merge --ff-only origin/main`), so
   `--baseline parent-head` is fresh main.
3. Write the brief: the per-issue facts (regions, callers, the seams to keep,
   the order gate), then the text of
   [references/worker-brief.md](references/worker-brief.md) with its
   placeholders filled.
4. Spawn with `cez worker spawn --baseline parent-head --request-id <UUID>
   --context-file <brief> 'Work hearsay-tools/cezarion#<N> as the brief says.'`
   and the control's runner and model. Keep the brief under `.ai/qa/campaign/`.
   Start workers one minute apart: Codex returned 429 to a burst of starts.
5. Register a worker wait that covers every live worker.

Done when the worker is accepted, its id is in `state.json`, and a wait covers
it.

Send a correction to a running worker as `cez message request`, and only when it
is needed: a steer that lands at turn end is not acted on, and live input made
running Codex workers fail with HTTP 400. A settled worker needs
`cez worker resume`; a message does not wake it.

### 4. Review each commit

The worker splits its change into 2–3 commits and sends a progress message
after each. Read every commit as it lands, with
[references/review.md § Commit review](references/review.md#commit-review).
Answer a scope question with
[§ Standard answers](references/review.md#standard-answers), or decide it
yourself when it is behavior-neutral.

Done when every commit is read and each finding is sent as one request.

### 5. Merge gate

When the worker reports a draft PR with green checks, run
[references/review.md § Merge gate](references/review.md#merge-gate) on its
exact head. Then:

```bash
gh pr merge <P> --squash --match-head-commit <H>
```

Keep the PR title as the squash subject. `pr-readiness.yml` owns draft state
and marks the PR ready when its checks pass.

Done when the PR is merged at the reviewed head and its issue shows closed.

### 6. Teardown and refill

1. Record the metric on main (lines, bytes or complexity) in `state.json`.
2. Run `git merge-tree origin/main <head>` for the other open PR in the same
   hot file. Tell its worker to rebase only when it conflicts.
3. Tell this worker to finish. Wait until it shows settled, collect its latest
   revision, then tear it down with
   [references/teardown.md](references/teardown.md).
4. Spawn the next issue for the freed slot (step 3).

Done when `cez worker list` shows the worker destroyed and the slot holds the
next issue, or the queue is empty.

### 7. Close the campaign

Done when all of these hold:

- Every issue is closed, or carried with a reason in the final message.
- Every worker is collected and destroyed.
- The friction lines are deduplicated against open issues and posted to the
  friction inbox ([docs/sdlc/friction.md § Friction inbox](../../../docs/sdlc/friction.md#friction-inbox)).
- Every behavior question is its own issue.
- The final message lists the merged PRs, the metric before and after, what was
  carried, and the behavior issues filed. In epic mode, it goes to the planner
  as `cez message progress` too.

Then call `cezar_done`.

## Stop rules

- **Main CI is red:** hold every merge. Find the repair task (`cez message tasks`;
  its title starts with the issue number and "repairing main ci"), message it,
  and wait for its PR. Repair stays with that task. A main run that fails only in
  "Publish npm snapshot" is not a code failure.
- **A PR check is red:** read the log first. Call it a flake only with a
  tracking issue; rerun the failed jobs once. A second failure goes back to the
  worker or into an issue.
- **A product decision:** ask the owner in batch mode; message the planner in
  epic mode. Decide every behavior-neutral choice yourself.
- **An owner pause:** park the workers on CI waits, stop Squeal with
  `squeal stop --until-start`, and spawn and merge nothing until the owner
  resumes.
