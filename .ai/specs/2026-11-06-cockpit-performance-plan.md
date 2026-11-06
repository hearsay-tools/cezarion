# Reduce cockpit work during concurrent tasks

Epic: hearsay-tools/cezarion#2728. Baseline: `main` at `b47be7af6`. Planner task
`4935efd3`. The owner approved this plan and decisions D1-D9 on 2026-11-06. Line numbers are as of the baseline; each slice moves them.

## Goal

The cockpit does less avoidable work while many tasks run: fewer full-index fetches,
smaller live events, fewer report scans, fewer mounted rows and fewer duplicate Git
probes. Freshness, reconnect recovery, selection and task controls keep their documented
behavior. Every slice ships with a repeatable before/after measurement.

## Evidence

The diagnosis (task `2240aa72`, artifact `554735cd`) is source-backed. No speedup was
benchmarked. Each slice therefore starts with a committed workload that runs unchanged on
the baseline and on the branch.

- `GET /workspace/runs-index` rebuilds every visible project's window on each call (808 rows,
  about 764 KiB in the sample). The app shell always mounts it
  (`web/src/components/use-workspace-signals.ts:44`). `createRunsIndexRefresher`
  (`web/src/api/global-events.tsx:103-133`) invalidates it, and every active report query,
  400 ms after any `run` or `run-deleted` event. The timer holds its first deadline, so
  sustained events allow about 150 full-index requests per minute (ceiling, not measured).
- `/workspace/events` (`server/server.ts:4338-4433`) stringifies a full `RunRecord` per
  connection per event. The browser projects it to a summary (`web/src/api/events.ts:125`).
- Each `GET /reports` reconciles every live and dirty run with a directory scan, then checks
  each row of the page (`artifacts/reports-index.ts:83-167`).
- The project page mounts the detailed table and the mobile cards even when hidden
  (`web/src/routes/tasks-overview.tsx:724-794`). Hidden detailed rows subscribe to live usage.
  The global page mounts every filtered row (`web/src/routes/global-tasks.tsx:792-804`).
- `probeRoot` (`workspace/projects.ts:277-283`) caches only completed probes. Concurrent
  misses each run `getRepoInfo` (`server/git.ts:49-73`, three Git processes).

## Measurement rules (all slices)

- Each slice commits its workload script and publishes results in
  `docs/performance/<slug>.md` with raw JSON or CSV beside it, in the format of
  `docs/performance/browser-tab-coordination.md`.
- A workload runs on an isolated fixture cockpit with no agents and no tests. It records
  `loadavg` before and after and pins to one CPU with `taskset` where practical, so cockpit
  work is separated from external agent and test work (epic criterion 2).
- Resource numbers (bytes, requests, scans, probes, mounted components) come with latency
  numbers (API p50/p95) and, for browser paths, interaction numbers (React commit duration,
  long tasks, Event Timing) (epic criterion 4).
- Reuse existing harnesses: `packages/web/scripts/benchmark-tabs.ts` with
  `packages/web/scripts/tab-fixture-server.mjs` (production build, CDP network capture including the
  SharedWorker, server CPU), `packages/cezar/scripts/benchmark-run-store.ts`,
  `benchmark-family-reconcile.ts` and `benchmark-stuck-destroys.ts` (server CPU versus Git
  child CPU). React commit timing uses a harness-only `react-dom/profiling` alias and a
  DevTools-hook shim; product code needs no instrumentation.
- Run 5 times and report medians.

## Plan

### Phase 1: four independent slices

#### S1. Summary events on the workspace stream (hearsay-tools/cezarion#2730)

1. **Opt-in mode.** `GET /api/v1/workspace/events?runs=summary`, validated with
   `queryZodValidator`. Without the parameter, the workspace stream stays byte-identical.
   Project `/events`, its legacy alias and `/runs/:id/events` (read by CLI `watch`) are
   unchanged. The cockpit opts in.
2. **One shared feed.** New `server/workspace-run-feed.ts` subscribes once per built
   context, takes over attach, `onContextBuilt` and `project-removed` detach from
   `server.ts:4341-4415`, assigns a process-wide `seq`, and projects and serializes each
   event once. Connections write the cached string.
3. **Contract.** New `contract/src/workspace-events.ts`:
   - `run-summary`: `{ project, seq, run: runSummarySchema, relationships: string }`.
     `run` is exactly `withLiveUsage(toRunSummary(record))`, the row `/runs-index` returns.
     `relationships` is a digest of the fields the relationships route renders (status,
     currentStepId, role, parentRunId, workspace resource, destroy state,
     executionRevision, wait phase).
   - `run-deleted`: `{ project, seq, id }`. `ready`: `{ generation, seq }`.
   - `usage`: same shape; summary mode sends one empty `{project, usage: {}}` when a
     project's last live row stops.
   - `seq` is in the data, not the SSE `id:`; the stream has no replay.
   - `runsIndexResponseSchema` gains required `generation` and `eventSeq`. The route reads
     `eventSeq` after `await projectRunSources()` and before its synchronous loop.
4. **Ordering.** Within one connection and generation, `seq` is contiguous across projects.
   A jump means lost frames and triggers reconciliation. A new generation is a reset.
   Documented in `docs/areas/realtime-events.md`.
5. **Web.** `events.ts` adds a distinct `{type: 'run-summary', summary}`. `mergeRun` keeps
   accepting only `RunRecord`, so a summary never stands in for a full record. Lists and
   archived pages replace rows from the summary. The relationships refresher compares the
   digest.
6. **Detail.** For an observed detail, a `run-summary` strips `finishBlocked` and starts a
   fetch at once if none is in flight, then at most one trailing fetch per 400 ms. A
   response whose fetch started before the latest event never restores `finishBlocked`.
   An unobserved cached detail also loses `finishBlocked` at once, so a remount never shows
   Finish or Accept from an old verdict, and is marked stale (`refetchType: 'none'`). A worker's event keeps
   today's trailing parent refresh. Escalation if open-detail measurements regress: push
   full records for demanded runs over the task lane.
7. **Shared worker.** Bump `LIVE_WORKER_NAME` and `LIVE_PROTOCOL`
   (`contract/src/live-coordination.ts:4-5`), so an old worker never feeds a new document.
8. **Index refresher.** Unchanged in S1: `run-summary` and `run-deleted` still invalidate the
   index and reports. S1 alone keeps today's index cadence.

Workload: `bench:workspace-events` (Node): one large delegation parent with 4-8 active
children; median/p95 event bytes full versus summary; server projection and stringify
time; client parse and zod time; with detail open and closed.

#### S2. Report shelves refresh only for relevant changes (hearsay-tools/cezarion#2731)

1. **Server watch.** `ReportsIndex` gains a per-instance `epoch`, a `generation` counter,
   `onChange` and `watch(): release`. While watched:
   - a `run` event for a live run, or a live-to-terminal transition, schedules
     `indexRun(run)` through `serial()`, trailing, at most once per run per second;
   - a 5 s tick reconciles dirty runs and live runs with no local event in 5 s (runs owned
     by another process, quiet runs);
   - a `run` event for a run that owns cached rows emits a metadata change only when a
     field changed that report rows display or report search reads (`matchingRows()` calls
     `matchesRunSearch(summary, q, {scope: 'stored'})`, so every stored-scope field in
     `RUN_SEARCH_FIELDS`, such as `titleSummary`, branch and references, plus title and status). Each metadata change increments `metadataGeneration`.
   A content change is emitted only when `indexRun` finds a different set, `present()` drops
   a row, or the store deletes the run. Settled clean runs are never scanned. `list()` is
   unchanged.
2. **Topic.** `reports:project:<projectId>` on the WebSocket bus (new
   `server/reports-topic.ts`, registered beside `activity-routes.ts:98`). The first
   subscriber starts `watch()`, the last releases it. Subscribe sends
   `{epoch, generation, metadataGeneration}`;
   changes are coalesced to one frame per 500 ms. `loopbackReadable: false`.
3. **HTTP twin.** `GET /api/v1/p/:projectId/reports/state` returns
   `{epoch, generation, metadataGeneration}` and is added to `allowedLiveRead`. A read marks
   watch demand for 15 s.
4. **Client.** A mounted shelf subscribes; finite (remote) mode reads the twin every 5 s. A
   content frame, or a changed `epoch` or `generation`, invalidates `[P,'reports']` (active,
   `cancelRefetch: false`). A metadata frame patches the displayed task fields in cached
   `q=''` pages and invalidates `q≠''` shelves. A changed `metadataGeneration` seen only in a
   snapshot or a twin read (reconnect, remote mode) invalidates `[P,'reports']`. Both
   transports compare all three counters. Delete `global-events.tsx:119`. Keep
   `refetchOnWindowFocus`. An invalidation received during an in-flight request must
   survive its response: use a trailing fetch or a generation fence, including the first
   search-shelf fetch. Preserve or replay metadata patches across in-flight responses;
   a stale response must not replace newer task fields. A `q=''` metadata frame still
   causes no list read.

Workload: extend `benchmark-tabs.ts --workload reports`: project P with 60 settled runs × 2
HTML reports, 5 live P runs, 5 live Q runs, title updates at 5 Hz; count `/reports`
requests and bytes, artifact-directory `opendir` (scans) and content `lstat` (page checks)
through a fixture preload; publication detection latency; correctness snapshot of ids,
totals and titles.

#### S3. Mount one task representation and virtualize large lists (hearsay-tools/cezarion#2732)

May ship as two PRs in order: S3a (exclusive mount) then S3b (virtual tier).

1. **S3a. Exclusive mount.** `TasksOverview` renders exactly one of summary table, detailed
   table or cards, chosen by `useIsDesktop()` (synchronous `matchMedia`, Tailwind `md` =
   `48rem` in one shared constant). Remove the CSS visibility classes on those containers.
   On the global page, summary-row actions mount only when the row is expanded.
2. **S3b. Two tiers, per ADR 0034.** `lib/task-list-render.ts` holds
   `TASK_LIST_VIRTUALIZE_THRESHOLD` (start at 100 rows per group; set from the benchmark).
   Below it: normal flow with `content-visibility:auto`. Above it: one virtua `Virtualizer`
   per group, scroll owner `[data-slot="main"]`, `startMargin` from a `ResizeObserver`, flat
   fallback when no scroll owner exists. Override `?tasks=flat|virtual` as the measurement
   seam.
3. **Rows.** One virtua item per run (row plus expanded preview). `data-first`/`data-last`
   replace `first:`/`last:` selectors. Summary and detailed tables become CSS-grid divs with
   ARIA table roles, `aria-rowcount` and `aria-rowindex`; the header stays outside the
   virtualizer.
4. **State and focus.** One expanded-run Set per page, keyed by run id. A focus keeper keeps
   the focused or renaming row mounted (`keepMounted`) and refocuses the same run's control
   after a remount or breakpoint flip. In the virtual tier, inserts above the viewport keep
   the first visible row in place.
5. **Scroll.** Query changes keep the position and pathname changes reset it, as today (D6).

Workload: `benchmark-task-lists.ts` on production builds of baseline and branch; project
300 active + 1000 archived, global 10 × 200 archived + 300 active; 1440x900 and 360x640 ×
summary, detailed, cards; mounted `[data-run-id]`, DOM nodes, fibers, commit p50/p95 under
20 events/s, long tasks, Event Timing (Archived tab, search typing, column toggle, expand),
scroll frame times.

#### S4. Coalesce concurrent project Git probes (hearsay-tools/cezarion#2733)

1. New `workspace/root-probe-cache.ts`: `createRootProbeCache({compute, now, ttlMs})`.
   Single flight per `path.resolve(root)`; `finally` clears the flight; only success is
   cached; joined waiters share a rejection.
2. Per-root generation and a module epoch. `invalidateProjectProbe(root)` runs from
   `removeProject` (after the write) and `registerProject` (new entry). A late flight never
   writes after an invalidation or `clearProjectProbeCache`. Removal also evicts the entry.
3. `getRepoInfo` runs one `git rev-parse --show-toplevel --abbrev-ref HEAD`: one process
   fewer in every case (3 to 2 with an origin remote; the no-origin fallbacks keep their extra
   commands). `remote get-url` stays (it honors `insteadOf`).
4. No stale-while-refresh (D8). The 5 s maximum age stays.
5. Correct the "refreshed async" wording at
   `.ai/specs/2026-07-20-multi-project-workspace.md:347`.

Workload: `bench:project-probes`: 1, 10, 40 fixture repos plus a non-Git and a missing root;
concurrency 1, 4, 16; cold, warm, expired, concurrent; Git spawns by command, request
p50/p95/max, server CPU and Git child CPU separately.

### Phase 2: S5. Incremental index (hearsay-tools/cezarion#2729)

Prerequisite: S1 merged, and on main the cockpit's workspace stream carries `run-summary`
frames with contiguous `seq`, and `/runs-index` returns `generation` and `eventSeq`
(release check: S1's contract tests and `workspace-events.test.ts` pass on main).

1. New pure `web/src/api/runs-index-cache.ts` keyed by `(projectId, id)`.
2. **Patch rules.** Membership is `delegation?.role !== 'worker'`. Update replaces in place
   and keeps the object when deep-equal. Create inserts at its `createdAt` position. Archive
   and unarchive apply exactly when the project is not `truncated`; at a moving window
   boundary of a truncated project, patch and reconcile. Delete removes with a tombstone.
   `project-removed` drops the project's rows, `truncated` and `referenceStatuses`.
   `project-added`, `project-ready` and registry id-set changes reconcile. `usage` ticks
   replace usage for that project's rows; an empty tick clears. References refresh on
   reconciliation; cold numbers use the lazy `/github/ref-status` read.
3. **Fence.** An overlay `key → seq` (tombstones included) per generation. Every snapshot
   (query function, `live-reads.ts` shared read through a new merge hook, reconciliation)
   passes `mergeIndexSnapshot`: an overlay seq above `eventSeq` wins; entries at or below
   are pruned; another generation resets the overlay. A missed prefix triggers one more
   reconciliation. A cold cache records the overlay but never creates the cache.
4. **Reconciliation** on bootstrap, reconnect, visibility restore, seq gap, unknown project
   and truncated-boundary moves. At most one in flight plus one trailing; hold-then-fire, so
   sustained events cannot postpone it.
5. **Freshness.** Patches apply once per animation frame. Delete the index invalidation in
   the refresher (`global-events.tsx:118`). If S2 has not merged, keep the reports
   invalidation.
6. **Foreign-process projects.** A visible-only 60 s backstop refetch of the index (D2).

Workload: `benchmark-tabs.ts --workload index`: 808 roots in 2+ projects plus parent and
child ticks; cold bootstrap, one-row update, 5 updates/s for 60 s, reconnect; detail and
All tasks open and closed; SSE bytes, `runs-index` and `/runs/:id` requests per minute and
bytes, server CPU, renderer time, React commits.

### Epic close

The planner checks each phase exit on main, then records in the epic body the merged PRs,
the main SHA and a table linking each `docs/performance/<slug>.md` with its headline
numbers and remaining limits.

## Phase exits

| Phase | Exit on integrated main | Evidence owner |
|---|---|---|
| 1 | S1-S4 merged; each issue's criteria have checks passing on main; four performance reports published; legacy workspace stream byte-identical (test); cockpit uses summary mode; reconnect, detail, relationships and report e2e pass | Phase 1 coordinator; planner rechecks |
| 2 | S5 merged; index request count and bytes lower under the index workload; fence and recovery tests pass on main; `tab-coordination` and `worker-relationships` e2e pass | Phase 2 coordinator; planner rechecks |

Hot files: `web/src/api/global-events.tsx` and `global-events.test.tsx` (S1 and S2 in
Phase 1). Phase 1 runs them as two workers; whichever is ready second opens its PR after
the first merges. S3 only rebases at `global-tasks.tsx:206`. S4 touches no shared file.

## Decisions

| Id | Decision | Recommendation |
|---|---|---|
| D1 | An open task detail updates about one round trip after an event, at most every 400 ms under sustained events | Accept |
| D2 | Index rows of projects run by another cezar process no longer refresh as a side effect of unrelated events | Visible-only 60 s backstop |
| D3 | A live report publication appears within about 1 s of that run's next event, or 5 s for a quiet run, while a shelf is open | Accept |
| D4 | Hand edits of reports in settled tasks show on shelf mount, focus, reconnect or a content refresh | Accept |
| D5 | Ctrl+F does not find off-screen rows in groups above the virtualization threshold (100 rows) | Accept |
| D6 | Back/Forward does not restore task-list scroll today; S3 keeps that and a separate issue covers it | Separate issue |
| D7 | An expanded task row stays expanded when it moves group or leaves and returns to the filter | Accept |
| D8 | Git probes: single flight, no stale-while-refresh, 5 s maximum age | Accept |
| D9 | Remote mode keeps its 5 s full-index reconcile and gains a 5 s report-state read while a shelf is visible (today remote shelves refresh only on mount and focus) | Accept; remote index cost is a recorded remaining limit |

## Case tables

### S1 and S5: run events and the index (shipped defaults)

| Case | Baseline | After S1 | After S5 |
|---|---|---|---|
| Create root | Full record; list insert; index refetch in 400 ms | Summary; list insert; refetch in 400 ms | Row inserted next frame; no GET |
| Update (title, status, tokens) | Full record per event; refetch about every 400 ms | Summary row; same cadence | Row patched; no GET |
| Archive | List patch; refetch | Same from summary | Exact patch; truncated boundary: patch then reconcile |
| Unarchive | Refetch | Refetch | Insert or patch; truncated: reconcile |
| Delete | `run-deleted`; caches removed; refetch | Same, with seq | Row removed with tombstone; truncated archived row: reconcile |
| Project removal | Registry invalidation; refetch | Same | Project rows dropped; no GET |
| Parent-worker update | Worker record strips parent verdict; parent refresh after quiet; relationships by shape | Same via summary `parentRunId` and digest | Worker rows never enter the index |
| Reconnect | Reconcile invalidates index and lists | Same; new generation resets seq | Fenced full refetch |
| Event gap | Undetectable | Detected by seq | Reconciliation |
| Hidden tab | Demand released; reconcile on restore | Same | Same, through the fence |
| Cold cache | Events dropped; first GET | Same | Overlay kept; first GET merges it |
| Detail open | Instant full-record push | Immediate fetch, one per 400 ms | As S1 |
| Detail closed, cached | Full record patched silently | `finishBlocked` cleared; marked stale; refetch on mount | As S1 |
| Old tab or old shared worker | Full records | Legacy stream unchanged; new name isolates workers | As S1 |

### S2: report shelves (shelf of project P open and visible)

| Trigger | Baseline | After S2 |
|---|---|---|
| Publication in a live P run | Next refetch from any event anywhere, about 0.4 s | One-run scan within about 1 s of that run's event, or the 5 s tick; content frame; refetch |
| History deletion | Every shelf refetches | Content frame to P's shelves only |
| Snapshot removed by hand, live run | Next scan on any event | One-run scan or tick; content frame |
| Live to terminal | Reconcile; refetch | Same reconcile; refetch only when rows changed |
| Title or status, live run | Refetch: live scans plus page checks | Metadata patch; one-run scan; no list read for `q=''` |
| Title, archive or pin, settled run | Refetch: scans plus page checks | Metadata patch; no scan |
| Event in another project | P refetches | Nothing |
| Hand edit, settled task | Page check on the next unrelated refetch | Page check on mount, focus, reconnect or content refetch |
| Unreadable storage, then repair | Retry on each list read; rows kept | Retry on each list read and each watched tick; rows kept; frame after repair |
| Reconnect or missed event | No report reconcile until the next run event | Resubscribe snapshot; mismatch refetches |
| Hidden tab | No events; focus refetch | Topic released; snapshot plus focus refetch on restore |
| Remote mode | No run frames; refetch only on mount and focus | 5 s twin read; refetch when a counter moves |
| Content change during a fetch | A stale response may clear the invalidation | Trailing fetch or generation fence preserves the change |
| Search metadata change during the first fetch | Invalidation may be lost | Trailing fetch or generation fence returns matching rows |
| Metadata patch during a fetch, `q=''` | A stale response may overwrite task fields | Preserve or replay the patch; no extra list read |
| No shelf open | Startup backfill and live-to-terminal reconcile (`onRun`) only | Same; watch off |

### S3: task lists

| Case | Baseline | After S3 |
|---|---|---|
| Desktop summary, 3 runs | 3 summary + 3 detailed + 3 cards mounted | 3 summary rows |
| Phone 360x640, 3 runs | 9 row components, 6 hidden | 3 cards |
| Toggle Resource columns | Hidden detailed table shown | Summary unmounts, detailed mounts |
| Resize across `md` | CSS swap, same DOM | List remounts; expanded state and focus restored |
| Group of 1000 archived rows | 1000 rows × 2-3 representations | Viewport plus overscan |
| Group of 20 rows | All mounted | All mounted, `content-visibility` |
| Ctrl+F, off-screen row | Found | Found below threshold; not found above (D5) |
| Tab past last visible row | Next row | Next row (neighbour stays mounted) |
| Run inserted above viewport | Scroll anchoring | Anchor restore |
| Live usage tick, summary mode | Hidden detailed rows re-render | Only mounted visible cells |
| Global summary, collapsed row | Actions mounted, hidden | Actions not mounted |

**State restore cases (expanded set, focus)**

| Path or trigger | Restored value | Displayed value |
|---|---|---|
| Navigate back to the list | Nothing; Set per page instance | All collapsed |
| Row scrolls out and back | Id in the page Set | Expanded again |
| Expanded run changes group | Id kept | Expanded in the new group |
| Expanded run filtered out | Id kept until unmount | Hidden; expanded if it returns |
| Run in a folded group | Id kept | Hidden until the group opens |
| Focused or renaming row scrolled away | Index in `keepMounted` | Mounted; focus and draft kept |
| Breakpoint flip with focus in a row | Run id and control key | Same run's control focused |

### S4: Git probes

| Case | Baseline | After S4 |
|---|---|---|
| Cold, K concurrent readers (origin remote) | K × 3 Git processes per root | 1 × 2 per root; same result for all |
| Warm (< 5 s) | Cached, no Git | Same |
| Expired, K concurrent (origin remote) | K × 3 per root | 1 × 2 per root |
| Refresh fails, then retry | Not cached; next call recomputes | Same; slot released in `finally` |
| Root deleted on disk | `missing` within 5 s | Same |
| Project removed during a flight | Late write keeps an orphan entry forever | No write; entry evicted; re-register probes fresh |
| `clearProjectProbeCache` during a flight | Late write restores the result | No write |
| Git missing | `ok`, no branch or forge, stops after the first failed spawn | Same |
| Server restart | Cold cache | Same |

### Remote mode (finite HTTP, no SSE or WebSocket)

| Slice | Baseline | After |
|---|---|---|
| S1 | No workspace stream; 5 s reconcile of lists, details, index | Same; `/runs-index` gains two fields |
| S2 | Shelves refresh on mount and focus only | 5 s `reports/state` read while a shelf is visible; list refetch when a counter moves |
| S3 | All rows mounted | Same rendering gains as local mode |
| S4 | Duplicate probes | Same server gains as local mode |
| S5 | 5 s full-index refetch | Same (remaining limit, D9) |

## Preserved guarantees

- `toRunSummary` stays the one list projection; per-project scope and root-only membership.
- `truncated` honesty; cache-only `referenceStatuses`; no unrequested cache is created.
- The Finish verdict comes only from a detail fetch started after the latest event.
- One SSE, one task SSE and one WebSocket per coordination group; hidden documents release
  demand; reconnect and visibility reconciliation.
- Report `list()` reconciliation, page checks, retry markers and revision fencing; no scans of
  settled history.
- Task order, queue numbers, folds, URL state, row actions, loading, empty and error states.
- Probe maximum age 5 s; `missing`/`not-git` without Git; `getRepoInfo` never throws.
- No new setting, env var or required state file.

## Out of scope

Test-runner scheduling and Squeal lifecycle; stopping tasks, removing projects or restarting
the live cockpit; broad memory rewrites; Back/Forward list scroll restoration (D6, separate
issue); probing one root instead of all in `ProjectContexts.build` (follow-up issue); remote
mode's full-index reconcile (D9).
