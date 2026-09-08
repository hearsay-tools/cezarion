# CI performance experiment #156

Application baseline: `b1fe75911378dfe7816a7a83312c2acbdcf848f4` (`origin/main`, fetched 2026-09-08). Work began in Cezar's fresh linked worktree at that exact commit. The Blacksmith branch is not an input.

## Method

`.github/workflows/ci-benchmark.yml` runs when a branch matching `bench/156-*` is pushed. It checks out the harness commit and the fixed application separately. `campaign.json` enumerates individual variant/repetition pairs, interleaved by repetition. Every verification job uses GitHub-hosted `ubuntu-24.04`, Node `24.20.0`, the same lockfile and a new private npm cache. There is no setup-node dependency cache. Actual runner image, CPU model/count, Node/npm/Vitest versions and lock hash travel with each result.

The verification sequence is `npm ci`, `npm run typecheck`, `npm run test:unit`, `npm test`, `npm run build`, `npm run test:package`. Vitest uses the default and JSON reporters, identically across variants. Its JSON report retains every scenario's name, status and duration; the console log retains import/environment totals. No browser suite is added. A failing step stays failed and stops dependent work; its log and metrics upload with `always()`.

GNU time records elapsed, user CPU seconds, system CPU seconds and maximum child RSS for each command, including waited-for subprocess resource usage. **Maximum child RSS is the largest process high-water mark, not simultaneous aggregate worker memory.** Aggregate CPU seconds divided by elapsed seconds expresses used CPU cores; divide by recorded available CPUs for allocation utilization. Do not infer CPU utilization from wall time alone. Queue time and Actions checkout/setup/upload steps come from the job/step API, separately from measured commands. Aggregate runner time sums job durations, including extra shard/snapshot jobs. Comparisons include failures and all retries.

Normal CI uses `ubuntu-latest`, a floating LTS Node version and an npm cache; this campaign freezes image label and Node and uses cold npm caches. This improves internal comparability but means campaign absolute timings are not historical CI timings. Image versions may change beneath the pinned label; record and disclose this if it happens.

## Experiments

- Worker counts: installed Vitest default versus explicit 4, 6 and 8 workers. The installed Vitest 4.1.10 `resolveMaxWorkers` uses `availableParallelism() - 1` in run mode; retain the installed source excerpt with metadata.
- Fixtures: a baseline patch removes only incidental waits. Preserve the interactive dry-run mock and real transport/cancellation/race timing coverage.
- Splitting: split the three named large suites, retaining every scenario and both parity matrices, without concurrent tests.
- Shards: balance whole files using baseline durations, independently from splitting; account for all setup and runner time.
- Setup: eligible pure web utilities use Node; all other environments and server home/temp cleanup remain intact.
- Duplicate work: reuse the server build already produced by pretypecheck. Separately compare fresh snapshot install/build with transfer of verified dependencies/builds. Snapshot publication is always `--dry-run`; no registry writes or PR comments occur.
- Combined: repeat only supported winning variants together, then re-run the normal complete gate on the final source.

## Reproduction and evidence

1. Check out the desired harness SHA and inspect `campaign.json` and the experiment patch.
2. Push it to a unique `bench/156-<campaign>` branch in this repository. This requires normal repository Actions permissions; it never changes main.
3. Download `benchmark-*` artifacts from that run. Preserve `metadata.json`, `summary.json`, per-step JSON/time/log files, and `vitest.json`.
4. Retrieve `gh api repos/hearsay-tools/cezarion/actions/runs/<id>/jobs --paginate` for job/step durations and status, and the run object for queue timestamps.
5. Report medians and ranges across all three repetitions. Keep failed runs separate from successful duration summaries, never silently omit them.

Automated review remains enabled. Experiment refs have no PR and therefore do not trigger the normal pull-request review workflow. The final draft PR must have a completed review against its final head SHA, in addition to final green CI.

## Results

The campaign is in progress. No performance conclusion has been drawn yet.
