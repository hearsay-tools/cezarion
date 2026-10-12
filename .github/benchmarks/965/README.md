# Vitest timeout investigation and shard rebalance

Source repository: `hearsay-tools/cezarion`. This investigation addresses
[hearsay-tools/cezarion#965](https://github.com/hearsay-tools/cezarion/issues/965).
All run links below belong to that repository.

## When the slowdown appeared

Inspected 80 main-branch CI runs spanning October 3–12, 2026. Short cancellations
caused by newer pushes are distinct from the job exhausting its timeout.

| Main CI run | Shard 1 job wall time | Observation |
| --- | --- | --- |
| [37153470053, October 3](https://github.com/hearsay-tools/cezarion/actions/runs/37153470053) | 6m20s | Harness parity: 383 tests, 353,863 ms |
| [37426488423, October 6](https://github.com/hearsay-tools/cezarion/actions/runs/37426488423) | 8m56s | Growing shared runner coverage |
| [37938021984, October 9](https://github.com/hearsay-tools/cezarion/actions/runs/37938021984) | 11m27s | Harness parity: 593 tests, 565,647 ms; monitoring-turn on shard 2 |
| [37949887639, October 9](https://github.com/hearsay-tools/cezarion/actions/runs/37949887639) | 14m00s | After hearsay-tools/cezarion#939: monitoring-turn moved to shard 1 |
| [38159926317, October 11, 17:30 UTC](https://github.com/hearsay-tools/cezarion/actions/runs/38159926317) | 15m12s, cancelled | First observed main timeout in this sample |
| [38176546350, October 11](https://github.com/hearsay-tools/cezarion/actions/runs/38176546350) | 14m08s | Successful shard; 822.79s Vitest wall time |

The first observed timeout followed the pnpm migration, but setup does not explain
the slowdown: dependency installation took only 2 seconds, and the server build
4 seconds. Vitest itself ran for 892 seconds before cancellation. This cancelled
run also logged a 5-second test timeout; it is not evidence that every test passed.

## What changed

The harness matrix grew from five runners to six when OMP landed in
[commit c347058e](https://github.com/hearsay-tools/cezarion/commit/c347058ee81ff18c270c771012a11b5e02943eff)
and gained more lifecycle cells. Its main test file grew from 383 tests taking
353,863 ms on October 3 to 593 taking 622,850 ms on October 11. This file cannot
be divided by Vitest's file-level sharding.

The duration manifest was last refreshed on September 9, in commit `d424bea4`
([hearsay-tools/cezarion#161](https://github.com/hearsay-tools/cezarion/pull/161)).
It still estimated the harness file at 111,057 ms. Of the 670 currently measured
files, 295 had no estimate and received the allocator's median fallback weight.

[hearsay-tools/cezarion#939](https://github.com/hearsay-tools/cezarion/pull/939)
added `conversation-answer-delivery.test.ts`. The allocator is deterministic, but
adding a file can alter subsequent bin choices. The existing 270-test
`monitoring-turn.test.ts` moved from shard 2 (462,940 ms) to shard 1 (464,355 ms).
The change did not add those 270 tests; it placed two long suites together.

## Candidate and measurement provenance

Refresh weights from passed file summaries in both successful Vitest shards of
runs [38074645503](https://github.com/hearsay-tools/cezarion/actions/runs/38074645503),
[38150621206](https://github.com/hearsay-tools/cezarion/actions/runs/38150621206), and
[38176546350](https://github.com/hearsay-tools/cezarion/actions/runs/38176546350).
These are three observations on different main commits, not controlled repetitions
of one commit. Use the median per file; files introduced later use the available
observations. The manifest records the exact run, job and Git SHA for each input.

All six jobs ran on GitHub-hosted Ubuntu 24.04 with four workers. Obtain a source
log with `gh run view <run> --repo hearsay-tools/cezarion --job <job> --log`.
Strip ANSI escapes, take only passed file summary lines, and resolve project names
`server`, `web`, `contract`, and `api-client` to their workspace paths. File summary
milliseconds measure test work, not import/setup time or whole-job wall time.

Replay the unchanged `assignShards` allocator with the sequencer's actual
`project-name + NUL + repo-relative-path` keys. Path-only keys produce different
fallback tie breaks and do not reproduce the old shard assignment.

| Weights / shard count | Observed median test-work sums, milliseconds |
| --- | --- |
| Old / 2 | 2,897,257 / 2,117,227 |
| Refreshed / 2 | 2,507,240 / 2,507,244 |
| Refreshed / 3 | 1,671,498 / 1,671,493 / 1,671,493 |

A four-worker replay using Vitest's cold-cache project/file-size ordering and
1 second of overhead per file estimates test wall times of 711 / 734 seconds for
two refreshed shards, versus 624 / 603 / 485 seconds for three. That model roughly
reproduces the old jobs (808 / 623 seconds), but is not a substitute for runner
measurements. It omits contention and runtime variance.

Use three refreshed Vitest shards, keeping the 15-minute job timeout and all
coverage. The two longest files land in different shards. The Node-floor jobs
remain two shards with their existing 20-minute bound; they share the refreshed
weights. The aggregate already depends on the Vitest job family, so it covers
all three matrix entries without a new required-check name.

The acceptance threshold is **11m15s whole-job wall time**, leaving 25% of the
15-minute timeout unused. Validate the candidate by dispatching CI at its branch:
a workflow-only PR uses the trusted base workflow, and the infra-only classifier
normally skips Vitest, so that PR run alone cannot validate the new matrix.

## Candidate runner validation

Pending a GitHub Actions dispatch at the candidate commit. Record each shard's
job duration, test-file count, test count and conclusion here before claiming
the headroom criterion is met.
