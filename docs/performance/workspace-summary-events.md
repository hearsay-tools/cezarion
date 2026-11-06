# Workspace stream summary events: measurements

This report goes with [hearsay-tools/cezarion#2730](https://github.com/hearsay-tools/cezarion/issues/2730) (plan `.ai/specs/2026-11-06-cockpit-performance-plan.md`, slice S1). Before the change, the workspace stream wrote one full run record per connection per event, and the cockpit turned each record into a list row. After the change, the cockpit reads `GET /api/v1/workspace/events?runs=summary`. That stream carries the list row, and one shared feed builds each frame's text once per mode.

Main result for one large delegation family, one stream and the detail closed: the stream bytes fell from 14.6 MB to 0.12 MB (−99.2%). The p95 frame fell from 264,760 bytes to 412 bytes. The cockpit's per-frame parse and validation p95 fell from 0.44 ms to 0.04 ms. With the parent's detail open, the total bytes still fell by 62% (14.9 MB to 5.7 MB). The cost is 21 detail fetches instead of 1, which is the approved D1 behavior. With four connections, the shared feed cut the server dispatch total for full records from 228 ms to 106 ms.

## Method and evidence

The workload is [`bench:workspace-events`](../../packages/cezar/scripts/benchmark-workspace-events.ts) (`npm run bench:workspace-events -w @wjarka/cezarion`). It starts one in-process app over a fresh store, with no agents and no tests. It seeds one delegation root with a 256 KiB task and six active workers with 16 KiB tasks. Every eighth update changes the parent's token count and current step. The other updates are worker token ticks. Each phase sends 300 updates at 40 per second, then waits 600 ms. Two warmup phases run first and are not reported.

- **Phases.** `none` has no stream, so it measures the store cost alone. `full` reads `/workspace/events`. `summary` reads `/workspace/events?runs=summary`. The `full` and `summary` phases each run with the parent's detail closed and open.
- **Server dispatch.** This is the synchronous time of each update: the store write, the frame projection, the stringify and the enqueue on every connection.
- **Event bytes.** These are the run frames one connection received, counted as written on the wire.
- **Client parse.** This is the cockpit's per-frame work before a cache write. For a full record it is `JSON.parse` and `toRunSummary`. For a summary it is `JSON.parse` and the contract's zod schema.
- **Detail open.** Each fetch is a real `GET /runs/:id`. With a full stream, the cockpit refreshes the detail 400 ms after the parent goes quiet. With a summary stream, it fetches at once, then at most once per 400 ms for the parent's own events (D1).
- **API latency.** The workload sends `GET /workspace/runs-index` every 250 ms during each phase.

The baseline is `bc5764da7`. The branch is `cez/5c375ae8`, at the S1 commits. The same script ran unchanged on both. The baseline ignores `?runs=summary`, so its `summary` phases repeat its full stream. The cockpit's before/after comparison is therefore baseline `full` against branch `summary`.

There were 5 runs per side and per connection count, interleaved by side. Each run was pinned to one CPU with `taskset -c 11`. The tables report the median of the five runs. Squeal was stopped in this worktree during the runs.

Host: Linux 6.8.0-147-generic, AMD Ryzen 9 5950X, 24 reported CPU cores, Node v24.22.1. This development host is shared and was heavily loaded. The one-minute `loadavg` was between 19.9 and 93.1 across the phases; the raw files record it before and after each phase. Byte and fetch counts are deterministic. Timing numbers are noisy at this load.

Evidence retained in the repository:

- [Raw runs](workspace-summary-events/): `baseline-c1-*.json`, `branch-c1-*.json`, `baseline-c4-*.json` and `branch-c4-*.json`. Each file holds every phase of one run, with p50, p95 and totals.
- [Medians](workspace-summary-events/summary.json) of the tables below.

Fixture sizes: parent record 264,675 bytes, worker record 17,312 bytes, parent summary 250 bytes.

## One connection: cockpit path

Each cell is **before → after** (baseline `full` → branch `summary`).

| Detail | Run frames | Frame p50 / p95 (bytes) | Stream bytes | Detail GETs | Total bytes |
|---|---:|---|---:|---:|---:|
| closed | 300 → 300 | 17,372 / 264,760 → 412 / 412 | 14,612,234 → 122,901 | 0 → 0 | 14,612,234 → 122,901 |
| open | 300 → 300 | 17,372 / 264,760 → 412 / 412 | 14,612,234 → 122,920 | 1 → 21 | 14,876,957 → 5,682,095 |

| Detail | Dispatch p50 / p95 (ms) | Dispatch total (ms) | Client parse p50 / p95 (ms) | Client total (ms) | Process CPU (ms) |
|---|---|---:|---|---:|---:|
| closed | 0.19 / 1.17 → 0.25 / 0.44 | 101.9 → 97.3 | 0.023 / 0.438 → 0.021 / 0.042 | 25.4 → 14.2 | 593 → 320 |
| open | 0.19 / 1.08 → 0.23 / 0.40 | 93.9 → 77.4 | 0.027 / 0.319 → 0.019 / 0.041 | 21.0 → 15.1 | 481 → 475 |

| Detail | `runs-index` p50 / p95 (ms) | Detail GET p50 / p95 (ms) |
|---|---|---|
| closed | 1.87 / 7.05 → 1.92 / 5.33 | — |
| open | 2.10 / 8.17 → 1.93 / 5.41 | 2.13 / 2.13 → 2.07 / 4.21 |

The `none` phase (no stream) dispatched in 0.12 ms p50 on both sides, so that is the store's own cost. A summary costs more per event than a small full record, because `toRunSummary` validates the delegation with zod and the feed digests the relationships fields. A full record's cost grows with its size, so the summary removes the p95, which is the large parent's stringify. Process CPU includes the in-process reader, so do not compare it on its own.

## Four connections: the shared feed

Four connections stand for four browser profiles, or other readers of one server. Each cell is **before → after**.

| Phase | Dispatch p50 / p95 (ms) | Dispatch total (ms) | Process CPU (ms) |
|---|---|---:|---:|
| full, detail closed | 0.33 / 3.73 → 0.21 / 1.16 | 228.2 → 106.2 | 821 → 750 |
| cockpit path (baseline full → branch summary), detail closed | 0.33 / 3.73 → 0.26 / 0.46 | 228.2 → 82.9 | 821 → 346 |
| cockpit path, detail open | 0.31 / 3.55 → 0.25 / 0.44 | 219.4 → 84.8 | 809 → 470 |

Before the change, each connection stringified each record. Now the feed builds each frame once per mode, so the dispatch total of the legacy full stream no longer grows with the number of connections.

## Remaining limits

- An open detail now costs one `GET /runs/:id` per 400 ms under sustained parent events (D1). In this fixture that is 21 fetches of the 264 KiB parent, or 5.6 MB. The plan's escalation, pushing full records for demanded runs over the task lane, is not needed: the total bytes are still 62% lower.
- The index and report refresh cadence is unchanged in S1 (plan item 8). S5 replaces it.
- This is a Node workload. It does not measure browser rendering, React commits or Event Timing. The client numbers cover the per-frame parse and validation only.
