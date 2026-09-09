# Optimized shard weights experiment

User-approved follow-up to #156 / merged #157. Fixed baseline: `76429dcfbd0449ad5e09c116d7abb64bc2730b2c`.

Compare unchanged shard weights with median optimized suite durations from both shards in all three repetitions of run 34276216531. Only `.github/test-durations.json` changes in the candidate application. Three repetitions each, two shards, four workers, GitHub-hosted Ubuntu 24.04, Node 24.20.0, separate cold npm caches; failures are retained. The existing measurement collector records wall time, child CPU/RSS, per-suite results and inventory.

Push this harness to `bench/156-rebalance-*` to reproduce. Ordinary CI and production weights remain unchanged until improvement is demonstrated. Compare each repetition's maximum shard job duration, sum of runner time, failures and complete test inventory. The unchanged non-Vitest job is outside this comparison.

The training data suggest a limit: worker-wait.test.ts has a median suite duration of 185.943 seconds, almost the entire slower shard. Refreshed weights alone cannot split that file. A more even total suite-duration sum is not sufficient evidence of lower elapsed time.
