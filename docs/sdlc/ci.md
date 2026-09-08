# Continuous integration

`.github/workflows/ci.yml` runs on pull requests to `main` or `develop`, pushes to those branches, and manual dispatch.

Verification runs in three parallel jobs on GitHub-hosted Ubuntu with the current Node LTS:

- Two Vitest shards each install dependencies, build the server, and run `npm test -- --shard=N/2 --maxWorkers=4`.
- The build/package job runs typechecking, Node unit tests, the full application build, packaged CLI tests, and release-package dry-run packing.

The required check keeps its name, **Unit, build, E2E, and package**. It succeeds only when the build/package job and both Vitest shards succeed. The snapshot job still waits for this aggregate check and retains its existing publication conditions. The separate browser `test:e2e` suite is not part of this workflow.

The Vitest sequencer assigns discovered tests to shards by measured duration using `.github/test-durations.json`. New files receive the median known duration and are always included; deleted files are ignored. The manifest affects balancing only, never discovery. Refreshing its durations can improve balance as the suite changes. Ordinary `npm test` still runs every suite without sharding.

The push-only `.github/workflows/ci-benchmark.yml` workflow runs controlled experiments on `bench/156-*` branches. It uses a fixed application baseline, records failures and resource usage, and performs publication experiments only as dry runs. Reproduction instructions and retained results are in [the issue 156 benchmark report](../benchmarks/ci-performance-156.md). Automated review remains enabled throughout.

Both Codex and Claude automated review wait for the **Unit, build, E2E, and package** verification job in the `ci.yml` pull-request run for the exact head SHA. The selected provider starts only when that job succeeds, while npm snapshot publication can continue independently. Failed, timed-out, cancelled, skipped or inconclusive verification blocks the model job. Standalone CI context collection still reports verification's actual conclusion and failed verification jobs; individual completed-job logs avoid waiting for the whole workflow archive. Missing or unfinished verification stays pending until the bounded wait expires, and ambiguous jobs or job-query errors fail the wait. The context-fetch step rechecks success immediately before model work, so a same-SHA rerun cannot turn a prior successful wait into permission to review a pending or failed build. The wait and both context-fetch scripts still execute from the trusted base checkout. The required CI check and the publication gate are unchanged.

The worker-wait tests are split into three scenario suites with a shared fixture, so the longest indivisible suite no longer constrains shard balance. Case-preservation evidence, the refreshed duration weights and comparative benchmark results are in the [shard-balance report](../benchmarks/shard-balance.md).
