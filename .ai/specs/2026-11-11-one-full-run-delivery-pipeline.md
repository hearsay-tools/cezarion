# Delivery pipeline: one full run, in the merge queue

Status: **draft**. The owner chose this direction on 2026-11-11, in place of the
post-merge verification design of hearsay-tools/cezarion#3217 (epic
hearsay-tools/cezarion#3208). Implementation follows in separate issues (§ Phases).

## Goal

A successful change reaches `main` in about 15 to 20 minutes after the PR opens. Every
merged commit still passes the full suite first, so a merged change cannot make `main` red
through a test.

| Target | Today (median) | This plan (estimate) |
| --- | --- | --- |
| Agent says the code is done → PR open | 51 min | 3 to 5 min |
| PR open → merged, clean PR that merges without the owner | 69 min (all PRs) | 15 to 20 min |
| `main` red because of a merged test failure | rare: 4 of 402 `main` push runs red after the queue started (2026-11-01) | not possible by design |
| Release | weaker checks than a PR | the release design of hearsay-tools/cezarion#3212, unchanged |

The design runs the full suite once per change, in the merge queue, and makes that run
fast. Before the queue, it runs only fast checks. It removes the waits between the steps.

## Evidence

The numbers come from the measurement for hearsay-tools/cezarion#3217 (2026-11-10: 320
merged PRs, the Actions jobs API, 28 Cezar tasks that opened a PR, 460 reviewer runs). The
method is in the owner's shared notes (`projects/cezar/pipeline-timing-baseline.md`).

| Cost today | Measured | What removes it here |
| --- | --- | --- |
| Reviewer loop before the PR | 8 min median, 30 mean, 52 p90 | One round beside the push (§ Review) |
| Squeal waits; local checks that CI repeats | single waits up to 10 min | `npm run prepr` with a 2-minute bound (§ Before the PR) |
| PR CI run | 16.5 min, restarted by each new push; 45% of PRs get more pushes | Selected tests on the PR (§ Pull request check) |
| Ready → queue | 2 min median, 55 min p90: draft round trip, a 180 s settle window, an agent turn | PR stays ready; auto-merge armed after the review (§ Merge) |
| Queue run | 17 min on 4 Vitest + 4 browser shards | 8 + 8 shards (§ Queue) |
| Failed queue run | delays its PR by a median of 62 min; 34 of 42 failed entries passed again with no new commit | One rerun of the failed files inside the run (§ Queue) |

Two facts decide the shape:

- **Test selection.** On 186 PRs with no guarded path, the selector picked tests for 98,
  skipped 14 docs-only PRs and fell back to the full suite for 74 (feasibility report for
  hearsay-tools/cezarion#3217). Here a selection miss only fails a queue run, so the
  selection needs no shadow week.
- **The queue is serial.** `merge-queue-admission.cjs` admits build concurrency 1 or 2
  and a merge count of 1. If entries took different times, short entries would wait behind
  long ones. Here every entry runs the same full suite.

## Owner decisions

| # | Decision | Answer |
| --- | --- | --- |
| M1 | Where the full suite runs | Once, in the merge queue, for every PR. Not on `main` after the merge |
| M2 | Which PRs merge without the owner | Today's auto-merge rules (`.ai/skills/auto-merge/`). D4 of hearsay-tools/cezarion#3217 is a separate decision, and this plan does not depend on it |

## Plan

### Before the PR (3 to 5 minutes)

1. One command, `npm run prepr`, prints one verdict and the evidence block for the PR body.
   It reads Squeal's results for the changed files and for lint. It runs only what Squeal
   does not cover: typecheck, citations and clones.
2. The Squeal wait bound in this command is 2 minutes. When the bound expires with no
   failure, the command names the missing results and passes. CI runs them within minutes.
3. Local `test:parity`, local browser specs and local coverage collection leave the list of
   duties. CI runs them.
4. The changed-function quality check (`.ai/skills/check-code-quality/`) runs beside the
   push, like the reviewer, until hearsay-tools/squeal#190 lets it reuse imported coverage.
   Its findings follow the rules of § Review.
5. The agent opens the PR ready, not draft.

Regression proof (`docs/sdlc/regression-proof.md`) stays. It is part of writing the test.

### Review

1. The agent starts one reviewer round on the committed head and pushes without waiting
   for it.
2. A finding scored 5 or more: the agent fixes it and pushes. One narrow reviewer run checks
   only the fix. Findings scored 4 or lower do not block; the PR body lists them.
3. A change that matches a never-list path or content rule of
   `.ai/skills/auto-merge/check.mjs` keeps today's loop: a fresh round until one reports no
   active finding, at most 5 rounds, then the owner decides.
4. CodeRabbit stays as it is: the `Automated Code Review` check requires its admission and
   resolved threads on every PR.

The rule text lives in the owner's Cezar prompt, outside this repository (§ Owner actions).

### Pull request check (about 4 minutes; about 10 on a full fallback)

1. Lint, typecheck and build run as today.
2. Vitest runs the files that `scripts/test-changed.mjs` selects against the PR base. A
   change to shared inputs, configuration or an unknown path selects the full suite, as
   the script does today. A source change for which the selection finds no test also runs
   the full suite; the script exits with an error in that case today, and phase 2 changes
   that for CI.
3. Browser specs run the files that `scripts/e2e-affected.mjs` selects.
4. A full fallback runs on 8 Vitest and 8 browser shards.
5. Docs-only and infra-only changes keep today's skips.

The queue no longer reuses PR suites (§ Merge queue and exact-commit reuse in
`docs/sdlc/ci.md`), because a PR run with selected tests is not a full run.

### Merge

1. `pr-readiness.yml` no longer returns a PR to draft. It keeps the board in sync from the
   check and thread state. A PR that opens ready has no `ready_for_review` event, so queue
   admission uses current-head CodeRabbit admission without the 180 s window, as it does
   today for such PRs.
2. For a PR that qualifies for auto-merge, the agent arms `gh pr merge --auto --squash`
   once the review round has no blocking finding. GitHub enqueues the PR when the required
   checks pass. Other PRs wait for the owner, as today.

### Queue (about 10 minutes)

1. Every entry runs today's queue verification on the combined commit, with the full
   Vitest and browser suites on 8 + 8 shards.
2. A shard whose tests fail runs its failed test files once more, in the same job. A pass
   on the rerun passes the shard and files a flake issue with the test names, one per test
   file, keyed so a repeat updates it. A second failure fails the entry, as today.
3. The shards keep recording Squeal shared results under `squeal ci record`
   (`docs/sdlc/ci.md` § Squeal shared results). The rerun runs under `squeal ci record`
   too, into the same parts, so the export records the final result of each file. The
   export's shard pattern, its condition and `.github/scripts/ci-squeal-results.workflow.test.cjs`
   change with the shard count.
4. A merged commit with no `refs/squeal/<sha>` within 30 minutes gets a warning in the
   `main` push run summary. Publication stays outside the required checks.

### `main`

`main` can still go red without a merged test failure: the calendar, the environment, or
a gap in the queue proof. The failure reporter and the repair automation handle it, as
today. One addition: a scheduled check mentions the owner on an open `main-ci-failure`
summary 60 minutes after it opened. A revert would not repair these causes, so there is no
revert bot.

### Release

The release design of hearsay-tools/cezarion#3212 stays: a release candidate on `next`,
tests of the published candidate, promotion to `latest`, rollback by a patch release, and
nightly as the rehearsal. One change: its candidate is the newest commit on `main` whose
`ci.yml` push run passed, because no `main-verify` status exists in this plan.

### Coverage

A Vitest run takes one coverage provider. Today the PR shards collect V8 coverage, and
the queue shards collect Squeal's per-file records. Until hearsay-tools/squeal#189 lands,
this stays as it is: PR runs keep `--coverage.enabled` over the selected tests, which are
the tests that the changed-function check needs. When it lands, every CI Vitest run uses
`squeal ci record` with one provider that writes both outputs.

### Records that a later run reads

| Record | Writer | Reader | Absent or unreadable |
| --- | --- | --- | --- |
| Flake issue per test file | The queue rerun step | The repair automation; the owner | The step fails visibly; the entry's verdict does not change |
| `refs/squeal/<sha>` | `squeal-publish` | Developers' Squeal daemons | The daemon imports the nearest older ref; the push run warns |
| Open `main-ci-failure` summary | The failure reporter | The 60-minute check | No mention; the repair automation still runs |

### Guarantees that change

| Mechanism today | After |
| --- | --- |
| Full suites on every PR head | Selected tests on the PR. The full suite runs on the combined commit in the queue |
| Queue reuse of PR suites | Removed. Every queue entry runs the full suites |
| Failed queue entry needs a requeue | One rerun of the failed files inside the run; flakes become issues |
| Draft until checks pass | PRs stay ready. The board follows check and thread state |
| Reviewer loop until clean before the PR | One round beside the push, plus a fix check. Never-list paths keep the loop, capped at 5 |

## Phases

Each row becomes one issue.

| Phase | Content | Size | Needs |
| --- | --- | --- | --- |
| 1 | Local gate (`npm run prepr`, 2-minute bound, shorter duties; scope of hearsay-tools/cezarion#3216 without the lane); PR stays ready; auto-merge armed after the review; queue rerun of failed files with flake issues and Squeal recording | days | Owner action 1 |
| 2 | Selected tests on the PR; 8 + 8 shards for the queue and the full fallback; no queue reuse of PR suites; Squeal shard pattern and test; the 60-minute mention; the Squeal ref warning | about 1 week | |
| 3 | Release: hearsay-tools/cezarion#3212 with the candidate rule of § Release | as specified there | Owner actions of that issue |
| 4 | Optional: verification after the merge (hearsay-tools/cezarion#3209 to hearsay-tools/cezarion#3211), only if phase 2 data shows the queue is still the slowest step | | A change to this spec |

Of the issues filed for hearsay-tools/cezarion#3217, hearsay-tools/cezarion#3216 and
hearsay-tools/cezarion#3212 carry over with the changes above; hearsay-tools/cezarion#3215
carries over without its shadow-week gate. hearsay-tools/cezarion#3209,
hearsay-tools/cezarion#3210, hearsay-tools/cezarion#3211, hearsay-tools/cezarion#3213 and
hearsay-tools/cezarion#3214 wait for phase 4.

## Owner actions

1. Replace the "Pre-PR review" rule in the Cezar prompt with: run one reviewer round on the
   committed head, beside the push; fix findings scored 5 or more, then run one reviewer on
   the fix only; on a change that matches a never-list rule of the auto-merge check, repeat
   with a fresh reviewer until a round reports no active finding, at most 5 rounds.

## Limits

- Every "after" time is an estimate from measured job times. No run has shown them.
- The 8 + 8 time is an estimate. Per-shard setup (install, server build) does not shrink.
- CodeRabbit sets the PR stage: one check takes 8.2 min. A PR with threads pays a fix push
  and a second check.
- The queue builds at most 2 entries and merges 1. At about 10 minutes an entry, it merges
  about 12 PRs an hour. 46 PRs a day fit; at peaks, entries wait for each other.
- The 15 to 20 minutes apply to PRs that merge without the owner: 34% of the last 330 PRs
  under today's rules. Other PRs wait for the owner.
- `main` red from the calendar or the environment has no automatic repair.
- The shares come from one week of PRs, which included large migration work.
