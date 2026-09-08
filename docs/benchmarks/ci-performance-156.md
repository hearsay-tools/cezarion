# CI performance experiment #156

Application baseline: `b1fe75911378dfe7816a7a83312c2acbdcf848f4` (`origin/main`, fetched 2026-09-08). Work began in Cezar's fresh linked worktree at that exact commit. The Blacksmith branch is not an input.

The individual campaigns support three changes: deterministic fixtures, Node environments for pure web tests, and two balanced Vitest shards with four workers each. Suite splitting, higher global worker counts, duplicate-build reuse and dependency/build transfer were rejected. The frozen combined candidate completed three hosted native-shard repetitions and three same-host paired comparisons. The merged source passed the complete local verification gate with the same four-worker limit used by CI; local timings are correctness checks, not performance measurements.

## Method

`.github/workflows/ci-benchmark.yml` runs when a branch matching `bench/156-*` is pushed. It checks out the harness commit and the fixed application separately. `campaign.json` enumerates individual variant/repetition pairs, interleaved by repetition. Every verification job uses GitHub-hosted `ubuntu-24.04`, Node `24.20.0`, the same lockfile and a new private npm cache. There is no setup-node dependency cache. Actual runner image, CPU model/count, Node/npm/Vitest versions and lock hash travel with each result.

The verification sequence is `npm ci`, `npm run typecheck`, `npm run test:unit`, `npm test`, `npm run build`, `npm run test:package`. Vitest uses the default and JSON reporters, identically across variants. Its JSON report retains every scenario's name, status and duration; the console log retains import/environment totals. No browser suite is added. A failing step stays failed and stops dependent work; its log and metrics upload with `always()`. The collector does not time the normal workflow's two unchanged `npm pack --dry-run --ignore-scripts` release-package checks or its small aggregate job.

GNU time records elapsed, user CPU seconds, system CPU seconds and maximum child RSS for each command, including waited-for subprocess resource usage. **Maximum child RSS is the largest process high-water mark, not simultaneous aggregate worker memory.** Aggregate CPU seconds divided by elapsed seconds expresses used CPU cores; divide by recorded available CPUs for allocation utilization. Do not infer CPU utilization from wall time alone. Queue time and Actions checkout/setup/upload steps come from the job/step API, separately from measured commands. Aggregate runner time sums job durations, including extra shard/snapshot jobs. Comparisons include failures and all retries.

Normal CI uses `ubuntu-latest`, a floating LTS Node version and an npm cache; this campaign freezes image label and Node and uses cold npm caches. This improves internal comparability but means campaign absolute timings are not historical CI timings. Image versions may change beneath the pinned label; record and disclose this if it happens.

| Campaign | Harness SHA | Actions run |
| --- | --- | --- |
| Worker counts and initial snapshot | `e4169465c53fc598926370e835f2721d3234a543` | [34272576293](https://github.com/hearsay-tools/cezarion/actions/runs/34272576293) |
| Setup and duplicate build | `ea8f7ffcc11477ec7d9d756a87424bd302cfa14b` | [34272909471](https://github.com/hearsay-tools/cezarion/actions/runs/34272909471) |
| Fixtures, splitting and shards | `4a7e1ead4a6bf992e95967c118b4339a03ab7680` | [34273853202](https://github.com/hearsay-tools/cezarion/actions/runs/34273853202) |
| Corrected snapshot | `4a7e1ead4a6bf992e95967c118b4339a03ab7680` | [34273855860](https://github.com/hearsay-tools/cezarion/actions/runs/34273855860) |
| Combined native shards | `2b07fd3fdd75100cc33253883bb97814c4c90a3d` | [34276216531](https://github.com/hearsay-tools/cezarion/actions/runs/34276216531) |
| Paired same-host control | `2b07fd3fdd75100cc33253883bb97814c4c90a3d` | [34276219162](https://github.com/hearsay-tools/cezarion/actions/runs/34276219162) |

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

For a fresh corrected snapshot reproduction, use the current harness containing the corrected snapshot collector, set `campaign.json` to three `baseline` jobs (repetitions 1, 2 and 3), and push a unique `bench/156-workers-*` ref. Those baseline jobs upload verified donors and the snapshot jobs in the same run consume the newly uploaded artifacts. Do not rerun the historical `e4169465c53fc598926370e835f2721d3234a543` harness for this purpose: its snapshot collector produced invalid `attempted:false` evidence. Run 34273855860 remains the original corrected evidence, but a reproduction must not depend on the expiring artifacts from run 34272576293.

Automated review remains enabled. Experiment refs have no PR and therefore do not trigger the normal pull-request review workflow. The final draft PR must have a completed review against its final head SHA, in addition to final green CI.

## Results

All times are seconds. Cells are median `[min–max]` over successful repetitions. “Verification” sums measured commands other than `npm ci`; runner time is the GitHub job's `started_at→completed_at` duration and includes checkout, setup and artifact handling. RSS is maximum child-process RSS in KiB, not aggregate concurrent memory. `S/F` is successful/failed repetitions; failures are shown separately and never enter the successful-run medians.

| Run | Variant | S/F | Verification | Vitest | CPU | Peak RSS | Runner |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 34272576293 | baseline | 3/0 | 447.81 `[445.48–450.79]` | 400.47 `[400.19–404.55]` | 1020.68 `[1016.69–1032.42]` | 1,426,076 `[1,390,236–1,439,828]` | 484 `[479–485]` |
| 34272576293 | workers-4 | 3/0 | 386.92 `[323.15–455.73]` | 341.13 `[286.67–401.57]` | 1101.54 `[721.42–1380.08]` | 1,400,864 `[1,390,256–1,490,868]` | 405 `[345–478]` |
| 34272576293 | workers-6 | 1/2 | 351.36 | 304.13 | 1203.79 | 1,392,336 | 371 |
| 34272576293 | workers-8 | 2/1 | 333.84 `[320.57–347.10]` | 287.63 `[275.47–299.79]` | 1216.06 `[1163.91–1268.21]` | 1,396,660 `[1,390,548–1,402,772]` | 354.5 `[339–370]` |
| 34272909471 | baseline | 3/0 | 461.93 `[421.06–465.83]` | 413.50 `[376.32–417.89]` | 1069.88 `[914.76–1092.80]` | 1,407,540 `[1,406,176–1,411,388]` | 484 `[440–484]` |
| 34272909471 | build-reuse | 3/0 | 458.70 `[452.40–463.85]` | 414.19 `[408.59–418.61]` | 1061.70 `[1043.14–1087.92]` | 1,397,432 `[1,392,768–1,428,040]` | 480 `[474–487]` |
| 34272909471 | setup | 3/0 | 428.82 `[402.99–439.81]` | 383.68 `[359.10–393.29]` | 963.40 `[850.22–1006.55]` | 1,403,532 `[1,398,444–1,449,884]` | 446 `[422–458]` |
| 34273853202 | baseline | 3/0 | 463.14 `[443.90–464.96]` | 415.37 `[398.21–416.45]` | 1080.65 `[1007.56–1084.17]` | 1,407,008 `[1,402,888–1,488,724]` | 484 `[464–488]` |
| 34273853202 | fixtures | 3/0 | 419.84 `[392.42–448.60]` | 375.34 `[353.23–402.37]` | 929.08 `[786.87–1043.11]` | 1,403,376 `[1,394,176–1,417,696]` | 440 `[416–469]` |
| 34273853202 | splitting | 2/1 | 450.21 `[444.48–455.94]` | 402.63 `[398.58–406.68]` | 1042.28 `[1023.15–1061.41]` | 1,415,786 `[1,413,620–1,417,952]` | 472.5 `[468–477]` |
| 34273853202 | shard 1 | 3/0 | 199.47 `[196.45–199.79]` | 196.91 `[194.06–197.35]` | 441.07 `[432.74–442.69]` | 687,716 `[657,876–689,472]` | 218 `[215–223]` |
| 34273853202 | shard 2 | 3/0 | 207.07 `[191.40–214.98]` | 204.66 `[188.88–211.84]` | 523.15 `[405.91–545.75]` | 683,848 `[650,232–692,028]` | 224 `[212–236]` |
| 34273853202 | non-Vitest gate | 3/0 | 39.06 `[36.91–46.62]` | — | 89.53 `[79.55–118.18]` | 1,420,140 `[1,390,188–1,482,776]` | 62 `[58–64]` |
| 34273855860 | snapshot fresh | 3/0 | 7.98 `[6.68–8.15]` | — | 31.68 `[24.58–32.33]` | 704,480 `[703,604–705,096]` | 30 `[29–38]` |
| 34273855860 | snapshot reuse | 3/0 | 2.54 `[2.23–2.81]` | — | 2.25 `[2.22–2.28]` | 130,240 `[129,952–131,144]` | 22 `[21–23]` |
| 34276216531 | baseline | 3/0 | 456.97 `[400.54–463.92]` | 410.24 `[364.00–416.20]` | 1058.12 `[663.34–1082.33]` | 1,406,964 `[1,403,532–1,428,672]` | 479 `[429–489]` |
| 34276216531 | combined shard 1 | 3/0 | 191.19 `[188.70–195.27]` | 188.60 `[185.96–192.54]` | 467.57 `[450.98–485.37]` | 668,860 `[660,060–677,196]` | 216 `[211–217]` |
| 34276216531 | combined shard 2 | 3/0 | 164.74 `[161.40–179.17]` | 162.24 `[158.92–176.16]` | 517.71 `[499.74–574.78]` | 668,228 `[654,344–685,160]` | 184 `[182–200]` |
| 34276216531 | combined non-Vitest gate | 3/0 | 47.71 `[34.82–48.51]` | — | 121.35 `[77.10–124.99]` | 1,401,348 `[1,394,596–1,405,320]` | 68 `[53–71]` |
| 34276219162 | paired baseline half | 3/0 | 401.57 `[378.05–458.69]` | 363.19 `[340.98–411.51]` | 810.35 `[684.01–1063.66]` | 1,410,132 `[1,377,872–1,422,332]` | — |
| 34276219162 | paired combined half | 3/0 | 325.13 `[314.77–377.74]` | 285.89 `[277.95–330.04]` | 818.59 `[674.56–1080.31]` | 1,403,420 `[1,389,160–1,405,580]` | — |

The first campaign's snapshot rows are omitted from the table because the snapshot command returned `attempted:false`; they measured preparation around a no-op. Their raw runner medians were 26 seconds fresh and 13 seconds reuse, but they are not selection evidence. Initial workflow queue time was 2 seconds for run 34272576293, 4 seconds for 34272909471, and 3 seconds for each corrected third campaign. Per-job scheduler wait is not exposed consistently, so it is not folded into verification.

### Worker count

The default uses three workers on these four-CPU allocations. Four workers completed all repetitions and improved median Vitest time from 400.47 to 341.13 seconds, but its 286.67–401.57 range nearly spans the baseline and its CPU range reflects different hosts. It is not selected as a standalone global change; four workers are instead held constant inside the balanced-shard candidate.

Measured Vitest CPU usage supports the original underutilization observation: aggregate child CPU time divided by elapsed time used a median 2.26 of four available cores at baseline (56.5%). Four, six and eight workers used median allocation shares of 72.0%, 88.9% and 95.4%. These resource calculations include all three completed Vitest commands per variant, including failed commands; higher utilization did not imply reliable verification.

Six and eight workers are rejected. Six workers failed two of three repetitions; eight failed one. Although all completed Vitest commands had medians of 304.13 `[302.07–316.04]` and 277.45 `[275.47–299.79]` respectively, throughput bought with a 33–67% failure rate is not a CI improvement. Successful-run CPU medians also rose from 1020.68 seconds at baseline to 1203.79 and 1216.06 seconds.

### Deterministic fixtures

Selected for the combined candidate. All three repetitions passed. Against the same campaign baseline, median verification fell 43.30 seconds (9.3%), Vitest fell 40.03 seconds (9.6%), runner duration fell 44 seconds, and CPU fell 151.57 seconds. The patch replaces incidental filesystem sleeps with filesystem release gates while retaining real process, cancellation, checkpoint and timer assertions. Correctness evidence covers the affected suites against the baseline and selected production mutations.

### Suite splitting

Rejected. The revised split preserves all 355 test names, shares parity definitions and worker fixtures through testkits, and passed local typecheck/review, but it adds seven collected files and 402 net test lines. On hosted runners, its two successful Vitest repetitions had a 402.63-second median, only 12.74 seconds (3.1%) below the same-campaign baseline, while one of three repetitions failed. That result does not justify the extra test topology.

### Pure-test setup

Selected for the combined candidate. Forty-four pure web utility suites use file-level Node environment annotations; React rendering, storage, document/window, WebSocket/EventSource, Notification, File, layout, focus and other browser tests remain in jsdom. All 1,167 affected tests passed locally and all three hosted repetitions passed. Against its same-campaign baseline, median verification fell 33.11 seconds (7.2%), Vitest fell 29.82 seconds (7.2%), runner duration fell 38 seconds, and CPU fell 106.48 seconds. No shared Vitest setup, server setup or production source changes.

### Duplicate builds

Rejected. Reusing the server artifact already produced by pretypecheck changed median verification from 461.93 to 458.70 seconds, a 3.23-second or 0.7% gain. Vitest was effectively unchanged (413.50 versus 414.19), runner duration improved four seconds, and ranges overlap. That saving does not support a more coupled build path.

### Dependency/build artifact transfer

Rejected. The initial donor baseline jobs spent 13–15 seconds creating the archive and 1–2 seconds uploading it, or 14–17 seconds before downstream use. In the corrected snapshot campaign, reuse reduced measured snapshot preparation by 5.44 seconds and job median by eight seconds (30 to 22). The downstream saving does not repay donor overhead, even before artifact download/storage cost and maintenance complexity.

### Balanced shards

Proposed for the combined candidate. The duration manifest is a disjoint, complete partition of 374 Vitest files into two 187-file bins. Both shards passed all three repetitions. Their Vitest medians were 196.91 and 204.66 seconds, and job medians were 218 and 224 seconds. The non-Vitest gate passed in a 62-second median. Per repetition, total runner consumption across both shards and the gate was 521, 506 and 485 seconds—near the roughly 480-second monolithic baseline—while the parallel critical path was 236, 224 and 215 seconds before the small aggregate check. This cuts feedback latency substantially without dropping verification; it redistributes nearly the same runner work across three jobs.

The proposed production workflow therefore keeps the existing required-check name as an aggregate job, runs typecheck/unit/build/package unchanged in one job, and runs two Vitest shards with four workers each. Snapshot publishing continues to depend on the aggregate, so every shard and the complete non-Vitest gate must pass first.

### Failures

Four measured repetitions failed, and none is counted as a successful median or silently retried:

- workers-6 repetition 1: `automations gate (#801) > background scheduler > starts once the flag is on, so the gate is the only thing holding it back`; scheduler `start` was expected once and observed zero times.
- workers-6 repetition 2: `opencode owned DONE before ACK closes only after acceptance without needing a phantom turn`; `waitFor` timed out.
- workers-8 repetition 3: `OpenCode durable input acknowledgements > fresh rejected agent POST fails without draining more accepted input`; `waitFor` timed out.
- splitting repetition 2: `opencode owned DONE before ACK closes only after acceptance without needing a phantom turn`; `waitFor` timed out.

The repeated OpenCode timeout under different variants warrants caution about contention, but these campaigns do not establish its cause and the selected fixture patch does not touch that test. No assertion was relaxed and every failure remains in the evidence.

### Final combined result

The frozen candidate at `2b07fd3fdd75100cc33253883bb97814c4c90a3d` completed all nine native-shard jobs and all six same-host paired halves successfully. In the native workflow, the slowest measured parallel job had a 216-second median `[211–217]`, versus 479 seconds `[429–489]` for the monolithic baseline: a 55% median reduction for the measured three-job graph. Total runner consumption per repetition was 464, 469 and 469 seconds, with a 469-second median, versus the baseline job's 479-second median. This comparison ends before the aggregate job and excludes queue, review, snapshot publishing and the normal workflow's two `npm pack` checks; it is not a full-workflow latency claim.

The paired campaign ran baseline and combined unsharded verification serially on the same allocated host and with separate caches. Repetitions 1 and 3 ran baseline first; repetition 2 ran combined first. Combined verification improved in every pair by 16.7–19.0%; its median was 325.13 seconds `[314.77–377.74]`, down from 401.57 `[378.05–458.69]`. Vitest improved in every pair by 18.5–21.3%, from a 363.19-second median `[340.98–411.51]` to 285.89 `[277.95–330.04]`. Median user/system CPU was 568.63/241.72 seconds for baseline and 572.51/246.08 for combined; total CPU and peak child RSS were correspondingly close. Each paired job took both halves together, so its shared runner duration, 753 seconds `[744–873]`, cannot be attributed to either variant and is omitted from the per-half table.

The performance measurements apply exactly to the frozen `2b07fd3f` candidate. The selected source was subsequently committed at `3b493ea9` and merged with `origin/main` commit `3a3baeae` in `ef9f2321`; a later correctness cleanup changes only failing-test cleanup and is not part of the frozen combined patch. One pre-cleanup merged full run passed 374 files and 7,803 tests. A later post-cleanup full run retained an unrelated OpenCode R9 continuation timeout at `packages/cezar/src/core/harness-parity.test.ts:643` after 7,802 of 7,803 tests passed; that targeted case immediately passed in 839 ms, and the affected attachment target passed 37 tests. An unbounded-default full retry passed the R9 case but failed the unchanged automation scheduler-start case after another 7,802 passes; this is the same scenario retained from workers-6 repetition 1 above. Neither failed suite is changed by the selected patches. Both failures remain part of the correctness evidence, and no unbounded-default final test success, final PR success or final-branch CI success is claimed here.

### Instrumentation findings retained in the evidence

The first two harness revisions wrote per-step metrics to `vitest.json` after Vitest wrote its detailed report there. Command timing/CPU/RSS and the entire console log are intact; all 374 per-suite durations and failure details are recoverable from those logs. `balance.py` accepts that console format as well as proper Vitest JSON and rejects incomplete/duplicate inventories. Later revisions prefix metric filenames with `step-`; a real subprocess regression test proves a command's own report survives.

The first snapshot runs returned `attempted:false`: the release script correctly rejects a nightly request on a push event. These are preparation-only measurements, not valid publication comparisons. The corrected snapshot campaign simulates `workflow_dispatch` on `main` only in the collector's subprocess environment, always passes `--dry-run`, and rejects results unless `attempted:true` and `dryRun:true`. It reuses the original baseline's verified artifacts from run 34272576293. Original and simulated context are recorded. No workflow settings or registry state are changed.

The hosted runner label yielded both image versions `20260831.293.1` and `20260907.300.1`. CPU models included AMD EPYC 7763, AMD EPYC 9V74, Intel Xeon 6973P-C, Intel Xeon Platinum 8370C and Intel Xeon Platinum 8573C. Every allocation exposed four CPUs; Node 24.20.0 and npm 11.19.0 matched. This hardware/image variation is unavoidable with this standard GitHub-hosted label and limits causal certainty, especially the wide four-worker range. It is not a controlled physical-machine benchmark.

Raw artifacts and job metadata are archived under `docs/benchmarks/156/raw/` by Actions run id: `34272576293.tar.gz`, `34272909471.tar.gz`, `34273853202.tar.gz`, `34273855860.tar.gz`, `34276216531.tar.gz`, and `34276219162.tar.gz`. Every final-campaign archive includes the downloaded artifacts plus `jobs.json`, `run.json` and an `aggregate.json` generated with the final repository summarizer. Paired-job support entered the summarizer at `3b493ea9`, after the measured `2b07fd3f` source; this affects only offline aggregation, not collection or measured application code.

Local verification logs, including initial environment failures, both final default-worker failures, the focused OpenCode recheck and the final four-worker pass, are retained in `156/local-verification.tar.gz`. Failure-injection cleanup evidence is described in `.github/benchmarks/156/fixtures-notes.md`; that probe was observed in the agent transcript rather than persisted as a log.
