# Why the Node floor jobs take longer

The main cause is growth in expensive integration coverage. The floor runs the full unit inventory on two jobs, while current LTS uses three. I found no evidence that Node 24.15 itself is the main cause.

We added 4,720 Vitest cases between the two endpoint runs: 14,382 on 6 October and 19,102 on 24 October, a 33% increase. Files grew from 624 to 838, a 34% increase. The longest floor job grew from 11m30s to 18m16s, a 59% increase. These are observed runs, not a controlled benchmark.

Keep the regression coverage. Some tests should run at a cheaper layer, and some work need not run on both Node versions. I would first test a third floor shard, then reduce repeated process setup and text permutations in the slow matrices. I would not delete runner parity coverage to meet a time limit.

## Evidence and limits

Source revision: `e2882a245c449ff0960458a8e4ab8f47889e4373`. I inspected 20 successful `push` runs on `main`, 40 floor job logs, the three current-LTS job logs from the latest sample, and floor measurement artifacts where available. The sample has two runs on each selected date, except 24 October, which has six. It is a trend sample, not a random sample or a failure-rate study.

Job time means GitHub's `started_at` to `completed_at`. It excludes queue time. The table uses the longest floor job in each run, then takes the median for that date. Counts include skipped cases. The latest endpoint has 19,100 passed and two skipped cases. The 6 October endpoint has 14,380 passed and two skipped cases.

| Date, 2026 | Runs | Vitest files | Vitest cases | Median longest floor job |
| --- | ---: | ---: | ---: | ---: |
| 6 October | 2 | 624 | 14,377–14,382 | 11m11s |
| 11 October | 2 | 670 | 15,254–15,274 | 15m17s |
| 13 October | 2 | 678–681 | 15,507–15,550 | 12m54s |
| 16 October | 2 | 718 | 16,255 | 13m56s |
| 19 October | 2 | 738–739 | 16,909–16,924 | 14m21s |
| 21 October | 2 | 786–787 | 17,982–18,004 | 17m39s |
| 23 October | 2 | 837–840 | 19,028–19,149 | 18m08s |
| 24 October | 6 | 837–838 | 19,028–19,102 | 18m39s |

The trend has host variation and changes in shard allocation. It is not a steady increase on every run. Run `38460026183` reached attempt 4; the sample uses its latest successful job records. It is not a clean first-attempt benchmark.

The endpoint runs are [37538571501](https://github.com/hearsay-tools/cezarion/actions/runs/37538571501) and [40099749213](https://github.com/hearsay-tools/cezarion/actions/runs/40099749213). The full run inventory is in the [evidence file](2026-10-24-node-floor-evidence.json).

## Where the increase comes from

The table below sums Vitest's passed per-file durations across both floor jobs. These are concurrent module durations. They show where the work sits, but they are not elapsed pipeline time or billed CPU time. Values use the two endpoint runs above.

| Suite group | Cases, 6 October → 24 October | Summed module seconds, 6 October → 24 October | Share of the increase |
| --- | ---: | ---: | ---: |
| Waits parity | 0 → 656 | 0 → 1,175.6 | 39.6% |
| Harness parity | 576 → 678 | 451.8 → 528.2 | 2.6% |
| CI failure parity | 0 → 48 | 0 → 127.8 | 4.3% |
| Other parity | 541 → 822 | 538.6 → 1,035.1 | 16.7% |
| Monitoring turn and channel matrices | 331 → 283 | 471.9 → 573.2 | 3.4% |
| All other tests | 12,934 → 16,615 | 1,946.1 → 2,934.2 | 33.3% |
| **Total** | **14,382 → 19,102** | **3,408.4 → 6,374.2** | **100%** |

Parity tests explain about 63% of the observed increase in summed module time. The new waits matrix alone explains about 40%. The wait-list work began with [hearsay-tools/cezarion#1240](https://github.com/hearsay-tools/cezarion/pull/1240) and then added recovery, worker, human-question, process and completion paths. This is new coverage for new behavior.

The number of parity files also grew because large files were split. A split does not by itself mean duplicated coverage. I grouped the old harness file and its current per-runner files together. In the latest floor artifacts, all 838 project/file keys are unique.

The 58 files named `*-parity.test.ts` contain 2,204 cases and use 45% of summed module time. Add the two monitoring matrices and the total is 2,487 cases, or 13% of cases, using 54% of module time. Most of the remaining tests are cheap.

These are the largest individual files in the latest sample:

| File | Cases | Module time |
| --- | ---: | ---: |
| `workflows/monitoring-turn.test.ts` | 222 | 354.5s |
| `workflows/monitoring-channel-order.test.ts` | 61 | 218.7s |
| `core/harness-claude-parity.test.ts` | 107 | 206.6s |
| `workflows/run.test.ts` | 170 | 193.7s |
| `workflows/worker-parent-attention.test.ts` | 85 | 193.1s |
| `workflows/waits-claude-workers-parity.test.ts` | 37 | 187.3s |

Paths in this table are under `packages/cezar/src/`. The ten slowest files use about 31% of total module time.

The cost follows the test design. The [worker-wait fixture](../../packages/cezar/src/workflows/worker-wait.testkit.ts) creates a Git repository, commits a base, opens a real SQLite store and creates a manager before each case. Cases then start native mock processes, create worktrees and exercise delivery or recovery. Cleanup waits for process termination and durable work. These are integration tests inside the command called the unit suite.

Test count alone therefore misses the change in cost. Summed module time rose 87%, while cases rose 33%. The larger integration matrices are a material cause. Host variation and changes to existing tests also affect those totals; this comparison does not isolate every cause.

## Why the floor finishes after LTS

The latest sampled commit ran the same 838 files and 19,102 cases on both Node versions:

| Measurement | Node 24.15.0 floor | Node 24.21.0 LTS |
| --- | ---: | ---: |
| Jobs × Vitest workers | 2 × 4 | 3 × 4 |
| Summed module time | 6,374.2s | 6,591.6s |
| Longest Vitest step | 17m45s | 12m07s |
| Longest job | 18m16s | 12m30s |

For matched files taking at least one second on LTS, the median floor/LTS duration ratio was 0.97. This is one source-matched comparison on different hosts. It does not prove that the runtimes perform identically. It gives no support for blaming a general Node 24.15 slowdown.

Floor shard 1 also runs typecheck and `npm run test:unit`. In this run they cost 11s and 124s. The latter has 125 package tests, taking about 103s, followed by 820 script tests, taking about 21s. At the older endpoint, the same command had 75 package tests and 532 script tests and took 77s overall. This is a secondary source of growth.

Dependency installation took 2–3s in the latest pair. Node setup took 7–9s. There was no setup retry in the 40 sampled floor jobs. Setup is not the main cause in this sample. Earlier stalled downloads are a separate known failure mode, covered by [hearsay-tools/cezarion#1215](https://github.com/hearsay-tools/cezarion/pull/1215).

The floor artifacts report four available CPUs, four workers and four peak active modules per job. I found no sign that these jobs had silently become single-worker runs.

## What today's balancing change did

[hearsay-tools/cezarion#1595](https://github.com/hearsay-tools/cezarion/pull/1595), commit `57fdde722`, added floor-specific weights. It reserves 155 seconds for shard 1's fixed work before it assigns Vitest files. It also raised the job limit from 20 to 30 minutes. It did not remove tests or add workers.

The four sampled main runs after that change had longest floor jobs of 19m33s, 18m30s, 18m47s and 18m16s. The two earlier samples that morning were 19m45s and 17m54s. These small samples do not establish a clear speed improvement.

The allocator is making the intended reservation. In the latest run it assigned about 2,734 seconds of historical module weight to shard 1 and 3,354 to shard 2. Their difference is the 155-second fixed reservation multiplied by four workers. Actual module times were about 2,547 and 3,828 seconds. Host variation and changed test costs still move the result away from the historical weights.

The higher limit gives the job room to finish. It does not reduce its work.

## Do we need all these tests?

We need the guarantees. We do not need every permutation at the same expensive layer, or every version-independent check on both Node versions. This investigation does not prove that a large group can be deleted safely.

**Keep native-wire parity and durable recovery coverage.** Start, Continue and recovery have separate construction paths. Runner input and completion behavior differ by transport. The repository requires shared coverage because past regressions affected only one runner or one construction path. Keep the cells required by [AGENT_PROTOCOL.md](../../AGENT_PROTOCOL.md) and [ADR 0020](../../docs/adr/0020-normalize-logical-runner-sessions.md). Keep committed-row checks for crashes and wake charges. Replacing these with one mocked manager test would lose a useful guarantee.

**Reduce repeated text permutations at the process layer.** In [monitoring-turn.test.ts](../../packages/cezar/src/workflows/monitoring-turn.test.ts), M2, M3, M6 and M20 send many question, review, quoted and example forms through every runner and both fresh and continuation paths. M2 and M3 now explicitly state that prose is not read. Keep each parity criterion and a representative native-wire case. Review whether the remaining text forms can move to direct parsing or turn-policy tests. The M2/M3/M6/M11/M12/M20 cells use about 138 seconds of case time in the latest artifacts. That is the cost under review, not a promised saving; core cases must remain.

**Keep failure assertions, but avoid paying full production deadlines where possible.** Codex R17 takes about 60 seconds to prove that provider retries stop. OpenCode S20 takes about 30 seconds to report a missing executable. Check whether an injected clock can cover the retry budget while preserving native-wire evidence. Investigate why a known missing executable waits for startup expiry. Do not remove either assertion or shorten product safety timers just to make CI green.

**Treat duplicate Node-version coverage as a policy choice.** The complete suite runs once on current LTS and once on the floor. This deliberately checks compatibility. A smaller floor gate could keep SQLite, process, filesystem, CLI and runner compatibility tests while LTS runs the full suite. That would weaken the claim from “the full suite passes at the floor” to “selected compatibility tests pass at the floor.” It needs an explicit coverage inventory and a rule for new Node APIs. I would not make this the first change.

Removing only cockpit unit tests from the floor has limited value. In the latest pair they use 313 seconds, less than 5% of module time. Contract and API-client module time totals less than one second. Removing cheap tests does not address the main cost.

## Recommended order

1. **Benchmark three floor shards with four workers each.** Keep all coverage and the fixed-work reservation. This gives the floor the same parallel capacity as LTS and reduces average Vitest work per job by one third. The latest LTS result suggests that roughly 12-minute jobs are plausible, but that is not a measured floor forecast. More jobs also add setup and runner consumption.
2. **Reduce the cost of monitoring and wait fixtures.** Start with repeated text forms and unnecessary process restarts. Keep each parity criterion, fresh/Continue/recovery distinctions and real durability boundaries. Prove any changed regression still fails without its source fix.
3. **Remove avoidable waits in failure tests.** Retain the behavior checks. Measure the gain separately from shard changes.
4. **Then decide whether full duplicate Node-version coverage is worth its cost.** Moving typecheck off the floor saves only 11–20 seconds in this sample. Dropping browser-facing units saves little compared with the runner matrices. Neither should lead the work.

No source, test or CI behavior changed during this investigation. I did not run a new test suite or dispatch a benchmark. The findings use recorded CI passes and source inspection. I encountered no Squeal friction that requires an issue.

Validation checked the extracted counts, suite totals, evidence JSON and all local report links. Squeal returned on quiet at revision 2: the report edits changed no test inputs and there were no known failures. It had 129 unknown test files, including 84 slow files not run at that revision. This is not a claim of a new full-suite pass.
