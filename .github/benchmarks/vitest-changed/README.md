# Advisory changed-selection pilot

This is a bounded experiment, separate from required CI. Push the harness to
`bench/vitest-changed-ae1a5042` to run five frozen application commits, each on
four GitHub-hosted Ubuntu shards. No main, PR, schedule or publishing trigger
exists. Do not merge this workflow to enable selective verification.

Each job installs and builds one application snapshot, computes a candidate
selection, then executes both full and selective modes on that exact source.
Two shards run full first and two run selective first for each case. Both use
Node 24.22.1, four workers, V8 coverage and the application's own sequencer.
Coverage.changed is explicitly false in both modes. Coverage is partial when
tests are omitted and is never published under the canonical CI artifact name.
The extra JSON reporter and output paths are equal instrumentation in both modes.

The candidate reuses the snapshot's local selector fallbacks. It always adds the
unit tests with explicit filesystem dependencies in the snapshot's Squeal inputs,
plus known source-reading invariant tests. It does not require a Squeal daemon.
An empty graph falls back before mandatory tests are added. This is an experiment,
not a claim that every runtime dependency is now modeled. Required CI is unchanged.

Evidence includes exact source/base SHAs, lock hash, machine/Node details, local
fallback, graph and mandatory file lists, allocation for each shard, actual JSON
results, test logs, GNU time and both coverage reports. Inventory mismatch fails
the job. A test failure remains a failure and the second mode still runs. The
workflow uploads partial evidence after failures and times out bounded commands.

Count selection time once per candidate shard when comparing test-command cost.
Installation and build run once per paired job and are shared, so do not call the
paired job total the cost of either independent mode. Record both execution orders;
one repetition per head cannot eliminate cache, runner or flaky-test effects.
Compare net summed command time and the longest Vitest command separately from
whole-PR latency. Browser optimization is independent of this experiment.
