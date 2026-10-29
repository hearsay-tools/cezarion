# Automated review inside the CI run

Status: implemented · Date: 2026-10-15 · Relates: `.github/workflows/ci.yml`, `.github/workflows/automated-code-review.yml`, ruleset **Protect main** (required checks `Unit, build, E2E, and package` and `Automated Code Review`)

Timing superseded on 2026-10-29 by [review-first CI](2026-10-29-review-first-ci-plan.md).
The following text records the original implementation and its evidence.

## TLDR

The automated review used to be its own `pull_request_target` workflow. A `wait-for-ci` job held a runner while it polled for CI to succeed. It is now a reusable workflow that `ci.yml` calls with `needs: verify`, so GitHub starts it when verification succeeds and nothing waits. The `wait-for-ci` job, its 20-minute deadline and the **Recover Automated Review** workflow that rescued expired waits are all gone.

## Problem

The review was ported as a separate workflow on 2026-09-01. `wait-for-ci` then only collected CI context for the model. On 2026-09-09 (fork #158) it became a gate: no model review unless CI verification succeeded for the exact head SHA. The gate was a runner polling the Actions API every 15 seconds for up to 20 minutes. Waits that expired needed a `workflow_run` recovery workflow (fork #179), and the polling grew retry and timeout fixes (fork #1032, fork #1061). No spec recorded a reason to keep the review out of `ci.yml`.

Measured over the last 150 Automated Code Review runs, on 2026-10-15:

| Job | Runner minutes | Median | Max |
| --- | --- | --- | --- |
| `wait-for-ci` | 1,968 | 14.2 min | 20.2 min |
| `codex-review` (model work) | 163 | — | 8.1 min |
| everything else | ~100 | — | — |

`wait-for-ci` was 87% of the workflow's runner time and the most expensive job in the repository that month (4,515 minutes over 474 runs on the Actions usage page). 25 of the 150 waits (17%) hit the 20-minute deadline, and 29 were cancelled by a newer push.

## Design

- `automated-code-review.yml` triggers on `workflow_call` and `workflow_dispatch`, never `pull_request_target`. Under `workflow_call`, `github.*` is the caller's pull-request event, so every job reads the PR exactly as before.
- `ci.yml` job `review` (`name: Review`) calls it with `needs: verify`, only for `pull_request_target` into `main`. Its `if:` holds `!cancelled() && needs.verify.result == 'success'`: without a status function GitHub adds an implicit `success()`, which reads false when a shard before `verify` was skipped, so every docs-only, infra-only and bump PR lost its review (hearsay-tools/cezarion#1100). It passes `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` explicitly, never `secrets: inherit`. Its permissions are exactly the union of the called jobs' own permissions; every called job declares its own permissions and narrows from there.
- `ci.yml` job `review-result` is the required **Automated Code Review** check. A called workflow's jobs show as `Review / <job>`, so the required name cannot come from inside it. It succeeds only when the called workflow succeeds and points at the called **Review verdict** job for the reason. Outside a PR into `main` it is skipped under a different name, because a skipped job reports success and must never satisfy the required check.
- The model jobs still recheck, immediately before model work, that verification succeeded for the exact head SHA (`fetch-ci-results.cjs --require-success`). The `--wait` polling mode is removed.

### Artifact trust

A review in a standalone workflow shared its run with no PR code. Inside `ci.yml` it shares the run with jobs that build PR code, including `prepare-pr-snapshot`, which runs at the same time as the review. Any job can upload an artifact named `review-output`. The provider job therefore exports the `artifact-id` from `upload-artifact`, and `post-review` downloads only that ID (`artifact-ids` + `merge-multiple`). A step before the download fails on a missing or malformed ID, because `download-artifact` with neither `name` nor `artifact-ids` downloads every artifact in the run.

### What the CI run's conclusion now means

Open findings fail the CI run, not just a separate workflow. Consumers:

- `pr-snapshot.cjs` required run-level success. It now accepts a completed `success` or `failure` run, and still requires the verification and preparation jobs to succeed. A cancelled or unfinished run never publishes. Snapshots now publish only after the review finishes.
- `pr-readiness.cjs` and `release-ci.cjs` read individual checks and jobs. Release bump PRs skip the model round, so their run stays green.
- The CI failure sweep already reported failed Automated Code Review runs, so it changes nothing.

### Reruns

- After flaky verification, **Re-run failed jobs** reruns the failed shards, `verify` and the skipped review. Nothing needs recovering.
- `postReview` reads reviews and the live head again before posting, so no rerun exceeds the round cap, posts twice on one head, or posts on a stale head.
- After resolving findings by hand, re-run **Review / review-round** to recount. A pushback reply needs the model to judge it, and the patch-ID guard skips the model on an unchanged patch. So run `workflow_dispatch` with `pr_number` first, which skips that guard and applies verdicts, then re-run **Review / review-round**.
- `workflow_dispatch` reviews one PR outside the cap. Its checks attach to the dispatched branch, not the PR head, as before.
- The workflow-level concurrency group includes `github.event_name`, so a manual dispatch never cancels the review inside a CI run.

## Validation

Unit tests (`automated-code-review.workflow.test.cjs`) pin the triggers, the `needs: verify` gate, the routing and naming of the required check, the permission union, the explicit secrets, and the artifact-ID guard. `pr-snapshot.test.cjs` pins publishing despite a review failure. `build-and-package` in `ci.yml` runs `actionlint` over `.github/workflows/`. `actionlint` checks each `uses: ./.github/workflows/…` caller's inputs and secrets against the called workflow. It also checks the syntax of every expression. `actionlint` does not compare permissions, so the unit test pins the permission union instead.

`pull_request_target` loads `ci.yml` from `main`, so the introducing PR is still reviewed by the previous standalone workflow. After merge, a disposable same-repository draft PR confirms one green run with one posted review. It then deliberately fails one verification job and confirms that **Re-run failed jobs** runs the review once verification passes.
