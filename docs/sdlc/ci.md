# Continuous integration

`.github/workflows/ci.yml` runs on pull requests to `main` or `develop`, pushes to those branches, and manual dispatch.

Verification runs in three parallel jobs on GitHub-hosted Ubuntu with the current Node LTS:

- Two Vitest shards each install dependencies, build the server, and run `npm test -- --shard=N/2 --maxWorkers=4`.
- The build/package job runs typechecking, Node unit tests, the full application build, packaged CLI tests, and release-package dry-run packing.

The required check keeps its name, **Unit, build, E2E, and package**. It succeeds only when the build/package job and both Vitest shards succeed. The snapshot job still waits for this aggregate check and retains its existing publication conditions. The separate browser `test:e2e` suite is not part of this workflow.

The Vitest sequencer assigns discovered tests to shards by measured duration using `.github/test-durations.json`. New files receive the median known duration and are always included; deleted files are ignored. The manifest affects balancing only, never discovery. Refreshing its durations can improve balance as the suite changes. Ordinary `npm test` still runs every suite without sharding.

The push-only `.github/workflows/ci-benchmark.yml` workflow runs controlled experiments on `bench/156-*` branches. It uses a fixed application baseline, records failures and resource usage, and performs publication experiments only as dry runs. Reproduction instructions and retained results are in [the issue 156 benchmark report](../benchmarks/ci-performance-156.md). Automated review remains enabled throughout.
