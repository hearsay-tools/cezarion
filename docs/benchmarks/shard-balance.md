# Vitest shard-balance follow-up

Application baseline: `76429dcfbd0449ad5e09c116d7abb64bc2730b2c`, after PR #157 merged. This follow-up asks whether refreshed duration weights alone improve the existing two shards, and whether splitting the single worker-wait suite into three files produces a useful balance. It does not re-evaluate the broader suite-splitting experiment from issue #156.

## Method

Both campaigns ran on GitHub-hosted `ubuntu-24.04` with four available CPUs, Node 24.20.0, npm 11.19.0, Vitest 4.1.10, and a new private npm cache per job. Runner image versions were `20260831.293.1` and, in the second campaign, `20260907.300.1`. CPU models varied among AMD EPYC 7763, AMD EPYC 9V74, Intel Xeon 6973P-C and Intel Xeon Platinum 8370C, so absolute cross-job differences include host variation. Each shard ran with `--maxWorkers=4`; install and `build:server` preceded Vitest and are retained in the artifacts.

| Campaign | Harness SHA | Actions run |
| --- | --- | --- |
| Refreshed weights | `10537178e0ae7b969a037138a0f48e5d59726976` | [34280813637](https://github.com/hearsay-tools/cezarion/actions/runs/34280813637) |
| Worker-wait split and refreshed weights | `75702a7355f33cb3f079a02c66fd167313eb8628` | [34281539246](https://github.com/hearsay-tools/cezarion/actions/runs/34281539246) |

The first campaign refreshes whole-file weights from median suite durations across both optimized shards in all three repetitions of run [34276216531](https://github.com/hearsay-tools/cezarion/actions/runs/34276216531). The second retains those whole-file weights for unsplit suites, but derives the three new worker-wait partition weights by summing matched per-case JSON durations from the original suite in each repetition and taking the resulting medians. Those partition weights are approximately 41, 71 and 74 seconds. The original worker-wait suite's 105 cases are preserved across the three files as 28, 35 and 42 cases; an independent AST review found all 66 declarations, 12 helpers and fixture hooks accounted for, and the targeted 105 cases passed. The hosted JSON inventories independently contain all 7,803 cases in every layout: the control has 374 files split 187/187, while the candidate has 376 files split 187/189.

Metrics below come from GNU time and GitHub's jobs API. Vitest and verification cells are medians `[min–max]` over successful jobs only. CPU is user plus system seconds. Peak RSS is the largest child-process high-water mark in KiB, not aggregate concurrent memory. A pair is complete only when both shards for the same repetition pass; pair-level critical path, total runner consumption, CPU and RSS exclude partial failed pairs.

## Per-shard results

| Run | Layout and shard | S/F | Verification | Vitest | CPU | Peak RSS | Runner |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 34280813637 | current 1 | 2/1 | 191.35 `[190.75–191.95]` | 188.66 `[188.15–189.16]` | 466.98 `[466.60–467.37]` | 672,108 `[654,592–689,624]` | 216.5 `[214–219]` |
| 34280813637 | current 2 | 2/1 | 157.39 `[145.19–169.58]` | 155.26 `[143.46–167.05]` | 439.94 `[344.84–535.04]` | 684,770 `[659,724–709,816]` | 176 `[163–189]` |
| 34280813637 | refreshed 1 | 3/0 | 192.72 `[189.13–197.09]` | 190.23 `[187.08–194.39]` | 530.52 `[392.22–533.71]` | 660,224 `[655,852–685,748]` | 218 `[207–221]` |
| 34280813637 | refreshed 2 | 3/0 | 164.57 `[163.36–168.07]` | 161.70 `[160.78–165.55]` | 463.34 `[460.79–483.82]` | 658,260 `[652,376–689,980]` | 188 `[184–193]` |
| 34281539246 | current 1 | 3/0 | 191.88 `[189.60–194.74]` | 189.47 `[186.78–192.19]` | 456.60 `[454.72–465.15]` | 670,568 `[658,132–681,076]` | 214 `[214–214]` |
| 34281539246 | current 2 | 2/1 | 172.72 `[172.25–173.19]` | 169.89 `[169.49–170.28]` | 547.01 `[544.33–549.69]` | 671,862 `[660,344–683,380]` | 195.5 `[195–196]` |
| 34281539246 | split 1 | 2/1 | 172.57 `[171.45–173.68]` | 169.73 `[168.59–170.86]` | 537.86 `[534.13–541.58]` | 653,230 `[647,912–658,548]` | 192 `[190–194]` |
| 34281539246 | split 2 | 3/0 | 163.99 `[157.86–165.17]` | 160.90 `[155.40–162.62]` | 468.57 `[441.66–470.22]` | 677,796 `[660,060–689,780]` | 184 `[178–194]` |

## Complete-pair results

| Run/layout | Complete pairs | Critical Vitest | Critical runner | Total runner | Total CPU | Pair peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 34280813637 current | 1/3 | 189.16 | 214 | 377 | 812.21 | 709,816 |
| 34280813637 refreshed | 3/3 | 190.23 `[187.08–194.39]` | 218 `[207–221]` | 402 `[400–409]` | 991.31 `[876.04–997.05]` | 685,748 `[658,260–689,980]` |
| 34281539246 current | 2/3 | 189.49 `[186.78–192.19]` | 214 `[214–214]` | 409.5 `[409–410]` | 1006.95 `[999.05–1014.84]` | 682,228 `[681,076–683,380]` |
| 34281539246 split | 2/3 | 169.73 `[168.59–170.86]` | 194 `[194–194]` | 378 `[372–384]` | 993.80 `[983.24–1004.35]` | 674,920 `[660,060–689,780]` |

## Findings

Refreshed weights alone are rejected. The refreshed layout completed all three pairs, but its critical Vitest median was 190.23 seconds and its critical runner median was 218 seconds. The only complete current-layout control pair was 189.16 and 214 seconds. Per-shard medians likewise show no improvement to the approximately 190-second slow shard. The evidence does not support changing a stable manifest solely for newer weights.

The worker-wait split is supported by the clean pairs, with a limited sample. Its critical Vitest median was 169.73 seconds versus 189.49 for the same-campaign current layout, a 10.4% reduction. Critical runner duration fell from 214 to 194 seconds, while median total runner consumption fell from 409.5 to 378 seconds. Pair CPU and peak child RSS remained close. Each layout has only two complete pairs because one shard failed in the remaining repetition. Local candidate verification subsequently passed every gate, including the complete 376-file, 7,803-test Vitest inventory. The hosted failures remain part of the reliability evidence. These measurements and local checks support the tested split, but do not claim final PR or CI success.

## Failures

Four failures are preserved and excluded from successful medians:

- Run 34280813637, current shard 1 repetition 2: `fresh acknowledged input checkpoint remains primary over a later session error`; `waitFor` timed out.
- Run 34280813637, current shard 2 repetition 1: `parent cancellation proves live child termination while preserving another child review worktree`; the fixture read a partially written input file and `JSON.parse` raised `Unexpected end of JSON input`.
- Run 34281539246, current shard 2 repetition 3: `inserting a second template stacks it below the first, separated by a blank line`; the textarea value assertion failed.
- Run 34281539246, split shard 1 repetition 2: `coordinates two isolated backends, explicitly integrates a reviewed commit, and retries cleanup after restart`; the same fixture input read raised `Unexpected end of JSON input`.

The first campaign's failures occurred only in current controls; the second includes one failure in each layout. The split does not modify the failed GitHub textarea test or the delegation fixture that produced partial JSON. The campaign therefore retains them as reliability evidence without attributing them to shard assignment.

Raw artifacts are archived under `docs/benchmarks/shard-balance/raw/` by Actions run id: `34280813637.tar.gz` and `34281539246.tar.gz`. Each archive contains downloaded metadata, summaries, GNU time metrics, console and JSON test output, plus `jobs.json`, `run.json` and `aggregate.json` generated by the current repository summarizer.
