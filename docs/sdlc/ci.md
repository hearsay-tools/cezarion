# Continuous integration

`.github/workflows/ci.yml` runs on pull requests to `main` or `develop`, pushes to those branches, and manual dispatch.

Verification runs in three parallel jobs on `blacksmith-4vcpu-ubuntu-2404` with the current Node LTS:

- Two Vitest shards each install dependencies, build the server, and run `npm test -- --shard=N/2 --maxWorkers=4`.
- The build/package job runs typechecking, Node unit tests, the full application build, packaged CLI tests, and release-package dry-run packing.

The required check keeps its name, **Unit, build, E2E, and package**. It succeeds only when the build/package job and both Vitest shards succeed. The aggregate and snapshot jobs remain on GitHub-hosted Ubuntu. The snapshot job still waits for this aggregate check and retains its existing publication conditions. The separate browser `test:e2e` suite is not part of this workflow.

The Vitest sequencer assigns discovered tests to shards by measured duration using `.github/test-durations.json`. New files receive the median known duration and are always included; deleted files are ignored. The manifest affects balancing only, never discovery. Refreshing its durations can improve balance as the suite changes. Ordinary `npm test` still runs every suite without sharding.

The push-only `.github/workflows/ci-benchmark.yml` workflow runs controlled experiments on `bench/156-*` branches. It uses a fixed application baseline, records failures and resource usage, and performs publication experiments only as dry runs. Reproduction instructions and retained results are in [the issue 156 benchmark report](../benchmarks/ci-performance-156.md). Automated review remains enabled throughout.

Both Codex and Claude automated review wait for the **Unit, build, E2E, and package** verification job in the `ci.yml` pull-request run for the exact head SHA. The selected provider starts only when that job succeeds, while npm snapshot publication can continue independently. Failed, timed-out, cancelled, skipped or inconclusive verification blocks the model job. Standalone CI context collection still reports verification's actual conclusion and failed verification jobs; individual completed-job logs avoid waiting for the whole workflow archive. Missing or unfinished verification stays pending until the bounded wait expires, and ambiguous jobs or job-query errors fail the wait. The context-fetch step rechecks success immediately before model work, so a same-SHA rerun cannot turn a prior successful wait into permission to review a pending or failed build. The wait and both context-fetch scripts still execute from the trusted base checkout. The required CI check and the publication gate are unchanged.

The worker-wait tests are split into three scenario suites with a shared fixture, so the longest indivisible suite no longer constrains shard balance. Case-preservation evidence, the refreshed duration weights and comparative benchmark results are in the [shard-balance report](../benchmarks/shard-balance.md).

The runner selection and three updated split-suite weights were measured together against the same application revision. Three successful matched pairs reduced median queue-inclusive CI verification workflow time from 208 to 178 seconds; weights alone did not improve the GitHub median. The [Blacksmith comparison](../benchmarks/blacksmith.md) retains all runs, cache conditions and failures. These manual-dispatch measurements exclude npm publication, which keeps its GitHub-hosted runner and existing gate.

The release workflow's verification job also uses `blacksmith-4vcpu-ubuntu-2404`, with its existing commands and default Vitest worker policy. Two successful matched release-verification pairs reduced median queue-inclusive job time from 438 to 354.5 seconds; one failure on each provider is retained in the report. Stable and snapshot npm publishing remain on GitHub-hosted runners.

### Recovery after a CI retry

`recover-automated-review.yml` listens for CI completion and reconciles the live open same-repository PR on `main`, its current head, and the newest CI run and exact attempt. Successful aggregate verification can recover an automatic review that failed only at `wait-for-ci`. Snapshot publication's conclusion does not authorize or veto recovery. The normal review path still starts as soon as verification succeeds; the recovery listener runs when the workflow completes.

Recovery reruns the original failed `wait-for-ci` job and its dependent jobs. It does not dispatch a new review or retry CI. Before that API write, it resolves eligibility again: current PR/head/attempt, review activity, posted reviews, bot eligibility, and `AUTOMATED_REVIEW_ROUNDS` (default 3). Successful ancestor outputs retained by GitHub job reruns do not substitute for these fresh checks. Active or completed reviews, same-head reviews, exhausted limits, forks, stale events, and failures in a provider or publisher are skipped with a reason in the workflow log and summary. Manual `workflow_dispatch` review runs remain outside automatic recovery.

The listener also handles automatic-review completion: if CI finished while the original waiter was still failing, that later completion reconciles the successful CI attempt. A failed gate that started after successful verification cannot be recovered again from the same success. Recovery events serialize by head without cancelling an in-flight recovery; the original review retains its PR concurrency, provider selection, and posting safeguards.

The recovery job executes only the default-branch script, with `actions: write` for the rerun API and read access to contents and pull requests. It checks out no PR code, downloads no artifacts, persists no credentials, and has no model secrets. Existing provider jobs remain read-only, and only the separate trusted publisher can write review findings.

**Validation limit:** GitHub loads `workflow_run` listeners from the default branch. A PR changing this listener cannot exercise its new trigger before merge. Local mocked API histories execute the recovery helper and the workflow entry script, including failure→success, changing caps/reviews, stale heads/attempts, duplicates, and completion ordering. They do not prove delivery of a live GitHub event.

**Post-merge observation:** use a dedicated same-repository draft PR against `main`, never a shared PR or a main-branch run. On its next genuine CI failure (or deliberately cancel only that disposable PR's CI run), wait for the original review's `wait-for-ci` to fail. Record the PR head, CI run/attempt, and review run/attempt. Retry that CI run with `gh run rerun <ci-run-id> --failed`; do not push or restart review. After successful verification and CI completion, check the **Recover Automated Review** summary: it must identify that CI attempt and the original review run/job. Confirm the original review has a new attempt, the selected provider alone runs, and exactly one automated review is posted on the unchanged head. Re-run the recovery listener once through GitHub's **Re-run jobs** control: it must explain an active/completed-review skip without another model job or review. Record the run URLs and close the disposable PR without merging. If the CI retry fails again, recovery must remain skipped; do not weaken a test to manufacture success.

### Release and Nightly failure reporting

`report-workflow-failure.yml` listens for completed Release and Nightly failures and files `area-ci` issues with failed-job/step metadata and bounded sanitized diagnostics. It reads the exact failed attempt, so a later retry does not erase the original failure. Success, cancellation, intentional skips, and unrelated workflows do not create reports. Verification, publishing, finalization, and setup remain distinct in occurrence context.

A recognized test and its error diagnostic can match across both workflows. Existing open reports receive deduplicated occurrence comments; failures recurring after closure create linked issues. A shared queued concurrency group serializes all issue writes, and durable issue/comment markers support retry after partial API writes. Missing logs still produce metadata reports; reporter failures surface in its own Actions job and summary without changing or retrying the source workflow.

The listener executes trusted default-branch code with Actions-read, contents-read, and issue-write permissions. It does not use publishing credentials or depend on issue-intake being triggered. See [failure reporting](../failure-reporting.md) for matching examples, redaction, limits, marker maintenance, and manual recovery. Scheduled cross-CI pattern detection remains separate in #205.

**Validation limit:** GitHub activates this completion listener only after merge to the default branch. Local fixtures execute the reporting helper and workflow entrypoint, including the original Release incident, Nightly failures, deduplication, partial writes, and concurrent queued deliveries. Observe the first genuine eligible failure after merge and confirm its report; do not deliberately break or rerun a publishing workflow for this check.
