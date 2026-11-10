# Delivery pipeline: fast lane, main verification and tested releases

Status: **approved** by the owner on 2026-11-10. Owner decisions recorded 2026-11-10.
Implementation follows in separate issues (§ Phases).

## Goal

A successful change reaches `main` in minutes, and a release ships only what was fully tested.

| Target | Today (median) | Target |
| --- | --- | --- |
| Agent says the code is done → PR open | 51 min | at most 5 min |
| PR open → merged, successful PR | 69 min | about 5 to 7 min |
| `main` red | no bound; 5 of 41 failure issues took over 12 h | detect in 20 min, green in 45 min, never over 12 h |
| Release | weaker checks than a PR; publishes straight to `latest` | at most one a day; the published package is tested before `latest` moves |

The design moves each check to the cheapest place that still protects what it protects.
A pull request no longer pays for release-grade verification twice. `main` may go red more
often than today, but for minutes, and a bot reverts the cause.

## Owner decisions

| # | Decision | Answer |
| --- | --- | --- |
| D1 | Where model review sits | One local reviewer round, beside CI. A finding scored 5 or more blocks. CodeRabbit reviews after the merge on the fast lane. The guarded lane keeps the full loop and both reviewers blocking |
| D2 | What runs before merge | Affected tests. The full suite runs on `main` in batches. A one-week shadow measurement comes first |
| D3 | Who reverts a confirmed failure on `main` | A bot opens and merges the revert. After 6 hours red it reverts to the last green commit |
| D4 | Which pull requests merge without the owner | Every fast-lane PR. The path and content rules decide the lane. The size limit and the `feat` rule go |
| D5 | How a stable release starts | The owner's dispatch, at most once in 24 hours. Nightly is the rehearsal. No scheduled release |

Raising the lane limits, or changing a clock in § Main verification, needs a change to this spec first.

## Evidence

Measured 2026-11-10. Sources: GraphQL timelines of 320 PRs merged 2026-11-03 to 2026-11-10;
the Actions jobs API for `ci.yml` runs; Cezar run logs of 28 tasks that opened a PR; the run
store for 460 reviewer runs. The method and the baseline numbers are recorded outside the
repository, in the owner's shared notes (`projects/cezar/pipeline-timing-baseline.md`).

### Time

| Segment | Median | Fastest 10% | Cause |
| --- | --- | --- | --- |
| First commit → PR open | 51 min | 11 min | 20 listed duties; the reviewer loop; Squeal waits of up to 10 min each; local checks that CI repeats |
| PR open → ready | 28 min | 16 min | One CI run takes 16.5 min. 45% of PRs get more commits; each push restarts the run |
| Ready → in queue | 2 min (p90 55) | under 1 min | A 180 s settle wait, then an agent turn enqueues the PR |
| In queue → merged | 17 min | 10 min | The queue runs the full suite again |
| PR open → merged | 69 min (p90 355) | 33 min | |

One CI run on a PR: preflight 1.6 min; then Vitest shards 10 to 13 min, browser shards 11 to
13 min, build and package 7.5 min, and the review job 6 to 11 min, all in parallel.

### What the slow gates caught

| Gate | Result |
| --- | --- |
| Full suite in the merge queue | 380 entries, 42 failed. 34 were queued again with no new commit. At most 8 (2%) led to a fix. A failed queue run delayed its PR by a median of 62 min |
| Queue reuse of PR results | Worked for 9 of 49 green queue runs |
| The queue as a whole | Red `main` push runs fell from 51 of 598 to 4 of 402 after 2026-11-01 |
| `main` push CI | 348 of the last 1,000 push runs were cancelled by a newer push, so those commits were never verified as themselves |
| Release | Runs no browser E2E, no packaged CLI E2E, no lint and no Node floor check. Does not read the state of `main`. Publishes to `latest` with no smoke test and no rollback procedure |
| Nightly | Covers less than PR CI. It was broken for 13 days in October before an issue existed |
| Red `main` | Repair depends on one local cockpit that polls every 300 s. No clock, no alert, no revert. Median 2.4 h to close a failure issue |

### Review value

Subagents classified samples by reading the code and the fix. A real defect is code that
behaves wrongly in a reachable case. Authors were told to fix every finding, so the
false-positive shares are lower bounds.

| | Local reviewer, before the PR | CodeRabbit, on the PR |
| --- | --- | --- |
| Population | 535 findings on 202 changes | 329 threads on 320 PRs |
| Sample | 250 | 200 |
| Real defect / nit / false positive | 66% / 10% / 1% | 37.5% / 31% / 3.5% |
| Medium or high defects, estimate for the population | 54, of them 6 high | about 7 |
| Changes with no finding | 44% | 63% |
| Time | 4.6 min per round; loop to clean 8 min median, 30 mean, 52 at p90 | 8.2 min per check |

- The reviewers do not repeat each other. PRs that left the local loop clean got CodeRabbit
  threads at the base rate (37%).
- Later local rounds do not converge. Findings per round stay near 1. Half of the findings
  after round 1 concern code written to fix an earlier finding. Round 1 holds 48% of the
  medium or high defects.
- The reviewer's score separates serious from small. Findings scored 4 or lower are 44% of
  all findings and held 1 of the 25 medium or high defects in the sample.
- Serious defects cluster. Home, migration, install and workflow paths gave 12 of the 25,
  with all 3 high ones and all 7 that a revert would not undo. Test-only and refactor changes
  gave none.

Replay of D1 on the 250 sampled findings: 62% of changes pass the first round with nothing
that blocks (44% today). 18 of the 25 medium or high defects are fixed before the merge,
with every high one and every one a revert would not undo. 7 medium defects reach `main`;
a revert undoes each.

### Lane share

`.ai/skills/auto-merge/check-history.mjs` over the last 330 merged PRs:

| Rule set | PRs that pass |
| --- | --- |
| Today's auto-merge rules | 112 (34%) |
| The same path and content rules, without the size limit and the `feat` rule | 192 (58%) |
| A path or content rule blocks | 138 (42%) |

## Plan

### Lanes

One classifier decides the lane from the changed paths and the diff. CI, the local gate and
the auto-merge decision read the same result.

| Lane | Which change | Before merge | Who merges |
| --- | --- | --- | --- |
| Fast | No path or content rule matches | § Pull request check, § Queue check, one reviewer round | GitHub auto-merge, armed by the authoring agent |
| Guarded | A path or content rule matches, or the PR carries `needs-qa` | Today's gate, unchanged: full suites on the PR, CodeRabbit admission with resolved threads, the reviewer loop until clean, the full queue run | As today |

The rules are the never-lists and content rules of `.ai/skills/auto-merge/check.mjs`. They
gain the paths that produced defects a revert would not undo: `packages/cezar/src/home/**`,
`packages/cezar/src/project-migration/**` and `packages/cezar/src/self-update/**`. The
classifier moves to `.github/scripts/` as one module that `check.mjs` and
`change-surface.cjs` both import, so the two cannot disagree.

A fast-lane PR merges on its own (D4). The size limit (10 files, 400 lines) and the `feat`
rule leave the auto-merge decision; the path and content rules stay. Every other rule in
the skill stays: the owner's pause (`allow_auto_merge`), a user's request to review first,
and complete `Closes` references. On the last 330 PRs this raises the share that merges
without the owner from 34% to 58%.

`needs-qa` keeps its meaning: such a PR needs `qa-approved` before merge (`SDLC.md`). It
takes the guarded lane. 7 of 320 PRs carried it.

### Before the PR (5 minutes)

1. One command, `npm run prepr`, prints one verdict and the evidence block for the PR body.
   It prints the lane. It reads Squeal's results for the changed files and for lint. It runs
   only what Squeal does not cover: typecheck, citations and clones.
2. The Squeal wait bound in this command is 2 minutes. When it expires with no failure, the
   command says which results are missing and passes. CI gives the same results 4 minutes
   after the push.
3. A check that CI finishes in under 5 minutes is not a local gate. Local `test:parity`,
   local browser specs and local coverage collection leave the list of duties.
4. The agent starts one reviewer round at the commit. It does not wait for it before the push.
5. The agent opens the PR ready, not draft.

Regression proof (`docs/sdlc/regression-proof.md`) stays. It is part of writing the test,
before the agent says the code is done.

### Review

Fast lane:

1. One reviewer round runs on the committed head, with the existing prompt and scores.
2. No finding scored 5 or more: the agent arms auto-merge (`gh pr merge --auto --squash`).
3. A finding scored 5 or more: the agent fixes it, pushes once and arms auto-merge. No second
   round reviews the fix.
4. Findings scored 4 or lower do not block. The agent lists them in the PR body. It fixes
   them in the same push when it pushes anyway.
5. The `Automated Code Review` check passes without waiting for CodeRabbit.
6. CodeRabbit still reviews every PR. After the merge, a workflow reads its threads on the
   merged PR. For each unresolved thread it files one follow-up issue. A thread labelled
   Major or Critical also gets `release-blocker`. A Cezar automation starts a task for each
   follow-up issue, as the main CI repair automation does today.

Guarded lane: unchanged. The reviewer loop runs until a round has no active finding, and the
`Automated Code Review` check requires CodeRabbit admission and resolved threads.

The local round is a rule for agents, as it is today. CI does not verify it. The rule text
lives in the owner's Cezar prompt, outside this repository; § Owner actions has the text.

### Pull request check (4 minutes)

1. Every job starts at once. No job waits for preflight.
2. Lint, typecheck and build run as today.
3. Vitest runs the files that `scripts/test-changed.mjs` selects, with an explicit base, plus
   the source-reading guard tests. A change to shared inputs, configuration or an unknown
   path selects the full suite, as the script does today; that PR takes longer.
4. Browser specs run the files that `scripts/e2e-affected.mjs` selects.
5. Coverage leaves the PR run. § Main verification collects it.
6. Docs-only and infra-only changes keep today's skips.

The guarded lane runs the full suites, as today.

### Queue check (2 minutes)

For a fast-lane entry, the `merge_group` run executes typecheck, lint, build and the guard
tests on the combined commit. It keeps the protection against type and budget skew, the
class that made `main` red in October. It runs no Vitest shard and no browser shard.

A guarded entry runs today's queue run, with today's reuse.

A push to `main` no longer runs the suites in `ci.yml`. § Main verification replaces the
exact-commit proof for the fast lane.

### Main verification

One workflow, `main-verify.yml`, verifies `main`.

1. **Trigger.** A push to `main`, a 30-minute schedule and a manual dispatch. One run at a
   time; a waiting run is replaced by a newer one; a running run is never cancelled. Each
   run verifies the newest commit, so one run covers a batch of merges.
2. **Scope.** Everything a guarded PR run executes today: the full Vitest suite with
   coverage, the full browser suite, build, packaged CLI E2E and the Node floor.
3. **Verdict record.** A commit status `main-verify` on the verified commit: `success`,
   `failure` (confirmed), or `pending`. The last green commit is the newest commit on `main`
   with `success`.
4. **Flake or real.** On a failure the workflow reruns the failed jobs once on the same
   commit. A pass on the rerun files a flake issue with the failed test names; the verdict
   is `success`.
5. **Bisect.** A second failure is real. A matrix job runs only the failing files on each
   commit between the last green commit and the verified one. The first commit that fails is
   the cause.
6. **Revert.** The bot opens a PR that reverts the cause, with the label `main-revert` and
   auto-merge armed. It uses the release App token, so the PR starts CI. CI proves that the
   PR tree equals a plain `git revert` of the named commit; such a PR needs no review round.
   The bot comments on the reverted PR with the failing tests and the run link.
7. **Hold.** While the verdict is `failure`, the pull request check of every other PR
   reports "main is red" and does not pass. Entries already in the queue finish. The
   workflow re-runs the held checks when `main` is green.
8. **Snapshot.** The `dev` npm snapshot publishes from the verified commit, after `success`.

Clocks, on GitHub's scheduler:

| When | Action |
| --- | --- |
| A real failure is confirmed | The existing reporter files the `main-ci-failure` summary. It gets `release-blocker` |
| 60 min after the first confirmed failure, `main` not green | A comment on the summary mentions the owner |
| 6 h, `main` not green | The bot reverts every commit after the last green one, in one PR |
| Every 30 min | The scheduled run checks that the newest commit on `main` is verified or in progress. If not, it starts verification. If no run has finished for 90 min, it files the same alert |

Expected time red: 20 min to detect, 5 to classify, 5 to bisect, 7 to revert.

Cases:

| Case | Behaviour |
| --- | --- |
| Rerun passes | Flake issue. Verdict `success`. No revert |
| Failing files fail on the last green commit too | Environment or time. No revert. The summary says so, and the owner is mentioned at once |
| Failing files pass on every single commit of the batch | Interaction or flake. No revert. The repair automation starts a task, as today |
| Bisect names one commit; the revert applies | Revert PR, fast lane |
| Bisect names one commit; the revert conflicts | No partial revert. The repair automation starts a task. The 60-minute and 6-hour clocks still run |
| Two commits in one batch break different tests | One bisect per failing file set; one revert PR per cause |
| The cause is a guarded-lane commit | Same revert. A revert of code is safe; state that the commit already wrote is not undone, and the comment says so |
| The revert PR fails its own check | The repair automation starts a task. The clocks still run |
| A new push lands while the bisect runs | It joins the next batch. The bisect range does not change |
| The App token is missing | The workflow fails visibly. The watchdog alert fires. Nothing is reverted |
| The 6-hour revert: the last green commit is older than 50 commits | No revert. The owner is mentioned. The limit keeps one bad status from undoing a day of work |

### Release

The owner starts a release, as today (D5). The workflow refuses a second stable release
within 24 hours of the last one. No schedule starts a release.

1. **Candidate.** The newest commit on `main` with `main-verify` `success`. The release does
   not repeat that suite; it reads the status of the exact commit.
2. **Gates.** No open issue carries `release-blocker`. The last rehearsal (below) passed.
3. **Stage.** Publish the version under the `next` dist-tag.
4. **Test the published package**, installed from the registry, not built from the tree:
   clean install, boot, cockpit smoke, upgrade from the current `latest` with existing state,
   the Node floor, the OS matrix, shuffled browser specs.
5. **Promote.** Move `latest` to the tested version. The tested bytes are the released bytes.
6. **Roll back.** One dispatch moves `latest` back to the previous version. Installed copies
   that already updated do not move back; they need a patch release.

**Rehearsal.** `nightly.yml` becomes the rehearsal. Each night it publishes the newest
verified commit under `nightly`, as today, and then runs step 4 against that package. A
failure files a `release-blocker` issue. The Cezar repair automation starts a task for it.

Desktop and mobile releases keep their own workflows and cadence.

### Records that a later run reads

| Record | Writer | Final when | Reader | Absent, unreadable or foreign |
| --- | --- | --- | --- | --- |
| Commit status `main-verify` | `main-verify.yml` only, with the Actions token | `success` or `failure` is set | The pull request check (hold), the release workflow, the watchdog, the snapshot job | No status: not verified. The release refuses; the hold does not apply; the watchdog starts a run. A status from another app is ignored |
| Label `release-blocker` | The failure reporter, the post-merge review workflow, the rehearsal | The issue is closed | The release workflow | The label does not exist in the repository: the release workflow fails before it publishes |
| Lane | The shared classifier | Per head commit | `ci.yml`, `npm run prepr`, the auto-merge decision | The classifier throws or cannot read the base: guarded |
| Label `main-revert` | The revert bot | The PR is merged or closed | The pull request check (admit while red, verify plain revert) | A PR with the label whose tree is not a plain revert fails the check |

### Guarantees that change

| Mechanism today | What it guarantees | After |
| --- | --- | --- |
| Full suites on every PR head | A merged change passed every test on its own base | Fast lane: it passed the selected tests. The full suite passes on `main` within one batch, or the change is reverted |
| Full queue run on the combined commit | `main` never receives a commit that fails the full suite | Fast lane: `main` never receives a commit that fails typecheck, lint, build or a guard test. Other failures reach `main` and are reverted |
| Exact-commit proof on a `main` push | Each `main` commit has a full green run | Each batch head has one. A commit inside a batch has none of its own |
| `main` push run cancels the older run | Saves runner time | Removed. A run always finishes, so every verdict belongs to a known commit |
| Draft until checks pass (`pr-readiness.yml`) | A ready PR has green checks; the board shows review state | Fast lane: opened ready; the board card moves at open. Guarded lane: unchanged |
| 180 s settle after the first ready event | CodeRabbit cannot be skipped by a fast enqueue | Fast lane: CodeRabbit does not block, so the wait has no purpose. Guarded lane: unchanged |
| CodeRabbit admission and resolved threads | No PR merges with an unresolved finding | Fast lane: findings become follow-up issues; Major and Critical ones block the release. Guarded lane: unchanged |
| Reviewer loop until clean | No PR opens with an active reviewer finding | Fast lane: no PR auto-merges with a finding scored 5 or more from round 1. Guarded lane: unchanged |
| `dev` snapshot on every `main` push | `dev` follows `main` within minutes | `dev` follows each verified batch head. Every `dev` build passed the full suite |
| Release verify job | Typecheck, unit tests and build pass on the release commit | The release reads the full `main-verify` proof and tests the published package |
| Nightly | `main` still passes against the calendar | The rehearsal does that and tests the published package |

## Owner actions

Only the owner can make these changes. Each phase lists the ones it needs.

1. Ruleset `Protect main`: turn off required review-thread resolution. The
   `Automated Code Review` check keeps enforcing it for the guarded lane.
2. Create the labels `release-blocker` and `main-revert`.
3. Allow the release App to open and merge revert PRs.
4. Replace the "Pre-PR review" rule in the Cezar prompt with: run one reviewer round on the
   committed head, beside the push; on the fast lane, fix findings scored 5 or more once and
   arm auto-merge; on the guarded lane, repeat with a fresh reviewer until a round reports no
   active finding.
5. Create two Cezar automations: one for `release-blocker` issues from the rehearsal, one
   for review follow-up issues.

## Phases

Each row is one issue. The safety net comes first; no later phase starts before P1 is live.

| Phase | Content | Needs |
| --- | --- | --- |
| P0 | This spec | |
| P1 | `main-verify.yml`: rolling full run, rerun, status, bisect, revert bot, hold, clocks, watchdog, `dev` snapshot from the verified commit. It runs beside today's `main` push CI for one week before that is removed | Owner actions 2, 3 |
| P2 | Release: once-a-day guard, gates, stage on `next`, test the published package, promote, roll back. Nightly becomes the rehearsal | P1; owner actions 2, 5 |
| P3 | Lanes and merge path: the shared classifier, the auto-merge rules of D4, open ready, auto-merge, `pr-readiness.yml` for the guarded lane only, no preflight chain, the light queue check | P1; owner action 1 |
| P4 | Review placement: `Automated Code Review` per lane, the post-merge review workflow, the agent rule | P2, P3; owner actions 4, 5 |
| P5 | Affected tests on the fast lane. Step 1: a shadow job records, for one week, the selection for each PR run and whether a failing test fell outside it. Step 2: the owner reads the report and decides the switch | P1, P3 |
| P6 | Local gate: `npm run prepr`, the 2-minute bound, the shorter list of duties in `AGENTS.md` and the skills | P3 |

P5 replaces the queue part of hearsay-tools/cezarion#2415: full verification moves to
`main`, not to the queue.

Expected effect: P3 brings PR open → merged from 69 to about 20 minutes on the fast lane.
P4 and P5 bring it to about 5 to 7 minutes for a PR whose reviewer round is clean.

## Limits

- The 4-minute and 2-minute budgets are estimates from job step times. No run has shown them.
- The miss rate of affected-only selection is unknown. An earlier pilot of 5 commits found no
  miss, but every commit was green. P5 step 1 measures it.
- Not verified: that CodeRabbit posts its threads when a PR merges during its review; that
  the publish identity can move a dist-tag. P4 and P2 check these first.
- The pre-PR timing comes from 28 tasks on one host in one week.
- The review-value classification was done by subagents; hand checks covered 16 of 200 and
  6 of 250 findings.
- The guarded lane keeps today's times. On the last 330 PRs it holds 42% of the PRs.
