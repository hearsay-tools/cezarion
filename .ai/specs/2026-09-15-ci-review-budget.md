# CI and automated-review budget

Status: proposed · Date: 2026-09-15 · Relates: ruleset 22473654 Protect main, `.github/workflows/ci.yml`, `.github/workflows/automated-code-review.yml`

## TLDR

Stop paying O(N²) CI and review when a merge queue of N PRs each has to update onto `main`. Merge when the PR's own required check is green, even if the branch is behind. Catch combination failures with coalesced CI on every push to `main`. Spend automated-review rounds only when the PR's three-dot patch changes, not when GitHub updates the branch from `main`.

## Problem

CI runs on pull requests to `main`/`develop`, not on push to `main`. Automated review runs on `opened` / `synchronize` / `reopened` and treats an Update-branch as a new head, so it spends another of the `AUTOMATED_REVIEW_ROUNDS` (default 3) slots.

The Protect main ruleset then requires the branch to be up to date (`strict_required_status_checks_policy: true`, required check `Unit, build, E2E, and package`). Each merge forces waiting PRs to update. Those updates re-run CI and review. A busy day here is ~15 small PRs; the tax is quadratic in queue depth. Worse than the money: branch-update reviews consume the round cap, so a real late author fix can merge unreviewed.

Nightly already re-runs the gate on `main` before publishing `@nightly`, but only at 03:17 UTC and only as a publish skip, not as a trunk-health check.

## Policy (locked 2026-09-15)

1. Merge on PR-green. Drop require-up-to-date. Textual conflicts still block. Automated review stays advisory.
2. CI on every push to `main`, coalesced with the existing `cancel-in-progress` group. No daily cron CI. Nightly stays the `@nightly` publish gate.
3. Skip automated review when the three-dot patch-id matches the last posted automated review. That skip does not consume a round. `workflow_dispatch` still bypasses the cap.
4. No scheduled review of landed `main`. GitHub merge queue is the fallback only if red-`main` becomes frequent after this ships.

## Merge-time invariant

A PR may merge when the required check `Unit, build, E2E, and package` is green on that PR. It may merge while behind `main`. GitHub still refuses a textual conflict. `required_approving_review_count` stays 0.

Change ruleset **Protect main** (`22473654`): set `strict_required_status_checks_policy` to `false`. Keep the required check, deletion, non-fast-forward, and extra approval for unattributed commits.

This toggle is GitHub-side, not a file in the repo. The implementing PR cannot flip it; the issue's last criterion is a maintainer doing so after the workflow changes are on `main`.

In `SDLC.md` Merge row, add one sentence: a PR may merge while behind `main` as long as its required check is green and GitHub can merge.

## CI on push to main

In `.github/workflows/ci.yml`, add `main` to `on.push.branches` next to `develop`.

Leave concurrency as:

```
group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
cancel-in-progress: true
```

Push-to-`main` events share `ci-CI-refs/heads/main` and cancel stale tips. Do not invent a second group.

Do not change:

- `publish-snapshot` — it already skips `main` so CI never moves `latest`
- Nightly — still the `@nightly` publish gate, still reports its own failures
- `report-workflow-failure.yml` — do not extend it to CI; the red check on the `main` SHA is the signal

## Review only when the patch changes

In `.github/workflows/automated-code-review.yml` `review-round`, after the existing round-cap check, compute:

```
git diff --full-index <base_sha>...<head_sha> | git patch-id --stable
```

Take the first 40-character hex field. Compare it to the most recent `github-actions[bot]` review body that contains `<!-- cez-review-patch-id: <40hex> -->`. Same id → `can_review=false` and do not call the model. Missing marker (reviews posted before this ships) → treat as no match and review once.

`postReview` in `.github/scripts/automated-review.cjs` appends that HTML comment to every posted review body, including findings-only reviews that today post with `body: body || ''`.

Rules:

- Unchanged patch-id does not increment `countAutomatedReviews`
- Changed patch (author commits, conflict resolution) reviews as today, still capped
- `workflow_dispatch` still sets `IGNORE_CAP` and bypasses both the cap and the patch-id skip
- Compute failure (git missing objects, empty hash) → review, not skip. The cap remains the budget bound
- No review job on push to `main`. No daily landed-`main` review
- Leave `recover-automated-review.yml` unchanged; recovery of an incomplete round is not a branch-update skip

Checkout for the hash uses `persist-credentials: false`. `pull_request_target` already treats the PR as untrusted data.

## Tests

- Unit-test patch-id extract/format and the skip decision in `.github/scripts/automated-review.test.cjs` (marker present/absent, mismatch, cap untouched)
- Extend `.github/scripts/automated-code-review.workflow.test.cjs` so the workflow still computes the hash and wires `can_review=false` on match
- `ci.yml` trigger includes `push` to `main`; `publish-snapshot` `if` still excludes `main`

## Out of scope

- GitHub merge queue (revisit if coalesced `main` CI goes red often)
- Daily CI or daily review of landed `main`
- Making automated review a required check
- Filing issues on red `main` CI (Nightly/Release already file on publish/release failure)

## Fallback

If `main` CI fails from semantic merge conflicts often enough to hurt, enable GitHub's merge queue and a `merge_group` trigger on `ci.yml`. That tests the exact merged result and avoids synchronize storms, at the cost of ~15 minutes per group and agent-merge rework. Do not build it in this change.
