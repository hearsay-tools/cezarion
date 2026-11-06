# Project Git probes

This report accompanies [hearsay-tools/cezarion#2733](https://github.com/hearsay-tools/cezarion/issues/2733), slice S4 of hearsay-tools/cezarion#2728. Single flight bounds concurrent cold and expired project probes to one computation per resolved root. A combined root/branch command reduces an origin repository from three Git processes to two. Warm reads still start no Git processes. Expired reads wait for the new result; the cache does not serve a stale result during refresh.

## Workload and environment

The [workload](../../packages/cezar/scripts/benchmark-project-probes.mjs) runs unchanged at baseline `bc5764da7e8817e219c0f5f1ff488ce042556f83` and on this branch. Each isolated fixture server calls the production `listProjects` through a loopback HTTP endpoint. Its parent sends and times requests. No live cockpit, agents, task stores, or tests participate. Forty temporary repositories each contain one commit and an origin remote. Each matrix cell selects 1, 10, or 40 repositories plus one ordinary directory and one missing root. Status checks on every response require `not-git` and `missing` for those last two roots.

Each of five trials covers concurrency 1, 4, and 16. Cold clears the cache. Warm follows that completed read within the five-second TTL. Expired waits 5,001 ms before the next batch. Concurrent clears the cache again and sends a simultaneous batch. Cold and expired also use the selected concurrency. This gives 180 cells and 1,260 requests per revision. Each cell records Git spawns by exact command, request p50/p95/max, server process CPU, reaped Git-child CPU, and load average before and after. Tables show the median of five cell values; the raw files retain every value. At concurrency 1, all latency percentiles are the one request's latency.

Both client and server inherit CPU affinity 2 through `taskset`. Node is v24.22.1, platform linux. The shared host has 24 available CPUs. One-minute host load ranges were 24.98–38.78 before and 33.42–44.24 after. This is a loaded-host comparison, not a steady-state production capacity claim. The fixture server measures its process CPU with `process.cpuUsage`; client CPU is excluded. Git CPU uses Linux `/proc/self/stat` child user/system ticks and `getconf CLK_TCK`, so small cases can round to zero. Setup and fixture commits are outside the measured windows.

```sh
# Copy this exact script into a disposable baseline worktree; install its pinned dependencies.
git worktree add /tmp/cez-s4-baseline bc5764da7
cp packages/cezar/scripts/benchmark-project-probes.mjs /tmp/cez-s4-baseline/packages/cezar/scripts/
pnpm install --frozen-lockfile --dir /tmp/cez-s4-baseline
taskset -c 2 node --import tsx /tmp/cez-s4-baseline/packages/cezar/scripts/benchmark-project-probes.mjs --out before.json
taskset -c 2 node --import tsx packages/cezar/scripts/benchmark-project-probes.mjs --out after.json
git worktree remove /tmp/cez-s4-baseline
# Package shortcut: npm run bench:project-probes -w @wjarka/cezarion -- --out after.json
```

Raw data: [baseline](project-git-probes/before.json), [single flight](project-git-probes/after.json).

## Concurrent cold probes

Every cell below is baseline → single flight. Counts include all requests in the batch.

| Git repositories | Concurrency | Git spawns | Server CPU ms | Git child CPU ms |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 3.00 → 2.00 | 10.03 → 11.90 | 10.00 → 0.00 |
| 1 | 4 | 12.00 → 2.00 | 40.33 → 13.54 | 40.00 → 0.00 |
| 1 | 16 | 48.00 → 2.00 | 146.28 → 20.51 | 160.00 → 10.00 |
| 10 | 1 | 30.00 → 20.00 | 98.51 → 69.83 | 120.00 → 80.00 |
| 10 | 4 | 120.00 → 20.00 | 319.48 → 77.75 | 420.00 → 90.00 |
| 10 | 16 | 480.00 → 20.00 | 1235.91 → 96.30 | 1440.00 → 90.00 |
| 40 | 1 | 120.00 → 80.00 | 294.44 → 280.81 | 360.00 → 320.00 |
| 40 | 4 | 480.00 → 80.00 | 1377.92 → 301.92 | 1660.00 → 340.00 |
| 40 | 16 | 1920.00 → 80.00 | 6181.21 → 349.35 | 8120.00 → 380.00 |

| Git repositories | Concurrency | Request p50 ms | Request p95 ms | Request max ms |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 20.60 → 27.73 | 20.60 → 27.73 | 20.60 → 27.73 |
| 1 | 4 | 94.41 → 31.80 | 106.07 → 33.45 | 106.07 → 33.45 |
| 1 | 16 | 306.73 → 52.41 | 324.39 → 53.78 | 324.39 → 53.78 |
| 10 | 1 | 246.34 → 169.49 | 246.34 → 169.49 | 246.34 → 169.49 |
| 10 | 4 | 800.68 → 182.43 | 820.50 → 182.59 | 820.50 → 182.59 |
| 10 | 16 | 2698.11 → 211.67 | 2708.35 → 217.83 | 2708.35 → 217.83 |
| 40 | 1 | 660.54 → 629.94 | 660.54 → 629.94 | 660.54 → 629.94 |
| 40 | 4 | 3143.22 → 699.57 | 3155.20 → 699.93 | 3155.20 → 699.93 |
| 40 | 16 | 15260.19 → 811.46 | 15543.25 → 813.16 | 15543.25 → 813.16 |

## Cache phases at 40 repositories and concurrency 16

| Phase | Git spawns | Request p50 ms | Request p95 ms | Request max ms |
| --- | ---: | ---: | ---: | ---: |
| cold | 1920.00 → 80.00 | 10563.36 → 721.13 | 11698.02 → 723.90 | 11698.02 → 723.90 |
| warm | 0.00 → 0.00 | 18.27 → 20.27 | 27.98 → 36.91 | 27.98 → 36.91 |
| expired | 1920.00 → 80.00 | 14332.26 → 844.71 | 14369.27 → 846.77 | 14369.27 → 846.77 |
| concurrent | 1920.00 → 80.00 | 15260.19 → 811.46 | 15543.25 → 813.16 | 15543.25 → 813.16 |

The raw matrix includes all other project counts, concurrency levels, and cache phases. Completed warm probes remain shared without additional Git work. Missing and non-Git roots require filesystem checks only. No-origin fallbacks still use their extra remote commands; `remote get-url` remains so Git's `insteadOf` expansion works. Tests cover these cases separately from the origin-only process-count workload.

## Prior evidence and limits

[hearsay-tools/cezarion#1932](https://github.com/hearsay-tools/cezarion/issues/1932) recorded 150 Git execution attempts over a 12-second live trace with nine registered projects and separate untraced server samples at 19–52% of a CPU core. Those observations motivated this controlled probe matrix. They include other callers and are not before/after samples for this change. This report reuses that scope evidence without repeating its broader research matrix for task history, database reads, active tasks, or browser modes.

This fixture isolates the production registry/probe path. It does not measure full cockpit startup, authentication middleware, task-index construction, SSE traffic, or browser rendering. There is no browser path in this change, so React commit duration, long tasks, and Event Timing do not apply. CPU and latency depend on shared-host load, but exact spawn counts directly show the removed work. Five seconds remain the maximum completed-result age; removal and new registration invalidate that root, and clear invalidates every root. Unit tests fence late completions and verify retry after shared rejection.
