# Live activity view: plan

Spec: [2026-11-05-live-activity-view.md](2026-11-05-live-activity-view.md). Read it
first. Decisions are cited as D1–D9.

## Slices and order

```
S1 contract + read model + HTTP route
 ├─ S2 tool activity tracker        ┐
 ├─ S3 CI check progress            ├─ parallel after S1
 ├─ S4 activity topic               ┘
 └─ S5 nav + project view (static) ── S6 motion ── S7 global view ── S8 e2e + docs
```

S5 needs only S1's contract and route. S6 needs S4 for live frames; until S4 lands it
can drive the view from the HTTP snapshot. One PR for each slice.

### S1: contract, read model and HTTP route

- `packages/contract/src/activity.ts`: the schemas in the spec's Data section, with
  inferred types. Export from the contract index.
- `packages/cezar/src/activity/read-model.ts`: `buildActivitySnapshot(store, deps,
  { projectId | all })`. It applies D8, reads workers, top waits and open requests,
  and asks two optional providers for tool activity and check progress
  (`ToolActivitySource`, `CiProgressSource`). In S1 both providers return nothing.
- `packages/cezar/src/activity/requests.ts`: open and recently closed requests from
  the ledgers of held and pinned roots plus the roots of foreign claimed families
  (no scan of finished rows, no new store read); test a pinned terminal root, a foreign live root, and a sender
  that settles right after a reply (the publisher's carry-over read), and a foreign
  terminal root that is still claimed (live = 0) (one ledger for each request: the root's for family, the sender's
  for peer). Only `accepted` requests open.
- `packages/cezar/src/activity/demand.ts`: per-project demand. An HTTP read marks
  the project for 15 s; S4 adds topic subscribers. S3 reads it.
- Route `GET /api/v1/workspace/activity`, chained into the workspace family, with a
  `queryZodValidator` for `project`. Contract parity and `typed-bodies` tests.
- Tests:
  - every row of the spec's request case table, through `reconcileConversationState()`;
  - each row of the state table, including the three needs-you rows and the three
    `waiting-on-workers` rows;
  - the rows for retained terminal roots and settled workers, with `error`, and
    `collected` for no result, a result for the current revision, and a result for
    an older revision;
  - a request closed only by reconcile has no `closed` entry; a stored reply has one;
  - D8: each root status in and out of the active set, a review root with a live
    worker in it;
  - the top wait's kind matches `computeWaitingOn` for each wait kind, and the
    aggregation of several open worker waits, several request waits, and a mix;
    two entries that name the same worker (count matches `computeWaitingOn`);
  - a family request in each direction; a request with no deadline;
  - `rung` matches `deriveAttention` for each rung.

### S2: tool activity tracker

- `packages/cezar/src/activity/tool-activity.ts`: the tracker in the spec. It owns
  its clock (injected) and its 30-bucket ring.
- Feed it from `UiEventSink` for every run. Drop a run when it leaves the active set
  (on the run change, not on a timer).
- Wire it as the read model's `ToolActivitySource`.
- Tests: start, complete, failed and declined tools; a tool first seen at
  completion; a non-terminal title update; a title that arrives only with completion; a second tool before the first ends; ring shift across idle seconds and across more than 30 s; a run dropped on
  settle; title clamp. One test for each runner's mapper fixture to prove its tool
  items reach the tracker.

### S3: CI check progress

- `packages/cezar/src/ci-wait/progress.ts`: `CiProgressRegistry` (in memory, keyed by
  wait id) and the bucket count.
- `supervisor.ts`: publish the rows of every `snapshot()` (both loops). In the
  `--watch` phase's 30 s head probe, when the registry reports demand for the wait's
  project, read the checks once and update. That read's result never reaches
  `observe`. Remove the entry when the wait resolves or is cancelled.
- Wire it as the read model's `CiProgressSource`. Demand comes from S4's topic
  subscribers and from S1's HTTP reads (15 s after each read). Until S4 lands, only
  HTTP reads create demand.
- Tests: every row of the spec's probe case table; all five buckets; a check that
  moves `pending` → `pass` between two snapshots; 101 checks with only the last one
  pending (counts say 100 of 101). In S5, the same snapshot renders 100 segments plus a
  "+1" overflow segment in the pending tone. Prove the "result only updates
  progress" row red against a version that lets a failed read resolve the wait. Read
  `.ai/skills/load-bearing-change/SKILL.md` first: this slice touches a working
  watcher.

### S4: activity topic

- Add a topic family to the socket hub (`packages/cezar/src/server/ws.ts`): one
  registration for a name prefix, a publisher factory for each concrete name, demand
  per concrete name, the same trust rules. Register the family `activity:project:`
  and the topic `activity:workspace`, both with `loopbackReadable` false. An
  unknown project id answers the existing unknown-topic error.
- Publisher: subscribe on 0→1, stop on 1→0. Triggers: the store's run changes, the
  tracker's changes, the progress registry's changes. Coalesce to at most one
  snapshot every 500 ms, only on change. While any watched run has a nonzero rate
  bucket, tick once a second, so a heartbeat drains to flat within 30 s after the
  last running task parks.
- Tests (also): the last running task parks with nonzero buckets and no later
  event; frames continue until every bucket is zero, then stop.
- Report demand per project to `CiProgressRegistry`.
- Every 5 s while subscribed, read the foreign claims; when one is in scope or the
  list changed, rebuild and send on
  change. Tests: a foreign write with no local event reaches subscribers within one
  check; a foreign run created after subscribe appears within one check; nothing
  runs without a subscriber.
- Cockpit: `packages/web/src/api/activity.ts`: `useActivity(scope)` reads the HTTP
  snapshot, then subscribes when the live coordinator has topics, or re-reads every
  5 s while visible when it has none (remote mode, no SharedWorker, failed
  SharedWorker). Add the read to the coordinator's shared-read allowlist. It follows
  `docs/areas/realtime-events.md`: subscribe in the view, return the unsubscribe,
  release on hide.
- Tests: family demand start and stop per name; coalescing; no frame without
  change; an untrusted connection is refused; the hook's topic path and its three
  no-topic paths.

### S5: navigation and the project view (static)

- `nav-items.ts`: Activity after Tasks (lucide `Activity`), Git into More.
  `sidebar-view-tabs.tsx` More list, mobile `TAB_BAR_PATHS` and `MORE_SHEET_PATHS`,
  `more-sheet.tsx` rows.
- `routes.tsx`: the project child route, the top-level `/activity` and the
  `PAGE_TITLE_ROUTES` row.
- `packages/web/src/routes/activity/`: the project view without motion: header,
  chips, stable column layout (D9), cards, now box per the spec's state table,
  workers, the rail, the legend, dense mode, the narrow layout, and access text.
  Lines are drawn static.
- **Reader sweep** for the Git move (read `.ai/skills/reader-sweep/SKILL.md`). Known
  readers:
  - `nav-items.test.ts` (label order);
  - `app-shell.test.tsx` (primary row, link counts with and without a forge, More
    items, Git lit on `/git`, drawer);
  - `nav-selection.test.tsx` (Git pill, arrow-key order);
  - `app-shell-container.test.tsx` (Git click and href);
  - `command-palette.test.tsx` (Views counts and order);
  - `mobile-tab-bar.test.tsx`;
  - `e2e/smoke.e2e.ts` (`expectedNavLabels`, mobile bar), `e2e/project-sidebar.e2e.ts`,
    `e2e/github-sidebar.e2e.ts` (`fit.tabs`), `e2e/selection-states.e2e.ts`;
  - `README.md` view list and "the Git tab" mention. The README line about Inbox in
    More views is already wrong; fix it in the same edit.
- Tests: render each state-table row; D9 placement across snapshot changes; dense
  mode at 13 cards; access text for both line directions.

### S6: motion

- The heartbeat, pulse, breath and sweep; marching lines with labels; comets; card
  flash; worker enter, settle and fold; card enter and leave with FLIP; chip bumps;
  the Just now feed. All from snapshot differences (spec, Live transport).
- Reduced motion and hidden-tab behavior as in the spec.
- Tests: the snapshot-difference function (every animation trigger is a pure
  function of two snapshots); reduced motion turns every trigger into an immediate
  change; the comet loop stops when no comet is in flight.

### S7: global view

- `/activity`: project panels, pills, arcs, the empty-project line, the scope switch.
- Tests: grouping, rail order, arcs only inside a panel.

### S8: e2e and docs

- E2E: open the project view on a seeded store with a running task, a CI wait, a
  worker question and a peer request. Assert the cards, the lines and the rail. Then
  settle the peer request and assert that the line and the rail entry leave. One
  global-view assertion.
- Docs: `docs/areas/web-ui.md` (the view and its motion rules),
  `docs/areas/realtime-events.md` (the `activity` topic), README view list.

## Verification for every slice

- Unit tests through Squeal or `npm test -- <files>`.
- `npm run lint` before the first push of a `packages/**` change.
- `npm run typecheck` for S1 and S4 (contract and api-client types).
- The pre-PR review loop and the auto-merge skill, as AGENTS.md says.
