# Report shelf refresh measurements

This report accompanies [hearsay-tools/cezarion#2731](https://github.com/hearsay-tools/cezarion/issues/2731). Project report shelves now use project-scoped content and metadata signals. Task title updates patch an unfiltered shelf instead of repeatedly reading its report list.

Across five 20-second trials, median report-list requests fell from **35 to 1**, response bytes from **450,907 to 12,885**, and artifact-directory scans from **29 to 11**. All ten correctness snapshots passed: 121 exact expected report ids, the correct total and current task titles. Publication detection became slower, as approved: median **196 ms before, 798 ms after**.

## Method

The maintained [workload](../../packages/web/scripts/benchmark-reports.ts) runs through `benchmark-tabs.ts --workload reports`. It seeds project P (`boot`) with 60 settled tasks, each with two HTML reports, plus five live P tasks and five live Q tasks. It changes live task titles at an aggregate 5 Hz across both projects. It mounts P's shelf, waits two seconds, starts the measured window, publishes one P report five seconds into that window, and samples for 20 seconds. Correctness reads across all cursor pages and a real keyboard search interaction run after the resource window. No agent or provider runs in the fixture.

Both revisions use the same workload and fixture. Before: `bc5764da7e8817e219c0f5f1ff488ce042556f83` in a scratch worktree. After: `f28baadbe03e73e495397308b4e903252101a0ec`. **Product code equals the cleanly reviewed `552d931d073b4f925f90735e3276ddc6e1b4a8ce`.** Subsequent commits change only the benchmark's CDP/mount guards and log navigation/mount durations. The timeout changes do not change workload cadence or the measured interval. After measurement, the branch was rebased onto `0320d57fb81048642c80bb4de93038cbf5c12ce1`; the measured product paths did not change except for S1 workspace events. The scratch baseline has only the profiling build configuration copied in; raw `sourceDirty` records this and the uncommitted measurement files on the branch.

The fixture serves isolated production builds over local HTTP. A profiling React build records commit durations through the DevTools hook. CDP counts report requests, encoded response bytes and request latency, including worker traffic. A fixture preload counts artifact-directory `opendir` calls and content `lstat` calls; `pageChecks` is the selected-page subset. Server CPU is process CPU time, not wall time. A PerformanceObserver records long tasks and Event Timing, with a 16 ms event threshold. The search timing ends when the search URL and report rows render.

Host: Linux, AMD Ryzen 9 5950X; benchmark process and descendants pinned to CPU 23. Chrome 157.0.8103.38. Both five-trial runs used a confirmed Squeal hold. No tests of this task ran during the measurement windows. Final coverage collection finished before the branch run started. Other host work remained possible. One-minute load ranged from 20.52 to 31.40 around baseline trials and 23.14 to 26.52 around branch trials. Each trial records the full before/after load average.

Built server/web SHA-256 fingerprints:

- Before: `cc470831f57c7d1f31946f20cbfe998353872c6eab38de18e67910c515d73b59`.
- After: `c63675fcb442e05ce43420c59320a75b325c83b43f7d6c9836b6d5306a9a6f52`.

## Results

Each value is the median of five trial values. Latency columns are medians of per-trial percentiles, not pooled percentiles. The after trials each contain only one measured report-list request, so their p50 and p95 are the same sample.

| Metric, per 20-second trial unless stated | Before | After |
| --- | ---: | ---: |
| Report-list requests | 35 | 1 |
| Report-list encoded response bytes | 450,907 | 12,885 |
| State-twin requests (local mode) | 0 | 0 |
| Artifact-directory scans (`opendir`) | 29 | 11 |
| Content `lstat` calls | 1,812 | 60 |
| Selected-page checks (subset of `lstat`) | 1,785 | 51 |
| Report-list latency p50, ms | 81.25 | 64.52 |
| Report-list latency p95, ms | 117.92 | 64.52 |
| Publication detection, ms | 196 | 798 |
| Server CPU time, ms | 2,170 | 650 |
| React commits | 180 | 182 |
| React commit duration p50, ms | 3.0 | 3.7 |
| React commit duration p95, ms | 20.5 | 19.1 |
| Long-task count | 1 | 1 |
| Sum of long-task durations, ms | 54 | 68 |
| Event Timing entries | 4 | 4 |
| Rendered search interaction, ms | 78.88 | 68.50 |
| Correct snapshot trials | 5/5 | 5/5 |

Before request counts were `[34, 35, 36, 36, 35]`; after counts were `[1, 1, 1, 1, 1]`. Before scan counts were `[28, 29, 30, 30, 29]`; after counts were `[11, 11, 11, 11, 11]`. Request and byte medians fell about 97%; scan medians fell about 62%. The raw Event Timing entries retain each event name and duration; these entries are not an INP measurement.

## Raw evidence and lossless reassembly

[Raw data directory](report-shelf-refresh/) contains `before-001.json` through `before-035.json` and `after-001.json` through `after-035.json`. Each file contains path/value records. The largest is 11,023 bytes, so GitHub can expose every patch. Together the chunks retain **every raw value** from both original aggregates, including every correctness row, actual/expected id, seed, title, timing entry, revision, build hash and load value. No field is omitted.

Reassembling each side was checked by deep equality against its original aggregate. Both checks passed. Canonical JSON SHA-256 (sorted object keys, compact separators) also matches:

- Before: `52e252b9f6c2be35c3ee621495b0eb3b34201f9981cf6bc2260e002b175f7863`.
- After: `a11f1724aaadb8565dc592397ba72e0fac3845486a81ad9936182e754dc5528f`.

Run this from the repository root to reconstruct the aggregates and verify the hashes:

```python
import hashlib, json, pathlib
expected = {
    'before': '52e252b9f6c2be35c3ee621495b0eb3b34201f9981cf6bc2260e002b175f7863',
    'after': 'a11f1724aaadb8565dc592397ba72e0fac3845486a81ad9936182e754dc5528f',
}
for side, digest in expected.items():
    result = {}
    for file in sorted(pathlib.Path('docs/performance/report-shelf-refresh').glob(side + '-*.json')):
        for entry in json.loads(file.read_text()):
            path, value = entry['path'], entry['value']
            if not path:
                result = value
                continue
            cursor = result
            for i, key in enumerate(path[:-1]):
                child = [] if isinstance(path[i + 1], int) else {}
                if isinstance(cursor, list):
                    while len(cursor) <= key: cursor.append(None)
                    if cursor[key] is None: cursor[key] = child
                else:
                    cursor.setdefault(key, child)
                cursor = cursor[key]
            key = path[-1]
            if isinstance(cursor, list):
                while len(cursor) <= key: cursor.append(None)
            cursor[key] = value
    encoded = json.dumps(result, sort_keys=True, separators=(',', ':')).encode()
    assert hashlib.sha256(encoded).hexdigest() == digest
    pathlib.Path('/tmp/report-shelf-' + side + '.json').write_text(json.dumps(result))
```

## Aborted attempts and limits

Four final-branch attempts were excluded in full. Partial samples were not combined across revisions or used in the medians:

| Attempt | Revision | Completed samples | Failure |
| --- | --- | ---: | --- |
| First resample | `d7027a56b` | 3 | CDP `Page.navigate` exceeded the 10-second request guard under concurrent browser load. |
| Second resample | `d7027a56b` | 0 | Same navigation timeout under concurrent browser load. |
| Reserved-window resample | `552d931d0` | 2 | Same navigation timeout with S3 browser work paused. |
| Longer-CDP-guard resample | `e404842ea` | 1 | Shelf mount poll exhausted its 30-second budget; last probe exceeded its 2-second guard. |

The failed mount attempt did not record exact navigation/mount elapsed times or later DOM state. It cannot establish whether the shelf mounted late or never mounted. The final harness records those times and uses a 60-second mount/probe guard. In the complete run, navigation took 79–101 ms and mount took 2.47–3.44 seconds. Mount occurs before sampling. The observed final mount times do not establish the cause of earlier failures.

This measures one visible local shelf. Remote mode's five-second state twin is covered by tests, not these numbers. Quiet-run detection and unreadable-storage repair are also tested rather than timed here. The index/workspace cadence outside the report shelf remains unchanged. Settled external edits still reconcile on mount, focus, reconnect or content refresh. The changed live publication cadence intentionally trades some latency for fewer reads and scans.

This shared-host comparison is sequential, without randomization or confidence intervals. CPU and browser timings are descriptive; the strongest evidence is the repeatable reduction in requests and scans with exact correctness snapshots. React commit count stays similar because the workspace index still updates. Event Timing omits events below its threshold.

## Reproduce

Build the server normally and the profiling cockpit with:

```sh
pnpm exec vite build --config packages/web/scripts/vite.reports-benchmark.config.ts
```

Use a scratch checkout of the baseline, never the main checkout, and copy the same profiling build configuration there. Run the current harness unchanged against each build, under a verified validation hold with no other tests of this task running:

```sh
taskset -c 23 node --import tsx packages/web/scripts/benchmark-tabs.ts --workload reports --build-root /tmp/cezar-s2-baseline --output /tmp/report-shelf-before.json
taskset -c 23 node --import tsx packages/web/scripts/benchmark-tabs.ts --workload reports --output /tmp/report-shelf-after.json
```

The default is five trials. `--quick` is only a smoke check and was not used for this report. Each trial creates and removes its own fixture workspace and browser session. The live cockpit is never used.
