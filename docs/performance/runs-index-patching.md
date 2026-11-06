# Workspace runs index patched from the stream: measurements

This report goes with [hearsay-tools/cezarion#2729](https://github.com/hearsay-tools/cezarion/issues/2729) (plan `.ai/specs/2026-11-06-cockpit-performance-plan.md`, slice S5). Before the change, the cockpit refetched the whole `GET /workspace/runs-index` (808 rows, about 200 KB in this fixture) 400 ms after any run event. After the change, the workspace stream's `run-summary`, `run-deleted` and `usage` frames patch the cached rows. A full read runs only as a fenced reconciliation (bootstrap, reconnect, visibility restore, a `seq` gap, an unknown project, a truncated window move, a new project) and as the 60 s visible-only backstop (D2). The global Tasks page keeps its own 15 s poll.

Main result, 5 updates per second for 60 s: index requests fell from 109–117 per minute to 1–4 per minute in every view. Index bytes fell from 21.9–23.8 MB to 0.2–0.8 MB per minute. All bytes the page received in that minute fell by 95–98%. The workspace SSE bytes did not change (about 0.2 MB per minute on both sides), because S1 already sends summary frames. Server CPU in the sustained minute fell by 29–43%.

**Read the timing numbers with the host load.** Request counts, bytes and frame counts are deterministic: they repeat across runs. Timing numbers (CPU, renderer time, React commit time, latency) carry host noise. The baseline runs saw a one-minute `loadavg` of 18–55 on 24 cores; the final branch runs saw 15–22. The lower load favors the branch, so use the timing numbers for direction, not for exact ratios.

## Method and evidence

The workload is `benchmark-tabs.ts --workload index` ([harness](../../packages/web/scripts/benchmark-tabs.ts), [index workload](../../packages/web/scripts/benchmark-index.ts)). It serves a production build of each side from `tab-fixture-server.mjs --index`, a fixture cockpit with no agents and no tests:

- Two projects, both truncated: each index window holds 200 of 210 archived roots, plus the unarchived roots, for 808 index rows. The boot project also holds one running delegation parent with four running workers (workers never enter the index).
- One Chrome tab per case, with CDP network capture on the page and on the SharedWorker. Three views: `closed` (the boot project's task list), `all-tasks` (the global Tasks page) and `detail` (the delegation parent's task detail).
- Four phases per case, in order, each its own window: `cold` (navigation plus 8 s), `update` (one title change, 3 s), `sustained` (5 token ticks per second for 60 s, round-robin over the parent, its four workers and three roots of the other project; an ordinary `GET /api/v1/projects` probe every second) and `reconnect` (the server drops every connection, 8 s).
- Per window: `runs-index` and `/runs/:id` requests and body bytes, workspace SSE body bytes, all body bytes, `runs-index` request duration, probe p50/p95, cockpit server CPU, renderer task time (`Performance.getMetrics` `TaskDuration`) and React commits.
- React commit time comes from a harness-only build: [`vite.profiling.config.ts`](../../packages/web/scripts/vite.profiling.config.ts) aliases `react-dom/client` to `react-dom/profiling`, and a DevTools-hook shim records each committed root's `actualDuration`. Product code has no instrumentation. The shim also removes `console.timeStamp`: React 19.2's profiling build otherwise writes a Performance-panel track for every component of every commit, which is profiler cost and dominated renderer time on both sides.
- The cockpit server process is pinned to one CPU with `taskset -c 11`. Each case records `loadavg` before and after. Squeal kept running in the worktree.

Sides:

- **Baseline:** `0320d57fb` (main with S1), built in a separate checkout. Its tree is marked dirty because the harness copied `vite.profiling.config.ts` into it.
- **Branch (final):** `a2cc0e05d`, the S5 head rebased on `0069ac692` (S2 merged), with the 250 ms write bound. S2 does not touch the index path.
- **Branch per frame:** `447f546d9` (product code of `c48e4a06e`, before the rebase), which wrote the index once per animation frame. It is kept as evidence for the write-bound correction below.

The branch trees are marked dirty because the raw result files were untracked while the runs wrote them. The raw files record each side's built-content SHA256.

There were 5 runs per side. Baseline and per-frame branch runs were interleaved; the final branch runs ran after the rebase. Each table cell is the median of that one field over the five runs, so a row can combine fields from different runs.

Evidence retained in the repository:

- [Raw runs](runs-index-patching/): `baseline-1..5.json`, `branch-1..5.json` (final) and `branch-perframe-1..5.json`.
- [Medians](runs-index-patching/summary.json) of every field, with each run's revision, build hash and `loadavg`.

Host: Linux 6.8.0-147-generic, AMD Ryzen 9 5950X, 24 reported CPU cores, Node v24.22.1. This is a shared development host.

## Sustained: 5 updates per second for 60 s

Each cell is **baseline → branch**.

| View | Index requests/min | Index bytes | All bytes | SSE bytes | Server CPU ms |
|---|---|---|---|---|---|
| closed | 108.7 → 2.0 | 21,927,968 → 406,408 | 22,242,149 → 721,681 | 202,531 → 204,314 | 4,750 → 3,210 |
| all-tasks | 116.9 → 4.0 | 23,586,862 → 805,912 | 23,814,466 → 1,035,484 | 203,160 → 203,416 | 4,950 → 2,840 |
| detail | 117.1 → 1.0 | 23,823,554 → 202,672 | 24,147,515 → 527,435 | 205,041 → 201,983 | 5,430 → 3,870 |

The remaining index reads are the backstop (60 s) in `closed` and `detail` and the global Tasks page's own 15 s poll in `all-tasks` (the coordinator kept that poll; it is a recorded remaining cost). `/runs/:id` reads did not change: 0 per minute without a detail and 74.4 → 74.7 per minute with the parent's detail open (S1's D1 behavior).

| View | Renderer ms | React commits | Commit ms total | Commit p95 ms | Probe p50 / p95 ms | Index read p95 ms |
|---|---|---|---|---|---|---|
| closed | 35,259 → 26,389 | 624 → 719 | 21,297 → 15,750 | 123.3 → 83.8 | 17.8 / 421.1 → 7.1 / 206.8 | 48.9 → 51.9 |
| all-tasks | 23,991 → 21,996 | 804 → 898 | 14,841 → 13,989 | 109.1 → 86.5 | 15.0 / 224.0 → 7.9 / 98.5 | 50.4 → 47.5 |
| detail | 19,509 → 12,382 | 1,352 → 1,414 | 7,075 → 4,335 | 19.9 → 9.7 | 19.2 / 86.0 → 9.9 / 37.6 | 64.8 → 25.8 |

The branch commits a little more often, because rows change when frames arrive rather than when a refetch lands. The commit and renderer totals are lower, but the branch ran at lower host load; read them as "no regression", not as a measured gain.

## Cold bootstrap, one update and reconnect

| View / phase | Index requests | Index bytes | React commits | Commit ms total | Renderer ms |
|---|---|---|---|---|---|
| closed / cold | 7 → 2 | 1,366,575 → 376,060 | 24 → 34 | 456 → 423 | 1,848 → 1,647 |
| all-tasks / cold | 7 → 2 | 1,174,715 → 189,713 | 24 → 28 | 1,057 → 1,024 | 2,611 → 2,345 |
| detail / cold | 12 → 3 | 2,145,390 → 570,071 | 50 → 47 | 459 → 290 | 2,574 → 1,640 |
| closed / update | 1 → 0 | 199,638 → 0 | 2 → 2 | 10.5 → 7.3 | 329 → 260 |
| all-tasks / update | 1 → 0 | 199,638 → 0 | 2 → 2 | 93.7 → 84.3 | 401 → 170 |
| detail / update | 1 → 0 | 199,639 → 0 | 2 → 2 | 19.5 → 5.7 | 498 → 258 |
| closed / reconnect | 2 → 1 | 423,086 → 211,544 | 6 → 12 | 118 → 90 | 291 → 188 |
| all-tasks / reconnect | 3 → 2 | 634,624 → 423,084 | 8 → 12 | 219 → 349 | 430 → 599 |
| detail / reconnect | 2 → 1 | 423,088 → 211,543 | 17 → 22 | 61 → 44 | 911 → 725 |

A one-row title change of another project reaches the global Tasks page in 761 ms on the baseline (debounce plus a full read) and 157 ms on the branch (median time until the title shows on the page, polled every 50 ms). On reconnect the branch makes one fenced read where the baseline made two or three. On `all-tasks / reconnect` the branch commit total is higher (219 → 349 ms); the 12 commits are the stream reattaching and the fenced read landing.

## Technical correction: at most one index write per 250 ms

The plan said "patches apply once per animation frame". The first branch runs did that, and showed a cost the plan did not foresee: every index write re-renders the app shell (`AppShellContainer` reads the index through `useWorkspaceSignals`), about 6 ms per commit here. During cold bootstrap the server sends a burst of about 120 run frames in about 2.5 s on both sides (cold SSE bytes are similar). The baseline turns that burst into one refetch per 400 ms. One write per frame turned it into about 190 commits.

| View / phase | Baseline | Per frame | Bound (final) |
|---|---|---|---|
| closed / cold: commits, commit ms, renderer ms | 24, 456, 1,848 | 191, 1,160, 2,679 | 34, 423, 1,647 |
| detail / cold: commits, commit ms, renderer ms | 50, 459, 2,574 | 245, 1,513, 4,004 | 47, 290, 1,640 |
| all-tasks / cold: commits, commit ms, renderer ms | 24, 1,057, 2,611 | 41, 2,240, 4,220 | 28, 1,024, 2,345 |
| all-tasks / sustained: commits, commit ms, renderer ms | 804, 14,841, 23,991 | 719, 19,283, 29,864 | 898, 13,989, 21,996 |

A controlled experiment on the per-frame build (closed view, cold) replaced the per-frame write with a 400 ms coalesced write and measured 25 commits and 482 ms, the baseline level. The index request counts and bytes do not depend on the cadence.

The coordinator and the planner accepted the correction on 2026-11-06, and the plan line is amended: the first patch after a quiet period lands in the next animation frame; later patches wait for the end of a 250 ms interval, and that wait never restarts. A single update therefore still lands in the next frame; sustained updates stay visible without a quiet period (at most 250 ms behind), which is still fresher than the baseline's 400 ms plus a full read. Usage ticks share the bound. Unit tests in `runs-index-sync.test.ts` cover each of these rules.

## Remaining limits

- **Global Tasks page row renders (owner: S3, hearsay-tools/cezarion#2732).** On both sides, every index change re-renders about 408 row components of the global Tasks page: the rows are not memoized. Unchanged rows keep their object identity through the patch and through TanStack's `replaceEqualDeep`, so a memoized row would skip them. With per-frame writes this made the page's sustained commit time 30% higher than the baseline (14.8 s → 19.3 s); with the 250 ms bound it is level (14.8 s → 14.0 s, at lower host load). The page's own 15 s poll also remains.
- **App shell re-render per index write.** Each write re-renders `AppShellContainer`, also when no project's signal count changed. A `select` on the index query could stop that; it was not part of this slice.
- **Truncated `truncated` flag after an unplaced delete.** A `run-deleted` for a row the index does not hold cannot be placed (it may be a worker or a row past the window). A `truncated` entry it made stale heals at the next reconciliation or the backstop read.
- **Foreign-process projects (D2).** Rows of projects that another cezar process runs refresh through the 60 s visible-only backstop, or the global Tasks page's 15 s poll while it is open.
- **Remote mode (D9).** Without the stream, the 5 s full reconciliation of the index remains; its snapshots pass the fence without extra reads (`runs-index-live.test.tsx`).
- **Measurement.** One tab per case, one fixture shape, and a shared host whose load differed between the baseline and the final branch runs. The per-frame and the final branch builds were measured at different loads, too; compare their commit counts, not their times.

## Reproduce

Use Node 24.21.0+, the repository's `agent-browser` provider and a booted e2e env (`sh .ai/scripts/test-env-up.sh`; the harness reads the browser settings from `.ai/qa/test-env.json`). `TMPDIR=/tmp` avoids Chrome's Unix-socket path limit inside a nested worktree.

```sh
pnpm install --frozen-lockfile
npm run build:server
(cd packages/web && npx vite build --config scripts/vite.profiling.config.ts)
TMPDIR=/tmp node --import tsx packages/web/scripts/benchmark-tabs.ts --workload index --cpu 11 --output docs/performance/runs-index-patching/branch-1.json
```

For the baseline, check out `0320d57fb` in a separate directory, install, run `npm run build:server`, copy `packages/web/scripts/vite.profiling.config.ts` into it and build its web the same way. Run the current harness from this checkout with `--build-root /absolute/path/to/baseline`. `--views closed,all-tasks,detail` selects views, `--sustained-ms` shortens the sustained phase for a smoke run, and `--profile-out PREFIX` writes a renderer CPU profile of the sustained phase; the report's runs use none of them.
