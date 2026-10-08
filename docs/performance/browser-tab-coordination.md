# Browser tab coordination: HTTP/1.1 measurements

This report accompanies [hearsay-tools/cezarion#924](https://github.com/hearsay-tools/cezarion/issues/924). The unchanged cockpit exhausted Chrome's six ordinary HTTP/1.1 connections with workspace/task SSEs. Local coordination bounds live traffic to one workspace SSE, one multiplexed task SSE and one topic WebSocket per same-origin coordination group. A preview pane retains its separate opt-in binary socket.

The full tab matrix missed 72 of 130 ordinary GET deadlines before the change and 0 of 175 afterward. Current local cases kept at most two SSE streams and one topic socket across all tested tab counts.

## Method and evidence

Measurements use production builds with polling enabled, real HTTP/1.1, one Chrome profile per case, and fixture-owned local state. The baseline is `c961c04ab6633373ec8377cf08674814d255a760`; the implementation includes the subsequent `origin/main` integration at `f9d6e9f6`. The implementation was committed as `db0bb085` during measurement, without changing the built files. The final after reports record the starting Git state and built-content SHA256; the tab and native-window after samples use the same artifact. The original baseline predates the hash field; the native-window baseline records the preserved baseline artifact hash. No real agent or paid provider runs in the fixture.

The maintained [harness](../../packages/web/scripts/benchmark-tabs.ts) covers overview pages, duplicate views of one task, and distinct tasks across two projects, each with 1/3/6/10 tabs. Each case has five seconds of cold-load/warmup observation followed by 20 seconds of sampling, either idle or streaming 20 small assistant messages per second per selected run. Exactly one tab is visible in the tab matrix; the supplement uses separate native windows. CDP observes worker traffic as well as page traffic before navigation. Ordinary GET probes have a two-second deadline. Real mouse clicks open the command palette, and the measured result is the rendered dialog; this measures local interaction responsiveness, not a server mutation round-trip.

Host: Linux 6.8.0-142-generic, AMD Ryzen 9 5950X, 24 reported CPU cores, reported RAM between 45.4 and 46.6 GiB across the samples. Browser: Chrome 154.0.8037.97. This is a shared development host. Each case ran once, without randomization or confidence intervals.

Evidence retained in the repository:

- [Full measurements CSV](tab-coordination/measurements.csv): every case's cold/request counts, pending and failed requests, CPU/RSS, JS heap, renderer task time, and GET/click p50/p95/max.
- Raw [before](tab-coordination/before.json) and [after](tab-coordination/after.json) samples, including individual probe failures, page visibility, request protocols and initial/end-of-sample server listener counts.
- Raw native-window [before](tab-coordination/windows-before.json) and [after](tab-coordination/windows-after.json) samples.

Requests/s includes the measurement's own probes. Aborted hidden-page requests count as request failures; the failed GET column specifically measures starvation. Cold `main` presence proves the shell rendered, not that every request finished; pending requests and real transcript assertions provide the additional evidence. Server listener counts are observable fixture subscriptions, not a claim to enumerate every internal publisher.


## Connection and request results

Each cell is **before → after**. “Failed GET” means the two-second projects probe did not complete. Percentiles include deadlines as censored samples; a timeout is not a measured successful latency.

| Workload | Tabs | State | SSE | Topic WS | Failed GET / samples | GET p95 (ms) | Requests/s |
|---|---:|---|---|---|---|---|---|
| overview | 1 | idle | 1 → 1 | 1 → 1 | 0/7 → 0/7 | 5.1 → 5.5 | 0.55 → 0.55 |
| overview | 1 | stream | 1 → 1 | 1 → 1 | 0/7 → 0/7 | 5.5 → 4.6 | 0.55 → 0.55 |
| overview | 3 | idle | 3 → 1 | 3 → 1 | 0/7 → 0/7 | 5.4 → 5.7 | 0.6 → 0.6 |
| overview | 3 | stream | 3 → 1 | 3 → 1 | 0/8 → 0/8 | 6.7 → 7.3 | 0.6 → 0.6 |
| overview | 6 | idle | 6 → 1 | 4 → 1 | 4/4 → 0/7 | 2001.7 → 4.9 | 0.45 → 0.55 |
| overview | 6 | stream | 6 → 1 | 4 → 1 | 5/5 → 0/7 | 2000.9 → 5.2 | 0.5 → 0.55 |
| overview | 10 | idle | 6 → 1 | 6 → 1 | 4/4 → 0/7 | 2000.5 → 6.3 | 0.45 → 0.6 |
| overview | 10 | stream | 6 → 1 | 6 → 1 | 5/5 → 0/8 | 2000.3 → 5 | 0.5 → 0.6 |
| repeated | 1 | idle | 2 → 2 | 1 → 1 | 0/7 → 0/7 | 8.4 → 7.3 | 0.5 → 0.5 |
| repeated | 1 | stream | 2 → 2 | 1 → 1 | 0/8 → 0/8 | 128.7 → 43.9 | 0.74 → 0.74 |
| repeated | 3 | idle | 6 → 2 | 3 → 1 | 4/4 → 0/7 | 2000.4 → 10.8 | 0.25 → 0.5 |
| repeated | 3 | stream | 6 → 2 | 3 → 1 | 5/5 → 0/7 | 2020.3 → 192.7 | 0.41 → 0.7 |
| repeated | 6 | idle | 6 → 2 | 6 → 1 | 5/5 → 0/7 | 2000.4 → 13.8 | 0.45 → 0.5 |
| repeated | 6 | stream | 6 → 2 | 5 → 1 | 4/4 → 0/8 | 2067.3 → 169.2 | 0.3 → 0.72 |
| repeated | 10 | idle | 6 → 2 | 7 → 1 | 5/5 → 0/7 | 2000.4 → 38.2 | 0.27 → 0.5 |
| repeated | 10 | stream | 6 → 2 | 7 → 1 | 4/4 → 0/7 | 2000.5 → 106.2 | 0.4 → 0.69 |
| distinct | 1 | idle | 2 → 2 | 1 → 1 | 0/7 → 0/7 | 36.7 → 26.7 | 0.5 → 0.5 |
| distinct | 1 | stream | 2 → 2 | 1 → 1 | 0/7 → 0/7 | 111 → 28.3 | 0.7 → 0.7 |
| distinct | 3 | idle | 6 → 2 | 3 → 1 | 5/5 → 0/7 | 2001.1 → 4.7 | 0.27 → 0.5 |
| distinct | 3 | stream | 6 → 2 | 3 → 1 | 5/5 → 0/8 | 2018.2 → 8.6 | 0.4 → 0.75 |
| distinct | 6 | idle | 6 → 2 | 3 → 1 | 5/5 → 0/7 | 2000.9 → 6.8 | 0.45 → 0.5 |
| distinct | 6 | stream | 6 → 2 | 4 → 1 | 4/4 → 0/8 | 2005.1 → 24.6 | 0.4 → 0.75 |
| distinct | 10 | idle | 6 → 2 | 4 → 1 | 4/4 → 0/7 | 2001.9 → 5.4 | 0.4 → 0.5 |
| distinct | 10 | stream | 6 → 2 | 2 → 1 | 4/4 → 0/8 | 2000.5 → 14.2 | 0.4 → 0.75 |

## Resource samples at ten tabs

CPU is aggregate process CPU time during the sample, not wall time or utilization. These are one-run samples on a shared host; they establish observed costs, not a causal CPU or memory improvement. RSS sums can double-count shared pages. Streaming CPU increased in these samples. The connection-starved baseline and shared host prevent conclusions about CPU efficiency at equal delivered work. The CSV contains all 1/3/6/10-tab resource and interaction measurements.

| Workload / state | Browser CPU ms | Browser RSS MiB | Server CPU ms | Server RSS MiB | Click p95 ms |
|---|---|---|---|---|---|
| overview / idle | 1730 → 2760 | 3119.7 → 3211.0 | 40 → 320 | 195.1 → 199.3 | 57.2 → 54.2 |
| overview / stream | 3070 → 3390 | 3127.1 → 3216.4 | 390 → 440 | 218.1 → 217.6 | 66.7 → 59.4 |
| repeated / idle | 2110 → 3790 | 3085.6 → 3115.2 | 80 → 270 | 197.6 → 197.8 | 126.2 → 146.0 |
| repeated / stream | 3250 → 27510 | 3115.6 → 3307.8 | 210 → 700 | 197.3 → 209.8 | 73.2 → 311.6 |
| distinct / idle | 3800 → 2910 | 3104.5 → 3118.7 | 50 → 180 | 193.5 → 205.6 | 156.4 → 54.0 |
| distinct / stream | 3980 → 18410 | 3107.8 → 3346.4 | 670 → 670 | 221.0 → 232.6 | 120.8 → 92.3 |

## Simultaneously visible windows

Supplemental distinct-task cases use the same five-second warmup and 20-second sample, with separate native windows in one Chrome profile.

| Windows | State | SSE before → after | Topic WS before → after | Failed GET before → after |
|---:|---|---|---|---|
| 1 | idle | 2 → 2 | 1 → 1 | 0/7 → 0/7 |
| 1 | stream | 2 → 2 | 1 → 1 | 0/8 → 0/8 |
| 10 | idle | 6 → 2 | 4 → 1 | 4/4 → 0/7 |
| 10 | stream | 6 → 2 | 4 → 1 | 4/4 → 0/7 |

## Lifecycle and preview evidence

The automated [tab suite](../../packages/web/e2e/tab-coordination.e2e.ts) verifies ten mixed tabs and ten visible task windows, real transcript content in two projects, late join, unique recovery after navigation/history restoration, worker termination, finite recovery when SharedWorker construction fails, Basic Auth with native network interruption, frozen-document resume, server connection loss, and return to initial listener counts after the last document closes. The original ten-tab ordinary-request test was observed failing on the unchanged production build before implementation.

[Owner/coordinator tests](../../packages/web/src/api/live-coordinator.test.ts) cover leases, feed silence independent of heartbeat, stale epochs, simultaneous generation resets, authenticated restore ordering, changed boot aliases/deployment mode and failed-auth retry. [Replay tests](../../packages/cezar/src/server/run-event-feed.test.ts) cover compressed and partial history, expired cursors, deletion/closure and bounded buffers. The wire-budget tests cover one byte below, exactly at and one byte above the complete UTF-8 SSE frame cap.

The real [preview test](../../packages/web/e2e/live-preview.e2e.ts) receives and interacts with a browser frame, observes the old viewer's socket close when hidden, lets a second viewer claim the session, verifies the restored first viewer shows “taken over,” and verifies explicit “Use it here” reclaims it. The retained [preview lifecycle measurements](tab-coordination/preview-lifecycle.json) record one socket closure, the restored taken-over state, and a 646-pixel-wide canvas after explicit reclaim. Preview is a lifecycle measurement here; this report makes no preview encoding CPU or frame-rate claim. Mobile task content was inspected at 360×640 in light and dark themes: no horizontal overflow, readable wrapped transcript, and the existing controls retained. Reduced-motion preference was also checked. No artwork or new animation was needed.

## Remaining limits

- Remote deployments, configured API bases with a path prefix, and unavailable/failed workers use finite authenticated HTTP, with no ordinary persistent SSE or WebSocket. Expected freshness is about two seconds for tasks and five seconds for workspace reconciliation, plus transport delay; failures back off up to 30 seconds. Simultaneously visible fallback tabs still duplicate finite requests.
- A shared task stream accepts at most 32 distinct runs and 1 MiB per complete SSE frame; capacity overflow uses finite recovery. Oversized events use the existing authoritative history/context hydration path.
- Hidden documents release demand immediately; crashed/frozen owners are reclaimed by 15-second leases or the independent feed watchdog. Whole-browser/OS suspension can delay timers until execution resumes.
- Caches, React rendering and initial hydration remain document-local, so memory is not constant with tab count. A background tab saves live work but still retains its page.
- Baseline samples ran while other development work was present. After samples were collected separately from the full gate. CPU/RSS numbers are descriptive only. The robust comparison is connection bounds and actual completed/deadline-missed requests.
- An earlier after run and an incomplete rerun that hit a CDP navigation timeout were retained as local diagnostics and excluded from these tables. They are not substituted for the final build's samples.

## Reproduce

Use Node 24.15+ and the repository's configured `agent-browser` provider. The normal browser setup is documented in [the E2E guide](../../packages/web/e2e/README.md). Do not set `VITE_CEZ_E2E=1`: that intentionally disables periodic queries. `TMPDIR=/tmp` avoids Chrome's Unix-socket path limit when running inside a deeply nested task worktree.

```sh
npm ci
npm run build
TMPDIR=/tmp node --import tsx packages/web/scripts/benchmark-tabs.ts --output .ai/qa/924/after.json
TMPDIR=/tmp node --import tsx packages/web/scripts/benchmark-tabs.ts --windows --workload distinct --counts 1,10 --output .ai/qa/924/windows-after.json
```

Build the baseline in a separate checkout of `c961c04ab6633373ec8377cf08674814d255a760` with its own `npm ci` and `npm run build`. Run the current harness with `--build-root /absolute/path/to/baseline`, keeping all other options identical. Never install dependencies into a checkout while its tests are running. `--quick` uses one-second warmup/three-second sampling solely to smoke-test the harness; none of the report tables uses it.

The application and fixture servers are shut down by the harness after each case. Each case gets a new browser profile and private workspace; no host credentials or real project histories are used.
