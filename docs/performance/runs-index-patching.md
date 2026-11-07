# Workspace runs index patched from the stream: measurements

This report goes with [hearsay-tools/cezarion#2729](https://github.com/hearsay-tools/cezarion/issues/2729) (plan `.ai/specs/2026-11-06-cockpit-performance-plan.md`, slice S5). Before the change, the cockpit refetched the whole `GET /workspace/runs-index` (808 rows, about 200 KB in this fixture) 400 ms after any run event. After the change, the workspace stream's `run-summary`, `run-deleted` and `usage` frames patch the cached rows. A full read runs only as a fenced reconciliation (bootstrap, reconnect, visibility restore, a `seq` gap, an unknown project, a truncated window move, a new project) and as the 60 s visible-only backstop (D2). The global Tasks page keeps its own 15 s poll.

Main result, 5 updates per second for 60 s: index requests fell from 111–124 per minute to 1–4 per minute in every view. Index bytes fell from 22.3–25.2 MB to 0.2–0.8 MB per minute. All bytes the page received in that minute fell by 96–98%. The workspace SSE bytes did not change (about 0.2 MB per minute on both sides), because S1 already sends summary frames. Server CPU in the sustained minute fell by 18–27%. A title change in another project reaches the global Tasks page in 138 ms instead of 587 ms. On the S5 branch one cost remained: the global Tasks page spent about 22% more React commit time under sustained updates. S3b (hearsay-tools/cezarion#2815) removed it: on main `33ca204e5` that page spends 69% less React commit time than the baseline (see [After S3b](#after-s3b-main-33ca204e5-measured-2026-11-07)).

**Read the timing numbers with the host load.** Request counts, bytes and frame counts are deterministic: they repeat across runs. Timing numbers (CPU, renderer time, React commit time, latency) carry host noise. The baseline and branch runs were interleaved; both saw a one-minute `loadavg` between 14 and 44 on 24 cores. Use the timing numbers for direction, not for exact ratios.

## Method and evidence

The workload is `benchmark-tabs.ts --workload index` ([harness](../../packages/web/scripts/benchmark-tabs.ts), [index workload](../../packages/web/scripts/benchmark-index.ts)). It serves a production build of each side from `tab-fixture-server.mjs --index`, a fixture cockpit with no agents and no tests:

- Two projects, both truncated: each index window holds 200 of 210 archived roots, plus the unarchived roots, for 808 index rows. The boot project also holds one running delegation parent with four running workers (workers never enter the index).
- One Chrome tab per case, with CDP network capture on the page and on the SharedWorker. Three views: `closed` (the boot project's task list), `all-tasks` (the global Tasks page) and `detail` (the delegation parent's task detail).
- Four phases per case, in order, each its own window: `cold` (navigation plus 8 s; since the published runs, the harness also waits there until the cockpit settles, see below), `update` (one title change, 3 s), `sustained` (5 token ticks per second for 60 s, round-robin over the parent, its four workers and three roots of the other project; an ordinary `GET /api/v1/projects` probe every second) and `reconnect` (the server drops every connection, 8 s).
- Per window: `runs-index` and `/runs/:id` requests and body bytes, workspace SSE body bytes, all body bytes, `runs-index` request duration, probe p50/p95, cockpit server CPU, renderer task time (`Performance.getMetrics` `TaskDuration`) and React commits.
- React commit time comes from a harness-only build: [`vite.profiling.config.ts`](../../packages/web/scripts/vite.profiling.config.ts) aliases `react-dom/client` to `react-dom/profiling`, and a DevTools-hook shim records each committed root's `actualDuration`. Product code has no instrumentation. The shim also removes `console.timeStamp`: React 19.2's profiling build otherwise writes a Performance-panel track for every component of every commit, which is profiler cost and dominated renderer time on both sides.
- After the published runs, the branch was rebased on `fdf9cf7dd` (S3a, hearsay-tools/cezarion#2789), whose harness changes merged with this one, and the harness's `cold` and `reconnect` phases gained a settle wait: after their 8 s they also wait for the cockpit's own signals (`window.__cezLive`, `window.__cezIdle`, and the phase's index read landed). A cockpit that settled within 8 s, as in every measured phase, gets no extra time; a slow one no longer leaks its index read into the next phase. The published runs used the fixed 8 s windows.
- [`index-workload.e2e.ts`](../../packages/web/e2e/index-workload.e2e.ts) runs one short `all-tasks` case on the e2e build in the browser suite, so the workload stays reproducible: an update and sustained ticks make no index read, and a reconnect makes one.
- The cockpit server process is pinned to one CPU with `taskset -c 11`. Each case records `loadavg` before and after. Squeal kept running in the worktree.

Sides:

- **Baseline:** `0320d57fb` (main with S1), built in a separate checkout. Its tree is marked dirty because the harness copied `vite.profiling.config.ts` into it.
- **Branch (final):** product code of `a2cc0e05d` (the S5 head rebased on `0069ac692`, S2 merged, with the 250 ms write bound), measured at `d216c54c3`, which changes only the harness. S2 does not touch the index path.
- **Branch per frame:** `447f546d9` (product code of `c48e4a06e`, before the rebase), which wrote the index once per animation frame. It is kept as evidence for the write-bound correction below.

The branch trees are marked dirty because the raw result files were untracked while the runs wrote them. The raw files record each side's built-content SHA256.

There were 5 runs per side. The baseline and final branch runs were interleaved. In branch run 1, a CDP `Page.navigate` timed out in the second case under host load; that run was repeated whole, and the tables use the repeat. The per-frame branch runs come from an earlier round, interleaved with an earlier baseline round. That round picked its update and tick targets from `listRunIds()` order, which is random, so about half of its runs renamed an archived row; the harness now uses fixed unarchived roots. Only the per-frame runs' cold phase, which has no targets, is used below. Each table cell is the median of that one field over the five runs, so a row can combine fields from different runs.

Evidence retained in the repository:

- [Raw runs](runs-index-patching/): `baseline-1..5.json`, `branch-1..5.json` (final) and `branch-perframe-1..5.json`.
- [Medians](runs-index-patching/summary.json) of every field, with each run's revision, build hash and `loadavg`.

Host: Linux 6.8.0-147-generic, AMD Ryzen 9 5950X, 24 reported CPU cores, Node v24.22.1. This is a shared development host.

## Sustained: 5 updates per second for 60 s

Each cell is **baseline → branch**.

| View | Index requests/min | Index bytes | All bytes | SSE bytes | Server CPU ms |
|---|---|---|---|---|---|
| closed | 111.3 → 2.0 | 22,315,968 → 405,188 | 22,628,244 → 717,609 | 200,091 → 199,535 | 4,320 → 3,180 |
| all-tasks | 124.1 → 4.0 | 25,237,081 → 806,147 | 25,462,488 → 1,031,070 | 200,087 → 200,968 | 4,080 → 2,960 |
| detail | 121.2 → 1.0 | 24,605,567 → 205,226 | 24,926,970 → 526,761 | 199,539 → 199,814 | 4,850 → 3,960 |

The remaining index reads are the backstop (60 s) in `closed` and `detail` and the global Tasks page's own 15 s poll in `all-tasks` (the coordinator kept that poll; it is a recorded remaining cost). `/runs/:id` reads did not change: 0 per minute without a detail and 74.7 → 74.6 per minute with the parent's detail open (S1's D1 behavior).

| View | Renderer ms | React commits | Commit ms total | Commit p95 ms | Probe p50 / p95 ms | Index read p95 ms |
|---|---|---|---|---|---|---|
| closed | 33,329 → 27,339 | 634 → 714 | 20,259 → 16,766 | 114.3 → 85.7 | 13.8 / 364.8 → 9.2 / 172.9 | 45.8 → 43.7 |
| all-tasks | 20,949 → 24,719 | 900 → 879 | 13,079 → 15,945 | 93.8 → 99.7 | 10.5 / 148.4 → 9.6 / 129.9 | 33.3 → 47.2 |
| detail | 13,272 → 12,774 | 1,363 → 1,419 | 4,592 → 5,080 | 10.9 → 11.9 | 13.0 / 54.7 → 12.6 / 34.2 | 42.1 → 26.1 |

On the project list (`closed`) the branch spends less render time. With the detail open it is level within noise. On the global Tasks page it spends about 22% more commit time and 18% more renderer time: rows change when frames arrive, at most every 250 ms, instead of when a refetch lands, and every change re-renders about 408 unmemoized rows. [After S3b](#after-s3b-main-33ca204e5-measured-2026-11-07) shows this cost gone on main.

## Cold bootstrap, one update and reconnect

| View / phase | Index requests | Index bytes | React commits | Commit ms total | Renderer ms |
|---|---|---|---|---|---|
| closed / cold | 8 → 2 | 1,370,231 → 378,556 | 24 → 30 | 504 → 386 | 2,106 → 1,368 |
| all-tasks / cold | 6 → 2 | 1,170,359 → 189,654 | 20 → 27 | 884 → 1,072 | 2,217 → 2,381 |
| detail / cold | 8 → 3 | 1,548,802 → 382,849 | 42 → 48 | 312 → 344 | 1,861 → 1,854 |
| closed / update | 1 → 0 | 199,642 → 0 | 2 → 2 | 14.0 → 7.8 | 369 → 254 |
| all-tasks / update | 1 → 0 | 199,641 → 0 | 2 → 2 | 96.8 → 73.5 | 201 → 177 |
| detail / update | 1 → 0 | 199,641 → 0 | 2 → 2 | 8.6 → 7.2 | 292 → 240 |
| closed / reconnect | 2 → 1 | 423,094 → 211,546 | 6 → 14 | 90 → 101 | 220 → 271 |
| all-tasks / reconnect | 3 → 2 | 634,638 → 423,092 | 8 → 14 | 224 → 443 | 396 → 750 |
| detail / reconnect | 2 → 1 | 423,092 → 211,546 | 16 → 22 | 29 → 54 | 749 → 901 |

A one-row title change of another project reaches the global Tasks page in 587 ms on the baseline (debounce plus a full read) and 138 ms on the branch (median time until the title shows on the page, polled every 50 ms). The `closed` and `detail` views do not list that project's titles. On reconnect the branch makes one fenced read where the baseline made two or three. Its reconnect commits are higher (all-tasks 224 → 443 ms, 8 → 14 commits): the stream reattaches, the fenced read lands, and the frames heard meanwhile are written in up to two bounded writes.

## Technical correction: at most one index write per 250 ms

The plan said "patches apply once per animation frame". The first branch runs did that, and showed a cost the plan did not foresee: every index write re-renders the app shell (`AppShellContainer` reads the index through `useWorkspaceSignals`), about 6 ms per commit here. During cold bootstrap the server sends a burst of about 120 run frames in about 2.5 s on both sides (cold SSE bytes are similar). The baseline turns that burst into one refetch per 400 ms. One write per frame turned it into about 190 commits.

| View / phase | Baseline (earlier round) | Per frame | Bound (final) |
|---|---|---|---|
| closed / cold: commits, commit ms, renderer ms | 24, 456, 1,848 | 191, 1,160, 2,679 | 30, 386, 1,368 |
| detail / cold: commits, commit ms, renderer ms | 50, 459, 2,574 | 245, 1,513, 4,004 | 48, 344, 1,854 |
| all-tasks / cold: commits, commit ms, renderer ms | 24, 1,057, 2,611 | 41, 2,240, 4,220 | 27, 1,072, 2,381 |

The baseline column comes from the round interleaved with the per-frame runs; the final round's baseline is in the tables above (closed cold 24 commits, detail 42, all-tasks 20). Only cold phases are compared here, because the earlier round's update and tick targets were random.

A controlled experiment on the per-frame build (closed view, cold) replaced the per-frame write with a 400 ms coalesced write and measured 25 commits and 482 ms, the baseline level. The index request counts and bytes do not depend on the cadence.

The coordinator and the planner accepted the correction on 2026-11-06, and the plan line is amended: the first patch after a quiet period lands in the next animation frame; later patches wait for the end of a 250 ms interval, and that wait never restarts. A single update therefore still lands in the next frame; sustained updates stay visible without a quiet period (at most 250 ms behind), which is still fresher than the baseline's 400 ms plus a full read. Usage ticks share the bound. Unit tests in `runs-index-sync.test.ts` cover each of these rules.

## After S3b (main 33ca204e5), measured 2026-11-07

S3b (hearsay-tools/cezarion#2815, merged as `33ca204e5`) virtualizes task groups above 100 rows and memoizes rows. This section measures current main, which holds S5 and S3b, against the same baseline `0320d57fb`. It answers the Phase 2 acceptance condition of epic hearsay-tools/cezarion#2728: the global Tasks page must not spend more React commit time than the baseline.

**Verdict: at or below the baseline.** Under sustained updates, the global Tasks page (`all-tasks`) spends 2,968 ms of React commit time per minute on main and 9,723 ms on the baseline (median, −69%). Every main run (2,472–3,116 ms) is below every baseline run (8,730–11,762 ms). The commit p95 fell from 69.0 ms to 8.4 ms, and the renderer time from 15,529 ms to 5,410 ms (−65%). No row-memoization follow-up is needed.

Method, and what changed since the S5 runs:

- **Sides.** Baseline: `0320d57fb` in a separate detached checkout, with `vite.profiling.config.ts` copied in, so its tree is marked dirty. Main: `33ca204e5` in a separate clean detached checkout (not dirty). Each side ran `npm run build:server` and the profiling web build. Main CI on `33ca204e5`: the merge-queue CI run [42323146063](https://github.com/hearsay-tools/cezarion/actions/runs/42323146063) passed on that exact commit; the push run on `main` was cancelled because the next merge superseded it.
- **Harness.** Both sides ran the harness of `33ca204e5`, from one checkout, with `--build-root` set to each side. Since S3b, the `all-tasks` update phase renames the first other-project root in display order. It reads that row from the last completed cold index response, and it asserts that the row is mounted, with no scroll and no extra request. The baseline mounts every row, so both sides rename the same logical row. The `closed` and `detail` update targets and the sustained tick targets did not change.
- **Rounds.** 5 rounds, interleaved (baseline 1, main 1, baseline 2, …), one benchmark at a time, cockpit server pinned with `taskset -c 11`. Every run passed on its first try. Each cell is the median of that one field over the five runs. Squeal kept running in the worktree.
- **Host load.** The 1-minute `loadavg` was 8–20 on 24 cores in every case, lower than in the S5 rounds (14–44). This is why the baseline's timing numbers here are lower than in the earlier tables. Compare timing numbers within one round only.

Evidence: [raw runs and medians](runs-index-patching/after-s3b/) (`baseline-1..5.json`, `main-1..5.json`, `summary.json`). The raw files record each side's revision, built-content SHA256, dirty flag and `loadavg` per case.

### Sustained: 5 updates per second for 60 s

Each cell is **baseline → main**. Load is the median 1-minute `loadavg` before / after the case.

| View | Commit ms total | Commit p95 ms | Commits | Renderer ms | Index requests/min | Index bytes | Probe p50 / p95 ms | Load |
|---|---|---|---|---|---|---|---|---|
| closed | 13,830 → 2,878 | 72.5 → 7.1 | 678 → 1,109 | 22,867 → 5,555 | 119.3 → 2.0 | 24,422,015 → 404,958 | 6.5 / 108.1 → 6.1 / 16.9 | 14.1 / 14.1 → 13.6 / 15.2 |
| all-tasks | 9,723 → 2,968 | 69.0 → 8.4 | 937 → 1,112 | 15,529 → 5,410 | 125.4 → 4.0 | 25,444,820 → 805,852 | 6.1 / 14.5 → 6.4 / 14.5 | 14.1 / 12.5 → 15.3 / 14.6 |
| detail | 3,407 → 3,332 | 7.8 → 7.0 | 1,354 → 1,437 | 9,661 → 8,912 | 121.8 → 1.0 | 24,624,149 → 204,706 | 6.1 / 18.8 → 6.9 / 24.4 | 12.7 / 13.6 → 14.4 / 14.1 |

Main commits more often (S5 writes the index when frames arrive), but each commit is small: the memoized rows skip unchanged objects, and a virtualized group mounts only its visible rows. The project list (`closed`) gains even more (−79% commit time), because its groups are virtualized too. With the detail open, the numbers are level within noise. The index request and byte counts repeat the S5 result. Server CPU in the sustained minute fell from 3,380 / 3,150 / 4,070 ms to 2,670 / 2,500 / 3,270 ms (closed / all-tasks / detail).

### Cold bootstrap

The cold phase has no probe; probe columns apply to the sustained phase only.

| View | Commit ms total | Commit p95 ms | Commits | Renderer ms | Index requests | Index bytes | Load before |
|---|---|---|---|---|---|---|---|
| closed | 292 → 167 | 113.9 → 28.8 | 20 → 33 | 1,171 → 797 | 5 → 2 | 971,712 → 378,904 | 14.1 → 13.6 |
| all-tasks | 572 → 223 | 138.8 → 22.8 | 19 → 32 | 1,616 → 891 | 5 → 2 | 973,098 → 190,757 | 14.1 → 15.3 |
| detail | 201 → 311 | 45.8 → 30.3 | 37 → 46 | 1,205 → 1,516 | 7 → 3 | 1,165,480 → 571,460 | 12.7 → 14.4 |

In the `detail` cold phase, main's median commit time is higher, but the per-run values overlap: baseline 186–396 ms, main 210–485 ms. The added commits (37 → 46) are the bounded index writes that S5 introduced; the S5 round showed the same direction (312 → 344 ms).

### One update and reconnect

| View / phase | Commit ms total | Commits | Renderer ms | Index requests |
|---|---|---|---|---|
| closed / update | 8.2 → 5.5 | 2 → 2 | 180 → 73 | 1 → 0 |
| all-tasks / update | 79.7 → 12.6 | 2 → 2 | 187 → 58 | 1 → 0 |
| detail / update | 6.5 → 6.9 | 2 → 2 | 219 → 236 | 1 → 0 |
| closed / reconnect | 64.0 → 23.8 | 6 → 12 | 211 → 190 | 2 → 1 |
| all-tasks / reconnect | 141.3 → 47.4 | 8 → 12 | 321 → 255 | 3 → 2 |
| detail / reconnect | 24.0 → 35.3 | 16 → 21 | 527 → 533 | 2 → 1 |

The renamed title of another project shows on the global Tasks page in 64 ms on main and 555 ms on the baseline (median).

## Remaining limits

- **Global Tasks page row renders (resolved by S3b, hearsay-tools/cezarion#2815).** On the S5 branch, every index change re-rendered about 408 unmemoized rows, and the page spent about 22% more React commit time than the baseline (13.1 s → 15.9 s per minute in that round). On main `33ca204e5` the rows are memoized and large groups are virtualized: the page spends 69% less commit time than the baseline (9.7 s → 3.0 s per minute) and 65% less renderer time ([After S3b](#after-s3b-main-33ca204e5-measured-2026-11-07)). The page's own 15 s poll remains (4 index reads per minute).
- **App shell re-render per index write.** Each write re-renders `AppShellContainer`, also when no project's signal count changed. A `select` on the index query could stop that; it was not part of this slice.
- **Truncated `truncated` flag after an unplaced delete.** A `run-deleted` for a row the index does not hold cannot be placed (it may be a worker or a row past the window). A `truncated` entry it made stale heals at the next reconciliation or the backstop read.
- **Foreign-process projects (D2).** Rows of projects that another cezar process runs refresh through the 60 s visible-only backstop, or the global Tasks page's 15 s poll while it is open.
- **Remote mode (D9).** Without the stream, the 5 s full reconciliation of the index remains; its snapshots pass the fence without extra reads (`runs-index-live.test.tsx`).
- **Measurement.** One tab per case, one fixture shape, and a shared host whose load differed between the baseline and the final branch runs. The per-frame and the final branch builds were measured in different rounds; compare their commit counts, not their times. The After S3b round ran on a less loaded host than the S5 rounds; compare its numbers only with each other.

## Reproduce

Use Node 24.21.0+, the repository's `agent-browser` provider and a booted e2e env (`sh .ai/scripts/test-env-up.sh`; the harness reads the browser settings from `.ai/qa/test-env.json`). `TMPDIR=/tmp` avoids Chrome's Unix-socket path limit inside a nested worktree.

```sh
pnpm install --frozen-lockfile
npm run build:server
(cd packages/web && npx vite build --config scripts/vite.profiling.config.ts)
TMPDIR=/tmp node --import tsx packages/web/scripts/benchmark-tabs.ts --workload index --cpu 11 --output docs/performance/runs-index-patching/branch-1.json
```

For the baseline, check out `0320d57fb` in a separate directory, install, run `npm run build:server`, copy `packages/web/scripts/vite.profiling.config.ts` into it and build its web the same way. Run the current harness from this checkout with `--build-root /absolute/path/to/baseline`. `--views closed,all-tasks,detail` selects views, `--sustained-ms` shortens the sustained phase for a smoke run, and `--profile-out PREFIX` writes a renderer CPU profile of the sustained phase; the report's runs use none of them. The After S3b round built main the same way, in its own clean detached checkout, and passed it with `--build-root` too, and wrote the result files outside both checkouts, so only the baseline tree is marked dirty (by the copied config).
