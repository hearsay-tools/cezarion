# Task list rendering

Part of [hearsay-tools/cezarion#2732](https://github.com/hearsay-tools/cezarion/issues/2732).
This first measurement covers exclusive mounting (S3a). It does not measure virtualization.

Project lists mount one representation after the change. At 1000 archived tasks,
summary mode falls from 3000 mounted rows to 1000. At phone width, either Resource
columns setting renders 1000 cards. Global summary mode keeps its row count but
mounts actions only for expanded rows, which reduces its fiber count. Global grouped
cards are a control: their mounted row, DOM node and fiber counts are unchanged.

The timing results are mixed. Project summary and phone commit p95 generally fall.
Desktop detailed active commit p95 rises from 518 to 1165 ms. Global desktop summary
archived rises from 1778 to 2030 ms. Unchanged grouped cards also have large timing
changes. These shared-host samples establish a mount reduction; they do not establish
a timing improvement for every case.

## Method

The [workload](../../packages/web/scripts/benchmark-task-lists.ts) runs unchanged on
baseline `bc5764da7e8817e219c0f5f1ff488ce042556f83` and branch
`af998efd8f6d66bf7b7d0907f1e2920f8a3fe559`. That artifact's product source last changed at
`8e84efc6b`; its later commits change the measurement harness. The subsequent review
fix that keeps an inline rename draft above responsive rows is covered by functional
tests and has not been resampled here. Each build has 80 cases:
project/global × two viewports × two settings × active/archived × five repetitions.
There are no omitted cases in the completed matrix. Global has summary and grouped
settings; a detailed setting is N/A because it does not exist. Grouped renders cards
at both viewports. Global summary remains summary at phone width.

Project fixtures contain 300 active and 1000 archived tasks. Global fixtures contain
300 active and 10 projects with 200 archived tasks each. The project archived case
loads all pages before counting. Measurements use isolated local fixture servers,
no agents, and no requests to the live cockpit. Baseline uses a scratch worktree.
Both production builds use a harness-only `react-dom/profiling` alias and DevTools
hook. Product code contains no measurement instrumentation.

The build indexes retain revision, build hash, workload hash, host and clean/dirty
state. Baseline is clean. Branch is dirty because generated measurement output was
present; its built artifact was not changed during the matrix. Workload SHA256 is
`d905447d33ce00450898e99b2da0f69a7d04759aa14da5b413409529ba42d404` for both.
Built-content hashes are `a11a7a4dc54d1ee85a80cf5eafc951fc8677e3c13421f44305743af563fd368c`
(baseline) and `7b30f664f1a61be25128597fa3866a3dc60bdaeee2dcdfcc895530b2906d4ba3`
(branch).

Both processes run pinned to CPU 23 on an AMD Ryzen 9 5950X host. The harness and
its fixture/browser children inherit that affinity. Squeal is held during the
matrix. Other users of this shared host remain active. Baseline load1 ranges from
24.69 to 71.54; branch from 26.94 to 66.45. Available host memory ranges from
5.0–16.9 GiB on baseline and 8.8–18.6 GiB on branch. Swap is often full. Every case
retains before/after load averages and memory. Baseline runs first, then branch;
case order is fixed, with five repetitions and no confidence intervals.

The fixture targets 20 summary updates/s for three seconds. Actual publication
rates are 10.5–19.1/s on baseline and 12.7–18.9/s on branch under host load. Each
case retains its publication count and elapsed time. React samples are root
`actualDuration` values, including zero-duration commits. The commit window also
includes archived tab/page loading where selected, before the stream; it is not
an isolated per-update cost. Mount counts are taken before search, which changes
archive paging. Fibers include the whole React root; DOM nodes include the whole
document. Rows count the route's row components; the raw files also retain route
and whole-document `[data-run-id]` counts.

Ten local `/api/v1/projects` probes produce API percentiles. The scroll probe moves
`[data-slot="main"]` by 64 px per animation frame for 60 frames. Its first frame
can have a slightly negative delta because the animation timestamp precedes the
callback's initial clock read; the raw value remains present. Long tasks and Event
Timing cover setting changes, loading, streaming, scrolling and interactions.
Event Timing contains all delivered event entries with a 16 ms observation
threshold, including multiple entries from one pointer action. It is not an INP
score or one sample per interaction. Archived interaction elapsed time includes
paging; Resource columns elapsed time includes closing the popover and applying
the requested viewport. Expand and Search typing elapsed times end after two
animation frames, not after a search response. These control timings are retained
separately from Event Timing.

## Mount and timing results

Each value is the median across five repetitions, **baseline → branch**. Commit,
API and frame values are milliseconds. Each per-case percentile is computed first,
then the table takes its median. “Detailed” is the Resource columns setting;
“resources” is the representation name recorded by the route. The baseline mounts
hidden duplicates in addition to the visible representation named here.

| Scope/width/setting/view | Visible representation | Mounted rows | Fibers | DOM nodes | Commit p50 | Commit p95 | API p50 | API p95 | Frame p95 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| project/1440/summary/active | summary → summary | 900 → 300 | 43317 → 13623 | 23288 → 7913 | 0.1 → 0.2 | 765.0 → 290.3 | 10.3 → 11.1 | 18.3 → 46.2 | 83.3 → 66.7 |
| project/1440/summary/archived | summary → summary | 3000 → 1000 | 120318 → 36024 | 64488 → 21413 | 456.8 → 75.3 | 2224.0 → 307.3 | 11.1 → 8.6 | 30.5 → 20.1 | 66.6 → 66.7 |
| project/1440/detailed/active | resources → resources | 600 → 300 | 30699 → 21398 | 15771 → 10670 | 0.1 → 0.1 | 518.1 → 1165.2 | 6.6 → 15.0 | 15.3 → 43.7 | 183.3 → 183.3 |
| project/1440/detailed/archived | resources → resources | 2000 → 1000 | 85300 → 61299 | 43471 → 30470 | 302.7 → 214.9 | 1153.1 → 919.8 | 9.5 → 9.6 | 33.0 → 40.0 | 350 → 416.6 |
| project/360/summary/active | cards → cards | 900 → 300 | 43300 → 10289 | 23273 → 5482 | 0.1 → 0.2 | 410.3 → 121.7 | 5.8 → 6.9 | 9.0 → 10.0 | 50 → 50 |
| project/360/summary/archived | cards → cards | 3000 → 1000 | 120301 → 24990 | 64473 → 13382 | 289 → 63.1 | 3074.5 → 223.4 | 6.6 → 7.3 | 13.6 → 14.4 | 50 → 50 |
| project/360/detailed/active | cards → cards | 600 → 300 | 30682 → 10289 | 15756 → 5482 | 0.1 → 6.8 | 1481.0 → 126.4 | 7.1 → 6.9 | 31.2 → 18.6 | 50 → 66.6 |
| project/360/detailed/archived | cards → cards | 2000 → 1000 | 85283 → 24990 | 43456 → 13382 | 206.8 → 45.3 | 1520.3 → 210.6 | 6.6 → 6.5 | 21.4 → 16.1 | 50 → 50 |
| global/1440/summary/active | summary → summary | 300 → 300 | 26953 → 10513 | 10126 → 6796 | 0.1 → 0.1 | 450.1 → 191.4 | 25.4 → 11.5 | 163.6 → 62.0 | 66.7 → 66.7 |
| global/1440/summary/archived | summary → summary | 2000 → 2000 | 133246 → 59246 | 62510 → 40510 | 308.2 → 1.4 | 1777.5 → 2030.0 | 8.1 → 7.4 | 121.9 → 16.0 | 99.9 → 66.6 |
| global/1440/grouped/active | cards → cards | 300 → 300 | 25870 → 25870 | 9603 → 9603 | 0.2 → 0.1 | 722.9 → 339.0 | 18.0 → 22.9 | 168.0 → 191.0 | 83.3 → 50.1 |
| global/1440/grouped/archived | cards → cards | 2000 → 2000 | 125390 → 125390 | 58603 → 58603 | 375.5 → 271.7 | 1531.1 → 5064.1 | 7.2 → 8.3 | 23.5 → 133.0 | 66.7 → 66.5 |
| global/360/summary/active | summary → summary | 300 → 300 | 26936 → 10496 | 10111 → 6781 | 0.1 → 0 | 680.0 → 144.1 | 8.8 → 2.0 | 91.0 → 6.7 | 50 → 50 |
| global/360/summary/archived | summary → summary | 2000 → 2000 | 133229 → 59229 | 62495 → 40495 | 345.1 → 0.2 | 5485.4 → 2738.0 | 5.4 → 11.3 | 41.2 → 162.6 | 50 → 50 |
| global/360/grouped/active | cards → cards | 300 → 300 | 25853 → 25853 | 9588 → 9588 | 0 → 0.1 | 576.6 → 2716.0 | 10.3 → 11.1 | 93.5 → 80.5 | 50 → 50 |
| global/360/grouped/archived | cards → cards | 2000 → 2000 | 125373 → 125373 | 58588 → 58588 | 342.5 → 336.4 | 1374.6 → 1184.8 | 6.2 → 8.4 | 24.1 → 113.3 | 50 → 50.1 |

## Long tasks, Event Timing and memory

Long-task totals and Event Timing p95 are milliseconds. RSS values are MiB.
These are medians of per-case values. RSS peaks are sampled every 250 ms and can
miss shorter peaks. Chrome RSS sums the known fixture-browser processes and can
double-count shared pages. The fixture is reused within each scope. Later cases
can retain allocations from earlier cases. Event p95 uses the nearest-rank rule.

| Scope/width/setting/view | Baseline long-task total | Baseline event p95 | Baseline fixture peak | Baseline Chrome peak | Branch long-task total | Branch event p95 | Branch fixture peak | Branch Chrome peak |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| project/1440/summary/active | 9253 | 464 | 244.5 | 2675.0 | 4914 | 528 | 242.5 | 2460.1 |
| project/1440/summary/archived | 24658 | 560 | 245.1 | 2685.2 | 10011 | 264 | 243.6 | 2443.1 |
| project/1440/detailed/active | 13413 | 528 | 245.2 | 2711.3 | 12673 | 416 | 247.7 | 2451.8 |
| project/1440/detailed/archived | 29727 | 808 | 245.1 | 2754.2 | 34464 | 616 | 249.1 | 2539.3 |
| project/360/summary/active | 7350 | 432 | 238.8 | 2678.7 | 3659 | 280 | 249.1 | 2484.7 |
| project/360/summary/archived | 16583 | 112 | 238.3 | 2688.2 | 6609 | 224 | 245.0 | 2446.6 |
| project/360/detailed/active | 7587 | 384 | 237.9 | 2719.6 | 6661 | 1200 | 249.2 | 2489.0 |
| project/360/detailed/archived | 17311 | 424 | 238.9 | 2713.9 | 9398 | 1168 | 249.1 | 2505.0 |
| global/1440/summary/active | 3478 | 192 | 357.5 | 2795.1 | 1543 | 264 | 329.4 | 3495.4 |
| global/1440/summary/archived | 11264 | 232 | 365.4 | 2929.3 | 9163 | 216 | 330.3 | 3562.9 |
| global/1440/grouped/active | 7811 | 184 | 363.3 | 2886.8 | 2934 | 176 | 330.2 | 3544.9 |
| global/1440/grouped/archived | 9679 | 184 | 361.9 | 2945.5 | 13124 | 176 | 327.7 | 3511.5 |
| global/360/summary/active | 2821 | 128 | 359.2 | 2913.7 | 1106 | 88 | 328.6 | 3420.3 |
| global/360/summary/archived | 12957 | 128 | 361.8 | 2953.1 | 7051 | 136 | 330.3 | 3477.6 |
| global/360/grouped/active | 3012 | 184 | 358.9 | 2973.2 | 4265 | 144 | 330.3 | 3439.7 |
| global/360/grouped/archived | 8647 | 128 | 356.4 | 3017.2 | 7779 | 128 | 335.0 | 3561.4 |

## Control elapsed times

Values are median milliseconds across five repetitions, baseline → branch. N/A
means that control was not used in that case. Search and expand include two
animation frames; the timing limits described above apply.

| Scope/width/setting/view | Archived tab and paging | Resource columns setting | Expand | Search typing |
|---|---:|---:|---:|---:|
| project/1440/summary/active | N/A → N/A | N/A → N/A | 548.7 → 573.4 | 1372.9 → 452.9 |
| project/1440/summary/archived | 14177.1 → 4362.7 | N/A → N/A | 767.4 → 798.9 | 1391.6 → 539.6 |
| project/1440/detailed/active | N/A → N/A | 2381.5 → 2680.8 | 250.2 → N/A | 1538.3 → 1245.4 |
| project/1440/detailed/archived | 13970.1 → 14032.9 | 2534.3 → 4699.6 | 101.1 → N/A | 1175.2 → 1207.2 |
| project/360/summary/active | N/A → N/A | N/A → N/A | 104.8 → 309.6 | 882.3 → 382.7 |
| project/360/summary/archived | 11068.3 → 2717.5 | N/A → N/A | 57.4 → 338.3 | 956.2 → 315.6 |
| project/360/detailed/active | N/A → N/A | 4029.1 → 5274.0 | 167.3 → 278.6 | 817.6 → 355.2 |
| project/360/detailed/archived | 8768.9 → 2676.7 | 3148.7 → 5322.6 | 136.2 → 330.1 | 775.1 → 297.1 |
| global/1440/summary/active | N/A → N/A | N/A → N/A | 190.9 → 231.9 | 494.6 → 220.8 |
| global/1440/summary/archived | 13529.3 → 5340.9 | N/A → N/A | 322.9 → 273.1 | 1897.9 → 711.9 |
| global/1440/grouped/active | N/A → N/A | N/A → N/A | 159.6 → 153.7 | 309.7 → 346.2 |
| global/1440/grouped/archived | 11952.2 → 9719.4 | N/A → N/A | 409.4 → 618.1 | 1476.1 → 1439.6 |
| global/360/summary/active | N/A → N/A | N/A → N/A | 119.1 → 117.1 | 336.0 → 179.2 |
| global/360/summary/archived | 5632.4 → 4605.0 | N/A → N/A | 298.1 → 273.7 | 1748.2 → 643.9 |
| global/360/grouped/active | N/A → N/A | N/A → N/A | 161.8 → 126.2 | 552.9 → 267.3 |
| global/360/grouped/archived | 11132.6 → 8248.6 | N/A → N/A | 315.8 → 257.2 | 1339.0 → 1077.5 |

## Failed attempts and limits

Three earlier measurement attempts failed and are not included in the completed
matrix's medians:

- The original 10 s CDP timeout expired during baseline Runtime.evaluate after
  11 cases. The coordinator approved a benchmark-only 60 s timeout. Existing
  callers retain the 10 s default, verified by a focused fake-timer test.
- The next attempt lost the fixture control connection after 10 cases
  (`ECONNREFUSED`). That attempt did not record the fixture exit signal. Its cause
  is unknown. The harness now records lifecycle, exit status and stderr.
- The next attempt failed after 23 cases when the Archived click did not activate
  the tab (project, 360 px, detailed setting, archived, repetition 2). The fixture
  was alive with no stderr. Its later cleanup exit was code 0. Fixture peak RSS
  was 251 MiB, Chrome 2.74 GiB, and available host memory fell from 11.3 to 8.8 GiB.
  This is not evidence of OOM. The harness now waits for fonts/query readiness and
  popover dismissal plus returned focus before clicking the next control.

The final matrix has no 60 s timeout or failed sample. Both fixture scopes exit
with code 0 and no signal or stderr on both builds. Initial partial runs are
retained locally for diagnosis; the committed data below contains every sample
of the completed, unchanged-workload matrix. Loading/empty/error appearance,
keyboard focus and action behavior require separate functional checks. These
performance samples do not replace those checks. The virtualization threshold
will be measured in S3b; these results do not choose it.

## Raw data and reproduction

The [baseline index](task-list-rendering/baseline/index.json) and
[branch index](task-list-rendering/s3a/index.json) list all 80 case files for each
build. Each case is under 10 KB so GitHub can expose its patch. All raw sample
values are preserved. `eventTiming` and `longTasks` use a lossless dictionary:
`names` is the name list; each `samples` pair is `[nameIndex, ms]`. Decode a pair
`[i, ms]` as `{ "name": names[i], "ms": ms }`. Other fields use the harness's
original JSON schema. No sampling or rounding is applied to raw values.

Build both trees first (`npm run build`), then prepare the profiling web build
and run the same branch harness against each build root. For example:

```sh
node --import tsx packages/web/scripts/benchmark-task-lists.ts --build-root /tmp/cezar-s3-baseline --build --prepare-only
node --import tsx packages/web/scripts/benchmark-task-lists.ts --build --prepare-only
taskset -c 23 node --import tsx packages/web/scripts/benchmark-task-lists.ts --build-root /tmp/cezar-s3-baseline --output /tmp/task-list-baseline.json
taskset -c 23 node --import tsx packages/web/scripts/benchmark-task-lists.ts --output /tmp/task-list-branch.json
```

Use an unused CPU allowed by the host. Run with no local tests or other browser
workloads. `--quick` is a diagnostic mode and is not used for these results.
The normal product build should be restored after measurement.

The CI workload smoke test calls the exported runner in process with three active
and five archived tasks per project, two global projects, both viewports and one
repetition. It checks 16 combinations, row counts, visible representations and
clean fixture exits. It uses short observation windows and the e2e build mirror;
it is correctness evidence, not a performance sample. The measured production
matrix above used the harness at `af998efd8`, before this test-only runner refactor.
Normal CLI defaults and fixture sizes remain the full workload described above.
