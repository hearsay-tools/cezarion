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
callback's initial clock read. The raw value remains present, but both frame
percentiles exclude this first value because it is not an interval between
animation frames. Long tasks and Event
Timing cover setting changes, loading, streaming, scrolling and interactions.
Event Timing contains all delivered event entries with a 16 ms observation
threshold, including multiple entries from one pointer action. It is not an INP
score or one sample per interaction. Project archived interaction elapsed time
includes paging. Global archived interaction measures only the tab switch: its
endpoint returns the archived set before the project-only paging loop. The raw
global interaction label `Archived tab and paging` is retained as recorded; it
does not indicate global paging. The producer label will be corrected in S3b; Resource columns elapsed time includes closing the popover and applying
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
| project/1440/summary/active | summary → summary | 900 → 300 | 43317 → 13623 | 23288 → 7913 | 0.1 → 0.2 | 765.0 → 290.3 | 10.3 → 11.1 | 18.3 → 46.2 | 83.4 → 83.4 |
| project/1440/summary/archived | summary → summary | 3000 → 1000 | 120318 → 36024 | 64488 → 21413 | 456.8 → 75.3 | 2224.0 → 307.3 | 11.1 → 8.6 | 30.5 → 20.1 | 66.7 → 66.7 |
| project/1440/detailed/active | resources → resources | 600 → 300 | 30699 → 21398 | 15771 → 10670 | 0.1 → 0.1 | 518.1 → 1165.2 | 6.6 → 15.0 | 15.3 → 43.7 | 250 → 183.3 |
| project/1440/detailed/archived | resources → resources | 2000 → 1000 | 85300 → 61299 | 43471 → 30470 | 302.7 → 214.9 | 1153.1 → 919.8 | 9.5 → 9.6 | 33.0 → 40.0 | 366.7 → 433.3 |
| project/360/summary/active | cards → cards | 900 → 300 | 43300 → 10289 | 23273 → 5482 | 0.1 → 0.2 | 410.3 → 121.7 | 5.8 → 6.9 | 9.0 → 10.0 | 50 → 50.1 |
| project/360/summary/archived | cards → cards | 3000 → 1000 | 120301 → 24990 | 64473 → 13382 | 289 → 63.1 | 3074.5 → 223.4 | 6.6 → 7.3 | 13.6 → 14.4 | 50 → 50 |
| project/360/detailed/active | cards → cards | 600 → 300 | 30682 → 10289 | 15756 → 5482 | 0.1 → 6.8 | 1481.0 → 126.4 | 7.1 → 6.9 | 31.2 → 18.6 | 66.6 → 66.7 |
| project/360/detailed/archived | cards → cards | 2000 → 1000 | 85283 → 24990 | 43456 → 13382 | 206.8 → 45.3 | 1520.3 → 210.6 | 6.6 → 6.5 | 21.4 → 16.1 | 50 → 50.1 |
| global/1440/summary/active | summary → summary | 300 → 300 | 26953 → 10513 | 10126 → 6796 | 0.1 → 0.1 | 450.1 → 191.4 | 25.4 → 11.5 | 163.6 → 62.0 | 66.7 → 66.7 |
| global/1440/summary/archived | summary → summary | 2000 → 2000 | 133246 → 59246 | 62510 → 40510 | 308.2 → 1.4 | 1777.5 → 2030.0 | 8.1 → 7.4 | 121.9 → 16.0 | 116.6 → 66.7 |
| global/1440/grouped/active | cards → cards | 300 → 300 | 25870 → 25870 | 9603 → 9603 | 0.2 → 0.1 | 722.9 → 339.0 | 18.0 → 22.9 | 168.0 → 191.0 | 83.3 → 66.6 |
| global/1440/grouped/archived | cards → cards | 2000 → 2000 | 125390 → 125390 | 58603 → 58603 | 375.5 → 271.7 | 1531.1 → 5064.1 | 7.2 → 8.3 | 23.5 → 133.0 | 66.8 → 66.6 |
| global/360/summary/active | summary → summary | 300 → 300 | 26936 → 10496 | 10111 → 6781 | 0.1 → 0 | 680.0 → 144.1 | 8.8 → 2.0 | 91.0 → 6.7 | 50.1 → 50.1 |
| global/360/summary/archived | summary → summary | 2000 → 2000 | 133229 → 59229 | 62495 → 40495 | 345.1 → 0.2 | 5485.4 → 2738.0 | 5.4 → 11.3 | 41.2 → 162.6 | 50.1 → 50 |
| global/360/grouped/active | cards → cards | 300 → 300 | 25853 → 25853 | 9588 → 9588 | 0 → 0.1 | 576.6 → 2716.0 | 10.3 → 11.1 | 93.5 → 80.5 | 50.1 → 50 |
| global/360/grouped/archived | cards → cards | 2000 → 2000 | 125373 → 125373 | 58588 → 58588 | 342.5 → 336.4 | 1374.6 → 1184.8 | 6.2 → 8.4 | 24.1 → 113.3 | 50.1 → 50.1 |

### Frame percentile correction

Review found that the first recorded delta compares two clock reads rather than
two animation frames. All 160 original frame arrays remain unchanged. Both
per-case frame percentiles were recomputed from `frames.slice(1)` using the same
nearest-rank rule. The table's five-run frame p95 medians were then recomputed.
No workload was rerun. Mount, commit, API, event and memory values are unchanged.
100 per-case records changed one or both derived percentiles. The changed table
cells are listed as `old baseline → old branch` then `corrected baseline → corrected branch`:

- project/1440/summary/active: `83.3 → 66.7`; corrected `83.4 → 83.4`
- project/1440/summary/archived: `66.6 → 66.7`; corrected `66.7 → 66.7`
- project/1440/detailed/active: `183.3 → 183.3`; corrected `250 → 183.3`
- project/1440/detailed/archived: `350 → 416.6`; corrected `366.7 → 433.3`
- project/360/summary/active: `50 → 50`; corrected `50 → 50.1`
- project/360/detailed/active: `50 → 66.6`; corrected `66.6 → 66.7`
- project/360/detailed/archived: `50 → 50`; corrected `50 → 50.1`
- global/1440/summary/archived: `99.9 → 66.6`; corrected `116.6 → 66.7`
- global/1440/grouped/active: `83.3 → 50.1`; corrected `83.3 → 66.6`
- global/1440/grouped/archived: `66.7 → 66.5`; corrected `66.8 → 66.6`
- global/360/summary/active: `50 → 50`; corrected `50.1 → 50.1`
- global/360/summary/archived: `50 → 50`; corrected `50.1 → 50`
- global/360/grouped/active: `50 → 50`; corrected `50.1 → 50`
- global/360/grouped/archived: `50 → 50.1`; corrected `50.1 → 50.1`

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
animation frames; the timing limits described above apply. The archived column
includes paging for project rows only. Global rows measure a tab switch with no
paging; their original raw labels remain unchanged.

| Scope/width/setting/view | Archived tab (project: includes paging; global: no paging) | Resource columns setting | Expand | Search typing |
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


## S3b: virtual groups and memoized rows

The PR was rebased onto `f7edfaf48679278a7c2763a0249f4aad5d1be6f5`, which includes Phase 2 S5. The fixture conflict keeps S5 index updates/ticks and S3b insertion/summary-streaming behavior. The task-list benchmark does not send index commands or use the index seed, so the resolution does not change its measured workload. Published measurements remain historical runs on the source hashes shown below; they do not measure the rebased S5 index path.

Later changes (the rebase onto S5 `f7edfaf48` and later, the focus-restore retry in `use-task-list-focus.ts`, and the benchmark poll count) leave the measured render paths unchanged: index commands are not used by this workload, the retry observer exists only while a focused control is missing or not yet focusable after a layout change, and the poll count only extends the readiness limit.

Large-list A timings were measured at `5a32a5816`. Later commits remove work on
those paths: unchanged observer callbacks bail out,
focus no longer reruns route derivations, and owner lookup no longer mounts every
row before virtualization. They also add row-size hints and bounded initialization.
The A timings do not come from the later `6608d3696` recheck. The mount-count and small-list checks
below were repeated at pre-rebase source `6608d3696`.

Large global groups do less scroll work with virtualization. In paired runs on the
same branch, global frame p95 falls in all five pairs at both widths. The median
paired change is −83.2 ms at 1440 and −33.3 ms at 360. Project summary commit p95
also falls in all five pairs. Two regressions sit beside those gains: global
desktop paired commit p95 rises **19.3 ms** (range **−15.5 to +133.2 ms**; four
of five pairs rise), and project detailed paired frame p95 rises **33.1 ms**
(range **−16.7 to +50.0 ms**; three of five pairs rise). Both spreads cross zero
on this shared host. The global desktop absolute commit p95 medians are 75.3 ms
flat and 102.1 ms virtual. This study does not show a lower global desktop commit
cost from virtualization.

The recorded pre-rebase evidence supports acceptance criterion 6 through lower **scroll work** (global paired frame p95
improves 5/5 at both viewports) and lower **update work** (the small global list
renders/event falls 3.5 → 0.4 at pre-rebase source `6608d3696`). This historical evidence is limited to those measured sources; the bounded S5-base check below separately measures the later bookkeeping. It does not show a
universal timing improvement,
an optimal crossover near 100 rows, or Phase 2's commit-time acceptance. Phase 2
must compare global Tasks React commit time on main against `0320d57fb` under its
S5 index workload. The global desktop commit regression above remains explicit
input to that separate check.
The final small-list Event Timing p95 rises from 80 to 96 ms, even though its
row-render work and commit p95 fall. Timing gains do not hold for every measure.

### Method and noise reference

The unchanged workload runs against S3a baseline
`fdf9cf7ddf851670204a4141c59fbabfc2c89a8f` and branch
`5a32a5816887559b1b8fd18ae89312ba68baf8d3`. Both source trees were clean during
measurement. Later commits extract the same expansion state into a shared hook,
extract fixture streaming branches, and make no-op/test callback bodies explicit
for coverage. Those refactors do not change rendering behavior and were not
resampled. The producer now labels the global interaction **Archived tab** and
the project interaction **Archived tab and paging**. Existing S3a labels and samples
above remain unchanged.

The bounded study has 85 runs: five archived cases × paired flat/virtual × five
repetitions on the branch (50); the same five flat cases × five on baseline (25);
and a small global active fixture × five per build (10). The five large cases are
project 1440 summary, project 1440 detailed, project 360 cards, global 1440 summary,
and global 360 summary. Large fixture sizes match S3a: 1000 archived project runs,
or 2000 archived global runs. The small global fixture has ten projects with five
active and five archived runs each: 50 rows per selected group, below the threshold.

Each branch flat/virtual pair uses the same case and repetition. Pair order
alternates by repetition. These pairs are the noise reference: they share one
build and run next to each other, while retaining host load per case. Global
scroll improvements are roughly one 16.7 ms frame or more in every pair at both widths; paired
API p50 changes have mixed direction. The lower mounted-row counts and rendered-row
work provide an independent work measure. Baseline runs follow the paired branch
study; small branch runs precede small baseline runs. Those cross-build timings
remain exposed to temporal host noise and are not a paired causal estimate.

All runs use isolated fixtures, no agents and no live-cockpit requests. Processes
inherit CPU 23 affinity on an AMD Ryzen 9 5950X. Squeal was stopped during the
measurement after its hold command failed to record a hold due to a locked store.
No tests ran during measurement. The production profiling build and DevTools hook
are harness-only. Workload SHA256 is
`c506b8f10dc1917cf9334c3d2009e8f244f58aa99bfcff82003d37ad47d7745a`.
Build hashes are `a960638d2507fa30dfedd9e5517a5ce3cd8551ef9aec25dd03a635263210335e`
(baseline) and `22120a1a2e9cbd7f33a9255dfc289917152403cd0133bd46b77a8fa37b3fff3b`
(branch). Indexes retain both hashes and source/host metadata.

| Study | Runs | Load1 before/after range | Published updates/s range |
| --- | ---: | ---: | ---: |
| branch | 50 | 16.1–49.2 | 15.9–19.6 |
| baseline | 25 | 35.6–48.8 | 13.6–18.7 |
| branch-small | 5 | 42.0–44.9 | 19.1–19.2 |
| baseline-small | 5 | 41.1–45.3 | 18.9–19.2 |

The producer targets 20 summary events/s for three seconds. The tables report
observed publication rates. Commit samples now cover only that stream window:
the harness clears commits and row counts after archived loading and before the
stream. Each commit records root actualDuration and the number of rendered host
row fibers reached through positive-duration subtrees. “Rows/event” is the sum of
these counts divided by published events; it is an aggregate work proxy, not an
attribution of each commit to one event. Offscreen changed rows can produce zero
visible row renders. The global phone flat repetition 4 recorded no stream commits
(55 events published). Its commit percentiles are null in raw data; commit medians
and paired commit differences for that case use the four nonempty samples. Other
metrics retain all five samples. A zero-duration commit remains a valid sample.

Mounted rows and DOM/fibers use the S3a definitions. Scroll moves the main owner
64 px/frame for 60 frames; percentiles exclude the first non-interval value.
Long-task counts and Event Timing cover the whole case, including interactions;
Event Timing p95 is not INP or an interaction-specific percentile. Control elapsed
times end after two animation frames, with Archived including project paging.

### Mounts, stream commits and scroll

Values are medians across five runs (except the null case described above).
Durations are ms. “Detailed” means Resource columns. Flat and virtual are forced
through the query override on the same branch.

| Case | Build/tier | Mounted rows | DOM nodes | Fibers | Commit p50 | Commit p95 | Frame p95 | Rows/event |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| project/1440/summary | baseline/flat | 1000.0 | 21414.0 | 36026.0 | 95.2 | 386.0 | 66.7 | 139.6 |
| project/1440/summary | branch/flat | 1000.0 | 23407.0 | 38022.0 | 6.1 | 21.7 | 50.1 | 2.8 |
| project/1440/summary | branch/virtual | 13.0 | 721.0 | 1534.0 | 2.4 | 13.5 | 49.9 | 0.1 |
| project/1440/detailed | baseline/flat | 1000.0 | 30471.0 | 61301.0 | 88.1 | 828.6 | 316.6 | 105.2 |
| project/1440/detailed | branch/flat | 1000.0 | 31459.0 | 62292.0 | 8.8 | 67.7 | 66.7 | 19.4 |
| project/1440/detailed | branch/virtual | 26.0 | 1293.0 | 2935.0 | 5.9 | 32.3 | 83.3 | 0.1 |
| project/360/cards | baseline/flat | 1000.0 | 13383.0 | 24992.0 | 23.6 | 186.2 | 50.0 | 134.1 |
| project/360/cards | branch/flat | 1000.0 | 14385.0 | 25997.0 | 6.4 | 21.4 | 50.0 | 2.5 |
| project/360/cards | branch/virtual | 6.0 | 477.0 | 1164.0 | 3.3 | 18.0 | 33.4 | 0.1 |
| global/1440/summary | baseline/flat | 2000.0 | 40511.0 | 59246.0 | 0.0 | 472.4 | 66.7 | 25.7 |
| global/1440/summary | branch/flat | 2000.0 | 44513.0 | 67251.0 | 0.0 | 75.3 | 133.3 | 0.6 |
| global/1440/summary | branch/virtual | 10.0 | 745.0 | 1606.0 | 0.5 | 102.1 | 50.1 | 0.0 |
| global/360/summary | baseline/flat | 2000.0 | 40496.0 | 59229.0 | 0.0 | 1831.2 | 50.1 | 71.4 |
| global/360/summary | branch/flat | 2000.0 | 44498.0 | 67234.0 | 0.0 | 613.0 | 83.3 | 0.8 |
| global/360/summary | branch/virtual | 3.0 | 569.0 | 1344.0 | 0.6 | 65.8 | 50.0 | 0.0 |

The next table takes the median of each **within-repetition virtual minus flat**
difference. It is distinct from subtracting the medians above. Frame wins require
a reduction greater than 1 ms to avoid rounding ties.

| Case | Paired frame p95 delta | Frame wins | Paired commit p95 delta | Paired API p50 delta |
| --- | ---: | ---: | ---: | ---: |
| project/1440/summary | -0.2 | 2/5 | -7.6 | 0.9 |
| project/1440/detailed | 33.1 | 2/5 | -13.0 | -1.3 |
| project/360/cards | -0.0 | 2/5 | -6.4 | -3.8 |
| global/1440/summary | -83.2 | 5/5 | 19.3 | -6.7 |
| global/360/summary | -33.3 | 5/5 | -544.9 | 2.7 |

### Small global group under summary events

Both modes mount 50 rows. The pre-rebase source repeat uses five runs per build at
`6608d3696026bcf9fac60bbae0b684861bf8aa31` and baseline `fdf9cf7dd`.
Row renders per published event fall from 3.51 to 0.39 (89%). Commit p95 falls
from 25.8 to 16.7 ms; p50 stays 0.1 ms. Event Timing p95 rises from 80 to 96 ms.
The row-count result supports memoization below the virtual threshold. These
sequential cross-build timings remain subject to host noise. The independent
render-count test also proves that an unchanged summary skips rendering.

| Build | Mounted rows | DOM nodes | Fibers | Commit p50 | Commit p95 | Frame p95 | Rows/event |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| final-baseline-small | 50 | 1497 | 2674 | 0.1 | 25.8 | 33.4 | 3.51 |
| final-branch-small | 50 | 1600 | 2882 | 0.1 | 16.7 | 33.4 | 0.39 |

| Build | API p50 | API p95 | Long tasks | Event p95 | Search elapsed | Expand elapsed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| final-baseline-small | 3.5 | 12.3 | 0 | 80 | 307.2 | 295.4 |
| final-branch-small | 3.2 | 10.0 | 0 | 96 | 301.2 | 325.3 |

The active C cases do not click Archived. Elapsed interactions include the new
200 ms geometry settlement; they are not comparable to the A interaction times.
The final harness SHA256 is
`9b1786ddffc8e773fde1fcfa914a5317684c47077c8f247cb8d16f49aef48951`.
All pre-rebase source trees were clean. Branch and baseline build hashes are
`73dd4af7440a7ff8ca30600f8d4bf9bd46746daa3bffa45ed25f4baac474c019`
and `a960638d2507fa30dfedd9e5517a5ce3cd8551ef9aec25dd03a635263210335e`
respectively. The final indexes retain both hashes and all host samples.
Load1 ranges were 13.39–14.07 for branch C, 14.00–15.04 for baseline C,
and 14.40–23.07 for the mount recheck. The original C samples remain in the
original 85-run raw data; this table replaces their pre-rebase source claim.

### API, long tasks and interactions

Each row is a median of per-run values. Event p95 uses delivered entries at the
16 ms observation threshold. Long tasks is a count, not a duration. The raw files
retain every event duration and name. The detailed workload records no Expand interaction, so those cells are N/A.

| Case | Build/tier | API p50 | API p95 | Long tasks | Event p95 | Archived elapsed | Search elapsed | Expand elapsed |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| project/1440/summary | baseline/flat | 7.9 | 30.4 | 37.0 | 240.0 | 3708.5 | 401.8 | 753.1 |
| project/1440/summary | branch/flat | 1.9 | 7.1 | 15.0 | 176.0 | 1188.3 | 212.7 | 510.4 |
| project/1440/summary | branch/virtual | 1.9 | 4.2 | 1.0 | 264.0 | 934.3 | 68.2 | 52.9 |
| project/1440/detailed | baseline/flat | 9.6 | 40.0 | 89.0 | 496.0 | 10708.4 | 917.2 | N/A |
| project/1440/detailed | branch/flat | 6.0 | 12.4 | 42.0 | 216.0 | 3075.5 | 307.2 | N/A |
| project/1440/detailed | branch/virtual | 3.4 | 11.7 | 15.0 | 600.0 | 1247.2 | 126.4 | N/A |
| project/360/cards | baseline/flat | 8.0 | 23.0 | 33.0 | 216.0 | 2153.3 | 242.0 | 315.0 |
| project/360/cards | branch/flat | 5.2 | 9.8 | 13.0 | 112.0 | 879.6 | 144.3 | 114.5 |
| project/360/cards | branch/virtual | 2.1 | 8.2 | 4.0 | 192.0 | 907.5 | 64.8 | 59.4 |
| global/1440/summary | baseline/flat | 8.7 | 65.2 | 11.0 | 176.0 | 2132.9 | 530.9 | 221.4 |
| global/1440/summary | branch/flat | 9.7 | 34.2 | 43.0 | 304.0 | 1852.2 | 292.8 | 1086.5 |
| global/1440/summary | branch/virtual | 4.6 | 11.8 | 10.0 | 144.0 | 1150.2 | 129.9 | 71.4 |
| global/360/summary | baseline/flat | 9.6 | 26.7 | 15.0 | 120.0 | 1620.7 | 562.8 | 353.7 |
| global/360/summary | branch/flat | 6.9 | 17.4 | 20.0 | 160.0 | 1041.6 | 324.0 | 738.4 |
| global/360/summary | branch/virtual | 7.3 | 33.9 | 8.0 | 120.0 | 1132.7 | 87.7 | 56.6 |

### Threshold, exclusions and raw data

Keep `TASK_LIST_VIRTUALIZE_THRESHOLD = 100` rows per group. The selected large
cases show a large mount reduction and consistent global scroll improvement;
the 50-row control stays flat and benefits from memoization. This validates the
chosen tiers, not an exact optimal crossover: this study does not sweep sizes
near 100. A per-group threshold avoids making a small group virtual merely because
another group is large. Forced flat/virtual overrides remain available for diagnosis.

Omitted from the S3a matrix: large active lists, global grouped cards, and the
phone Resource columns setting duplicate. S3a already measured exclusive mounting
across that full matrix. This bounded study targets the largest archived groups,
the phone card layout, and the small global update case. Global has no detailed
setting. Intermediate widths and sizes around 100 were not benchmarked. Functional
browser checks cover layout widths, insertion anchoring, expansion, pointer and
keyboard rename, focus pinning, and query/path scroll behavior. Ctrl+F cannot find
unmounted offscreen rows above the threshold, as approved in decision D5.

Raw data: [branch pairs](task-list-rendering/s3b/branch/index.json),
[baseline large](task-list-rendering/s3b/baseline/index.json),
[branch small](task-list-rendering/s3b/branch-small/index.json), and
[baseline small](task-list-rendering/s3b/baseline-small/index.json). Pre-rebase-source
rechecks: [mounts](task-list-rendering/s3b/final-mount/index.json),
[branch C](task-list-rendering/s3b/final-branch-small/index.json), and
[baseline C](task-list-rendering/s3b/final-baseline-small/index.json).
Each index points to one compact file per case/repetition. The largest case is
10,312 bytes. Long tasks and Event Timing use the same lossless name dictionary
encoding as S3a; all samples were round-trip checked against the original output.

### Final mount and initialization checks

The unchanged case matrix ran once per flat/virtual case at pre-rebase source
`6608d3696` with `--quick`: ten cases, used only to recheck mounted work.
Its shorter stream is not a five-run timing study. Threshold 100 stays conservative;
these samples do not establish an optimal crossover. The original paired A runs
remain the timing/noise reference at their recorded source.

| Case | Flat rows | Virtual rows | Flat DOM | Virtual DOM | Flat fibers | Virtual fibers |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| project 1440 summary | 1000 | 13 | 23407 | 721 | 38023 | 1535 |
| project 1440 detailed | 1000 | 26 | 31459 | 1293 | 62293 | 2936 |
| project 360 cards | 1000 | 6 | 14385 | 477 | 25998 | 1165 |
| global 1440 summary | 2000 | 10 | 44513 | 745 | 67252 | 1607 |
| global 360 summary | 2000 | 3 | 44498 | 569 | 67235 | 1345 |

Owner lookup resolves in a layout effect. It does not first mount the full group.
A bounded first row remains mounted until viewport measurement, then normal focus
and rename pinning takes over. An intermediate `ssrCount=1` implementation froze
virtua's initial range until the first scroll; it was removed before push.
At scroll position zero, the 1440×900 global list now mounts 10 rows and shows four,
covering the viewport, compared with one mounted/visible row and 230 px of blank
space in the rejected intermediate build. The original PR head mounted 20 and
showed four. At 360×640 the respective mounted counts are 3, 1 and 6; visible count
is zero in all three because the existing header extends below the initial viewport.
The two-width regression requires enough mounted rows to cover available list space
without a scroll. Raw geometry is in the three `global-top-*.json` files.

### Footer size correction and failed attempts

The same 300-archive fixture measured each paging footer (or global group end)
immediately after scrolling to the end and again after 200 ms of stable geometry.
The project page initially loads 200 rows. Before uses source `50e7844b1`; after
uses `6608d3696`. These are geometry checks, not timing comparisons. The raw file
is [footer-size-hints.json](task-list-rendering/s3b/footer-size-hints.json).

| Presentation | Size hint | Before delta | Final delta | Browser bound |
| --- | ---: | ---: | ---: | ---: |
| project summary | 103 px | +1070 px | −1 px | 2 px |
| project detailed | 50 px | +180 px | 0 px | 2 px |
| phone cards | 178 px | +1209.58 px | −31.61 px | 34 px |
| global summary | 115 px | +1489.5 px | −4 px | 8 px |

Virtua measures actual row sizes; hints only estimate unmeasured rows. The summary
last border accounts for 1 px. Phone last-card padding and fractional heights account
for about 32 px; global fractional heights account for 4 px. These fixture-based
bounds allow small rounding variation. Wrapped titles, expanded previews and other
variable content can still cause larger corrections; this is a known limitation.
The browser checks also perform a settled pointer click that loads the remaining
project archive page.

Two early rechecks stopped at 200 loaded detailed rows after an unsettled footer
click. A diagnostic captured y=841.59, then found the footer center at y=1011.59;
the stale point hit the virtual list. The harness now retains the selected control
and waits for query idle, fonts, stable geometry and a valid hit target for 200 ms.
A later helper attempt chased the first mounted resource control as overscan changed;
another returned a DOM node through CDP's scalar channel. Both helper faults were
fixed before the final runs. Intermediate results, including the rejected one-row
mount sample, do not contribute to the final tables. The final 20 cases completed
with the same updated harness on both builds. The historical A raw files and hash
remain unchanged.

### Cross-group anchor and focus follow-up

At source `806418730`, the page boundary retains the pre-update visible row through
later ResizeObserver and start-margin corrections. It releases that anchor after
two quiet frames; wheel, touch, pointer and keyboard input take precedence.
The browser regression reproduced a 114 px global desktop shift and a 217 px
phone shift before this correction. The fixed project and global cases stay within
2 px at both widths. Unit guards cover delayed growth, shrink and folding above.

The S3a flat baseline `fdf9cf7dd` already kept the anchor in the matched cases:
project desktop/phone deltas were 0/0.80 px; global desktop/phone deltas were
0.50/0.50 px. The global fixture has two projects with 1000 active rows each;
120 boot rows start finished and secondary-project recovery contributes failed
rows to the earlier Finished group. The measured change moves a visible boot
row below the anchor from running to done. [Raw geometry](task-list-rendering/s3b/cross-group-anchor.json).

Focus retry now checks the list's logical membership before scanning, clears
records for removed rows, and cancels on pointer or keyboard intent. Tests cover
an absent run with repeated unrelated mutations and an empty-space press before
a matching delayed mount. Delayed virtual controls still regain focus.

This membership and anchor bookkeeping adds work on list updates and scrolling.
The pre-rebase timing tables do not measure it. The final-head check below measures
it as a bounded sanity check, not a replacement for the paired study above.


### Final head check

This bounded check measures the membership and cross-group anchor bookkeeping on
S5-base source `806418730`. Part A uses pushed head `1f5656a5f`; part B uses
`95311b186`, whose only later change reacquires a remounted benchmark control.
Product rendering is identical. Both use global summary at 1440×900, 20 events/s
for three seconds, five repeats, then the same scroll pass and Expand/search
interactions. This does not exercise S5's separate index workload.

Part A retains the C seed: ten projects with five active rows each. Values are
medians of per-run measurements, with run ranges in parentheses.

| Small global list | Rows rendered/event | Commit p50 ms | Commit p95 ms | Load average (1 min) |
| --- | ---: | ---: | ---: | ---: |
| pre-rebase `6608d3696` | 0.390 (0.356–0.424) | 0.1 (0.1–0.1) | 16.7 (12.1–26.9) | 13.39–14.07 |
| final head check | 0.397 (0.305–0.492) | 0.1 (0–6.9) | 12.7 (10.8–44.3) | 14.99–16.30 |

The rows/event median remains inside the earlier run spread; commit p95's median
falls. One final-head run reaches **44.3 ms**, above the earlier 26.9 ms maximum.
The broader spread and differing load prevent a timing guarantee.
[Five small-list raw cases](task-list-rendering/s3b/head-small/index.json).

Part B uses 300 active rows across ten projects, so the Working group is in the
virtual tier. Each repeat interleaves forced flat and virtual in the same build;
the order alternates. The paired differences below are virtual minus flat, with
medians and ranges across the five pairs. Rows/event counts sum rendered rows
across commits and divide by published events, including events for unmounted rows.

| Virtual-tier check | Rows rendered/event | Commit p95 ms | Scroll frame p95 ms | Load average (1 min) |
| --- | ---: | ---: | ---: | ---: |
| forced flat | 0.322 (0.175–0.377) | 27.1 (21.9–94.9) | 33.4 (33.4–50.1) | 14.96–17.71 |
| forced virtual | 0.034 (0.017–0.068) | 22.3 (14.4–35.9) | 33.4 (33.4–49.9) | 14.40–17.09 |
| paired difference | −0.288 (−0.360 to −0.142) | −12.7 (−67.2 to +14.0) | 0.0 (−0.2 to +16.5) | same-build pairs |

Rendered rows/event falls in all five pairs; commit p95 falls in four of five.
**This final-head check shows no scroll frame p95 speedup.** The earlier large-list
paired study improved global frame p95 in five of five pairs at both widths;
that historical result and this smaller check use different list sizes and loads.
Neither result establishes a universal timing improvement.
[Ten paired raw cases](task-list-rendering/s3b/head-pairs-final/index.json).

The first final-head paired attempt stopped after five cases because the helper
held a detached overscan control. A diagnostic found the same logical run remounted
after about 152 ms. The helper now reacquires only the same task key, control tag
and accessible label, then requires query idle, loaded fonts and 200 ms of stable,
hit-tested geometry. Expand and search remain included; the completed ten pairs
use this identical helper on both sides. Incomplete attempts do not enter tables.

**Limitations:** instant jumps larger than the overscan (scrollIntoView,
PageUp/PageDown, scrollbar drags) can show one blank frame. The diagnostic measured
1 of 96 frames with a 336.5 px uncovered list gap for a 26.5 ms sampling interval
after an instant 479 px jump at 1440×900. The Working start margin remained 491.5 px,
no anchor correction was pending, and no focus/startup pins were active. A second
180-frame reproduction had no uncovered frame. Flat mode never has this
virtualization gap; both sampled flat controls stayed covered. This is a jump
limitation, separate from the retained anchor during content updates.


### Later layout-change correction

A later QA check found that folding Finished above a virtual Working group could
shrink the page below its old scroll offset. The browser clamped scrolling and
unmounted the saved anchor before the page could restore it. The correction
captures before local fold/preview changes, then restores the same logical key
through its list's virtual item offset if that row is temporarily unmounted.
It retains the pending correction until the mounted row's position, the
virtualizer's scroll offset and its committed start margin agree; this prevents a
delayed virtualizer correction from undoing the restore after a large fold. An
already-settled snapshot releases immediately, and ordinary resize callbacks do
not schedule a logical scroll. Pending restoration also releases and captures the
current row when retry frames make no scroll progress, after ten restore calls,
or after one second. This bounds unreachable positions at either scroll limit,
including a preview below the visible row collapsing near the bottom. Twenty
anchor unit cases cover flat and virtual lists, both limits, stationary and
oscillating corrections, and capture after that preview collapse. The 29 browser
checks passed again on source `d0811b60e` after the bound was added.
The list registration is removed on unmount. A filtered-out anchor has no fallback
to another row: it retains scrollTop, subject to the browser's new height clamp.
A surviving anchor retains its viewport position. The focused tests cover both.
This correction and the committed-membership/worker-response follow-up postdate
the final-head timing table; that table remains evidence at its recorded hashes.

Follow-up verification: 184 focused unit tests, web typecheck, lint and all 29
browser checks (28 virtualization cases plus index smoke) passed. The bundled
browser-coverage quality run timed out after 20 minutes without a measurement.
At `ce4793199`, the approved replacement used the seven focused unit files: 431 changed functions
inventoried, maximum complexity 20 and measured maximum CRAP 30, with no exceeded
limits. Coverage was unavailable for 99 functions, so this is partial quality
evidence; CI's complexity gate and coverage merge cover the remaining paths.

Archived-page query results also now memoize on their stable fields, including
the enriched pagination object. A route rerender with unchanged archived answers
retains the groups identity; changes to data, placeholder/error/loading state,
pagination availability or callbacks still invalidate it. This identity test
failed before the correction and passes after it. This follow-up postdates the
recorded performance studies and makes no new timing claim.
