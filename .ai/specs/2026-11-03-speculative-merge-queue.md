# Parallel speculative merge-queue builds

Issue: hearsay-tools/cezarion#2610. Status: design, for owner approval. Owner decisions
recorded 2026-11-03. Implementation follows in separate issues (§ Follow-up issues).

## Goal

Let the `main` merge queue build two entries at once. Entry 2 is tested on top of
entry 1, and each PR still lands as its own tested commit. The queue was saturated
on 2026-11-03: at most one merge per run, about 3.3 merges per hour. Two builds
raise the ceiling to about 6 merges per hour. Every guarantee the serial queue
gives today stays: per-PR review admission, exact-SHA main proof and full fallback.

## Owner decisions

| # | Decision | Answer |
| --- | --- | --- |
| Q1 | Build concurrency (`max_entries_to_build`) for the pilot | **2** |
| Q2 | Batching (`max_entries_to_merge > 1`) | **Out.** Revisit after the pilot. This spec does not design it |
| Q3 | Cost limit and rollback trigger | Roll back to 1 when, over a rolling 7 days, the queue failure rate is above **30%** or runner-minutes per merge are more than **40%** above the serial baseline of **128**. The owner reads a weekly metric. No automation |
| Q4 | Builds invalidated behind a failed entry | **Accept the waste** in the pilot and measure it. Add cancellation only if the pilot shows more waste than the model |

Raising concurrency above 2, or batching, needs a change to this spec first.

## Evidence

Source: 120 `merge_group` runs of `ci.yml` from 2026-11-01 to 2026-11-03, all
completed (`gh run list --event merge_group --workflow ci.yml`, the jobs API, and PR
timeline `ADDED_TO_MERGE_QUEUE_EVENT` / `REMOVED_FROM_MERGE_QUEUE_EVENT` /
`MERGED_EVENT`).

| Measure | Value |
| --- | --- |
| Runs: success / failure / cancelled | 92 / 27 / 1 (22.5% failure) |
| Failures that later passed with the same PR diff | 20 of 27 (mostly Vitest shards) |
| Wall time, success run | p50 13.5 min, p90 17.4 min |
| Queue removal after a failure (`failed_checks`) | p50 13.0 min after run start |
| First failing job concludes | p50 10.3 min after run start |
| Runner-minutes per full run | p50 99 (hosted mean 55, Ubicloud mean 37) |
| Runs that reused native PR suites | 10 of 120 (8%), 25 runner-min each |
| Runner-minutes per merge, measured | 117 (10,898 over 93 merges) |
| Merges on 11-01 / 11-02 / 11-03 | 11 / 28 / 54 |
| Queue busy share of active span on 11-03 | 77%; idle gap p50 0.5 min |
| Enqueue to merge (last enqueue) | p50 28 min, p90 176 min, max 242 min |
| Removal reasons | merged 93, failed_checks 26, manual 9, merge_conflict 1 |
| Peak concurrent jobs per queue run | 6 GitHub-hosted, 4 Ubicloud |
| Speculative chaining today | None: no run started on a base whose run was in progress |

The org is on the GitHub Free plan: at most 20 concurrent GitHub-hosted jobs, shared
with PR CI. The repository is public, so hosted minutes are free. Ubicloud minutes
are billed.

## How GitHub builds two entries

The design relies on these GitHub merge-queue semantics. The pre-activation exercise
(§ Rollout) checks each one before the owner changes the ruleset.

- **S1.** Each entry gets its own group ref `gh-readonly-queue/main/pr-<N>-<base>`. Entry 1's
  base is `main`. Entry 2's base is entry 1's group head commit.
- **S2.** A group head is one squash commit whose first parent is the group base. Its
  tree is base + this PR.
- **S3.** With `max_entries_to_merge: 1`, `main` advances to each group head in order.
  Every merged `main` commit is the head SHA of the group that tested it. GitHub may
  push two heads in one push. In that case the pushed SHA is entry 2's head, and entry 1's
  head is its first parent.
- **S4.** A failed, removed, timed-out or changed entry invalidates every group behind it.
  GitHub builds those entries again on a new base, with new group SHAs. Results of an
  invalidated group never merge anything.
- **S5.** The GraphQL `mergeQueue.entries` node for entry 2 reports `position: 2`,
  `headCommit` equal to its group head and `baseCommit` equal to its group base.
  This is the least certain point; see the case table, row 24.

## Guarantees the serial queue gives today

Each row names what `max_entries_to_build: 1` is load-bearing for, and how the design keeps it.

| # | Guarantee today | Where | With two builds |
| --- | --- | --- | --- |
| G1 | The landed commit is the tested commit (exact SHA) | GitHub squash, `queue-ci-proof.cjs` | Kept by S3. Each pushed SHA is a group head with its own queue run |
| G2 | Admission reads the reviewed PR that this build tests | `merge-queue-admission.cjs` `entryFrom`: `entries(first: 1)`, `position === 1` | Changed: find the one entry whose `headCommit` and `baseCommit` equal the group SHAs, at position 1 or 2 |
| G3 | Admission and proof helpers run trusted code, from the group base | `ci.yml` checks out `merge_group.base_sha` | For entry 2 the base is entry 1's group head: reviewed and admitted code that is not yet on `main`. Entry 2 can land only after entry 1 lands, so the helper it ran is the helper `main` will hold. If entry 1 fails, entry 2 is built again on `main` (S4). Under the serial queue, entry 2 ran entry 1's helper too, after entry 1 merged. No new trust |
| G4 | Native-suite reuse only when the queue tree equals the PR head tree and the base is `main` | `pr-test-proof.cjs` `onlyEntry`, `matchingMain`, `sameTree` | Kept, and `onlyEntry` is relaxed: entries behind no longer block reuse. Entry 2's base is not `main`, so it always runs full suites |
| G5 | Main push reuses only a queue run for the exact pushed SHA | `queue-ci-proof.cjs` | Unchanged code. Holds by S3. The first-parent check from hearsay-tools/cezarion#2615 (docs-only skip) stays valid: a non-first group head's first parent is the previous group head, which the ref names as its base (S1, S2) |
| G6 | The complexity gate reads `baseline-growth` from the one PR the group ref names | `ci.yml` "Check function complexity" | Kept: with merge count 1, each ref names one PR. Growth is measured against the group base, the commit it lands on |
| G7 | No automatic requeue and no paid-review loop | GitHub, admission | Kept. GitHub's rebuild of invalidated entries is a re-test of the same admitted PR head. It calls no model and does not requeue removed PRs |
| G8 | Queue rules are exactly the reviewed settings | `requireSerialRules` | Changed: `max_entries_to_build` may be 1 or 2. Every other setting stays exact |

## Design

### 1. Queue rules (`merge-queue-admission.cjs`)

Rename `requireSerialRules` to `requireQueueRules`. Accept `max_entries_to_build` of
1 or 2. Keep the exact checks: `SQUASH`, `min_entries_to_merge: 1`,
`max_entries_to_merge: 1`, `ALLGREEN`, a 45-minute timeout, both required Actions
checks (`integration_id` 15368) and review-thread resolution. Any other value fails
closed, as today.

The code ships accepting both 1 and 2. It lands before the ruleset change and
behaves exactly as today at 1. Rollback is a ruleset change only.

### 2. Admission entry lookup (`merge-queue-admission.cjs`)

- `QUEUE_QUERY` reads `entries(first: 2)`, the build window, with `pageInfo`.
- `entryFrom` selects the entries whose `headCommit.oid === group.head_sha`. Exactly
  one must match. Its `baseCommit.oid` must equal `group.base_sha`, and its position
  must be 1 or 2.
- For position 2, the entry at position 1 must have `headCommit.oid === group.base_sha`.
  This ties the build to the chain GitHub reports.
- An entry can move from position 2 to position 1 during its build, when entry 1
  merges. Its base is then entry 1's group head, which is now `main`. Admission at
  position 1 needs no chain check: `baseCommit` equal to the group base is enough.
- The final re-read already re-checks the entry and the PR, and stays. It
  accepts the entry at either position, so the move above does not fail it.
- Every other check stays unchanged: PR state, native `pull_request_target` run,
  CodeRabbit admission, threads, and the final re-read of rules, entry and PR.

### 3. Native-suite reuse (`pr-test-proof.cjs`)

- `onlyEntry` becomes "this build's entry", from the same lookup as admission.
  It no longer requires `hasNextPage === false`.
- Reuse still requires `group.base_sha === main` (`matchingMain`), equal trees and an
  equal `ci.yml` blob. So only an entry built directly on `main` can reuse, as today.
  Entry 2 falls back to full suites with reason `native-proof-unavailable`.
- This keeps reuse for the first entry after an idle queue or after a failure ahead.
  Today any second queued entry blocks it.

### 4. Main-push proof (`queue-ci-proof.cjs`)

No code change. Add tests that pin a pushed SHA whose queue run's ref base is a previous
group head (not the old `main` tip). Add tests for a push that advances `main` over two
group heads at once. If hearsay-tools/cezarion#2615 has landed, add the docs-only variant:
a non-first docs-only entry is reused when its first parent equals the ref base.

### 5. Invalidated builds (Q4)

`ci.yml` keys `merge_group` concurrency by `github.ref`. Each group ref is distinct, so a
rebuild does not cancel the invalidated run. The pilot keeps this and measures the minutes
spent on invalidated runs. An invalidated run cannot authorize anything:

- its group never merges (S4);
- its head SHA never reaches `main`, so the main-push proof never matches it;
- if it reaches admission after the rebuild, the lookup finds no entry with its head
  SHA and fails closed.

### 6. Docs and comments

Update `docs/sdlc/ci.md` § Merge queue and exact-commit reuse and § Maintainer
activation and rollback. Update the "queue is serial" sentence near the complexity gate
(`docs/sdlc/ci.md`, and the comment at `ci.yml` "Check function complexity"). Name merge
count 1 as the reason the ref names one PR. Copy the case table below into `ci.md`.

## Throughput and cost

Saturated-queue model (`k` = `max_entries_to_build`). Assumptions:

- success at 13.5 min, failure removal at 13.0 min, 99 runner-min per full run;
- independent failures with probability `p`;
- a failure invalidates every build behind it, and invalidated runs keep running (Q4);
- entries behind position 1 lose native-suite reuse, about +7%.

| Failure rate `p` | k=1 merges/h | k=1 runner-min/merge | k=2 merges/h | k=2 runner-min/merge | k=2 vs 128 |
| --- | --- | --- | --- | --- | --- |
| 10% | 3.9 | 110 | 7.5 | 126 | −1% |
| 15% | 3.7 | 116 | 6.9 | 138 | +8% |
| 20% | 3.5 | 123 | 6.3 | 153 | +19% |
| **22.5% (measured)** | **3.3** | **128** | **6.0** | **161** | **+25%** |
| 25% | 3.2 | 132 | 5.8 | 168 | +32% |
| 28% | 3.1 | 137 | 5.5 | 179 | +40% |
| 30% | 3.1 | 140 | 5.3 | 186 | +46% |
| 40% | 2.6 | 164 | 4.3 | 237 | +85% |

- **Throughput.** Two builds give 1.6 to 1.9 times the merges per hour at every failure
  rate up to 40%. Throughput alone never stops paying.
- **Cost.** The owner's cost limit (+40% over 128, so 179 runner-min per merge) is reached at a
  failure rate of about **28%**, before the 30% failure trigger. **The change stops
  paying at about 28% failures.** With cancellation of invalidated runs, the point moves
  to about 31%.
- **Today.** At the measured 22.5%, the pilot costs about +25% runner time per merge and
  stays inside the limit. Most failures are flaky (20 of 27), so flaky-test fixes lower
  the cost directly. Shortening the run (hearsay-tools/cezarion#2608) and skipping suites
  for docs-only entries (hearsay-tools/cezarion#2609) lower both terms.
- **Runner capacity.** Two queue runs peak at 12 GitHub-hosted jobs of the plan's 20,
  shared with PR CI, plus 8 Ubicloud jobs. If hosted jobs wait for slots, queue runs
  get longer and the throughput gain shrinks. The pilot watches queue-run wall p50:
  above 15 min, slot contention is eating the gain.
- **Limits of the model.** It assumes a full queue. At lower demand both settings merge
  as fast as PRs arrive, and the second build runs only when an entry waits behind
  another.

## Case table: queue states at the shipped setting (`max_entries_to_build: 2`)

| # | State / case | Trigger | Who or what fires it | Behavior at k=2 | At rollback (k=1) |
| --- | --- | --- | --- | --- | --- |
| 1 | Two entries building; entry 1 finishes first and passes | Required checks succeed | GitHub | Entry 1 merges; `main` = its group head; main-push proof reuses its run. Entry 2 keeps building on that commit | As today |
| 2 | Entry 2 passes before entry 1 | Entry 2 checks succeed first | GitHub | Entry 2 waits. It merges after entry 1 merges | Cannot happen: one build |
| 3 | Both pass; GitHub pushes `main` straight to entry 2's head | Both green | GitHub | One push. Proof reuses entry 2's run (exact SHA). Entry 1's head gets no own `main` push run. Snapshot publishing covers entry 2's SHA, which contains entry 1 | Cannot happen |
| 4 | Entry 1 fails (flaky or real) | A required check fails | GitHub | Entry 1 removed; PR stays open. Entry 2's group is invalidated and built again on `main`. The old entry-2 run keeps running (Q4) and authorizes nothing | Entry 1 removed; next entry builds |
| 5 | Entry 1 removed by a human | Manual removal | Authorized human | As row 4 | As today |
| 6 | Entry 1 times out (45 min) | Check timeout | GitHub | As row 4 | As today |
| 7 | Entry 1's PR head changes | Push to the PR | Author, then GitHub | GitHub removes entry 1; as row 4 | As today |
| 8 | Entry 2 fails while entry 1 builds | A required check fails | GitHub | Entry 2 removed; entry 1 unaffected. The next queued entry builds on entry 1's group head | Cannot happen |
| 9 | Entry 2's PR head changes, or a human removes it | Push or removal | Author or human | Entry 2 removed; entry 1 unaffected | Not building yet: removed from the queue |
| 10 | Queue reordered or an entry jumps ahead | Human action | Authorized human | GitHub builds again with new groups. A stale group's admission finds no matching entry and fails closed | As today |
| 11 | Entry 2 conflicts with entry 1 | Group commit cannot be built | GitHub | Entry 2 removed with `merge_conflict`; PR stays open | Conflict found when it reaches the head |
| 12 | Entry 1 changes `ci.yml` | PR content | Author | Entry 2's run uses its group head's workflow, which holds entry 1's change. Entry 2 cannot reuse native suites anyway (base is not `main`) | As today: the next entry runs the merged workflow |
| 13 | Entry 1 changes the admission or proof helpers | PR content | Author | Entry 2 runs entry 1's helpers from its base (G3). If entry 1 fails, entry 2 is built again on `main`'s helpers | Entry 2 runs them after entry 1 merges |
| 14 | Entry 2 changes `ci.yml` | PR content | Author | Its own run uses the group head's workflow; helpers come from its base; no reuse. Same as today | As today |
| 15 | Ruleset set back to 1 with two entries in flight | Owner edits ruleset 22473654 | Owner | Admission accepts 1 or 2 at every read, so in-flight builds stay valid. If GitHub invalidates entry 2, it is built again later | — |
| 16 | Ruleset set to 3 or more, or batching enabled, without a spec change | Owner edits ruleset | Owner | Admission rejects every entry. The queue fails every build until the owner reverts the setting or this spec and the allowlist change | Same |
| 17 | `main` moves outside the queue | Push with bypass | Nobody: the ruleset has no bypass actors | Cannot happen. If it did, GitHub rebuilds every group on the new `main` | Same |
| 18 | Admission API error, deadline or changing evidence | GitHub API | Actions | Entry fails closed and is removed, so it counts as a queue failure. The PR stays open | As today |
| 19 | Docs-only entry at position 2 (once hearsay-tools/cezarion#2615 lands) | PR content | Classifier | The group diff `base..head` is that PR's own diff, so the skip is valid. Main proof: first parent = ref base | As today |
| 20 | Entry at position 2, native suites passed | — | `pr-test-proof` | Base is not `main`, so full suites run | Cannot happen |
| 21 | Entry at position 1 on `main`, PR up to date, entries behind it | — | `pr-test-proof` | Reuse allowed (today: blocked by the entries behind) | Reuse allowed |
| 22 | An invalidated run finishes green later | Old run completes | Actions | Its group never merges, and its SHA never reaches `main`. It is counted as waste in the pilot metric | Cannot happen |
| 23 | Manual re-run of a failed queue run | Human | Human | The entry was already removed; the run proves nothing for a new group. Requeue the PR | As today |
| 24 | GitHub reports entry 2's `baseCommit` as `main`, not entry 1's head (S5 false) | GitHub data model | GitHub | Entry 2's admission fails closed on every build. The pre-activation exercise catches this before the pilot. Then the lookup changes to: base = the position-1 head, checked through the ref name | — |
| 25 | GitHub cancels invalidated runs itself | GitHub behavior | GitHub | Less waste than the model; no correctness change | — |

Rows that "cannot happen" at k=1 are why the serial queue never needed them.

## Rollout and pilot

1. **Implementation lands (k stays 1).** Items 1 to 4 and 6 of § Design merge with tests.
   Tests pin that k=1 behaves exactly as today. Prove each new regression test red
   without its fix ([`docs/sdlc/regression-proof.md`](../../docs/sdlc/regression-proof.md)).
2. **Pre-activation exercise.** In a controlled sandbox repository with the same ruleset
   shape and k=2, enqueue three trivial PRs and record:
   - the entry `position`, `headCommit` and `baseCommit` that GraphQL reports (S5);
   - each group head's first parent (S2);
   - each `main` push SHA against the group heads, and whether one push covers two
     merges (S3);
   - the effect of failing entry 1 on entry 2's run: cancelled or left running (S4,
     row 25);
   - that admission passes at positions 1 and 2, and fails for a stale group.

   Attach the results to the pilot issue. Any mismatch returns to design review before
   step 3.
3. **Ruleset change (owner).** In ruleset 22473654, change only `max_entries_to_build`
   from 1 to 2. Keep squash, merge count 1/1, `ALLGREEN`, the 45-minute timeout, both
   required Actions checks, review-thread resolution, strict checks off and no
   bypass actors.
4. **Pilot: 7 days.** The owner reads the weekly metric (follow-up issue 3):
   - merges per day;
   - enqueue-to-merge p50 and p90;
   - queue failure rate;
   - runner-minutes per merge, hosted and Ubicloud;
   - minutes spent on invalidated runs;
   - queue-run wall p50;
   - main-push proof fallbacks and their reasons.
5. **Decision.** Keep k=2, roll back, or propose a spec change for k=3 or cancellation.
   Cancellation is proposed if invalidated-run minutes exceed the model: about +5% per
   merge at 22.5% failures.

**Rollback triggers (Q3).** Over a rolling 7 days, either of these triggers a rollback:

- queue failure rate above 30%;
- runner-minutes per merge above 179 (128 × 1.4).

Also roll back on any correctness signal:

- a `main` commit with no exact queue run;
- an admission that passed for the wrong PR;
- an unexpected main full fallback that traces to k=2.

**Rollback.** The owner sets `max_entries_to_build` back to 1. No code revert is needed,
because admission accepts 1. In-flight entries finish or GitHub builds them again (row 15).
Full main CI fallback, both required checks, review-thread resolution and no-bypass
protection stay throughout. For an incident, a bare workflow dispatch still forces
full CI.

## Out of scope

- Batching (`max_entries_to_merge > 1`), per Q2.
- Build concurrency above 2.
- Cancelling invalidated runs, unless the pilot shows more waste than the model (Q4).
- Changing the ruleset. The owner does that after the exercise.
- Automatic rollback or alerting, per Q3.

## Follow-up issues

Filed after the owner approves this spec:

1. **Admission: accept build concurrency 2 and find the entry by group head.**
   `merge-queue-admission.cjs` (§ Design 1, 2), its tests and testkit; `ci.md` and the
   `ci.yml` comment (§ Design 6).
2. **Native-suite proof: allow reuse at position 1 with entries behind.**
   `pr-test-proof.cjs` (§ Design 3), its tests; main-push proof tests for non-first and
   two-merge pushes (§ Design 4).
3. **Weekly queue metric, run by hand.** A read-only script that prints the pilot
   metrics (§ Rollout step 4) from the Actions and GraphQL APIs. No schedule.
4. **Pre-activation exercise and pilot.** The sandbox exercise (§ Rollout step 2), then
   the owner's ruleset change and the 7-day pilot read-out. Depends on 1, 2 and 3.
