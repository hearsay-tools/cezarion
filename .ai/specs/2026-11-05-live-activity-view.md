# Live activity view

A cockpit view that shows what is happening right now, in one project and in all
projects. It shows what each task and each worker is doing or waiting for, and which
tasks wait for a reply from which other task. The view moves: it changes as the work
changes, without a reload and without a poll in local mode.

Plan: [2026-11-05-live-activity-view-plan.md](2026-11-05-live-activity-view-plan.md).
Prototype (accepted by the owner on 2026-11-05):
[assets/2026-11-05-live-activity-view/prototype.html](assets/2026-11-05-live-activity-view/prototype.html).
Open it in a browser. It runs a scripted 50-second loop with sample data. Stills:
[project.jpg](assets/2026-11-05-live-activity-view/project.jpg),
[global.jpg](assets/2026-11-05-live-activity-view/global.jpg).

## Decisions

| ID | Decision | Source |
| --- | --- | --- |
| D1 | The layout is a graph of task cards with flowing lines between tasks, not a table. | Owner, 2026-11-05: "I want something that lives." Three other proposals (a tree-table, a ledger, a card board) were rejected. |
| D2 | Only **open** requests are drawn: requests without an outcome. A settled request disappears after its reply animation. | Owner, 2026-11-05 |
| D3 | The view gets its own **Activity** tab, right after Tasks. **Git moves into More.** Routes: `/p/:projectId/activity` and the global `/activity`. | Owner, 2026-11-05 |
| D4 | The service records the latest tool call and a tool-call rate for every running task and worker, and the check progress of every open CI wait, as part of this work. | Owner, 2026-11-05 |
| D5 | No new setting, flag, file or interval that a user must choose. The activity data is derived from the run store and from in-memory trackers. Deleting `.ai/cezar/` loses nothing this view needs beyond the runs themselves. | AGENTS.md § Zero config |
| D6 | The activity data is never written to `RunRecord`. Tool activity and check progress live in memory and start empty after a restart. | Planner: a tool call per second would rewrite the run row and fire a workspace `run` frame for every call. |
| D7 | In local mode, live data comes from a new WebSocket topic. In remote mode, the view reads the HTTP snapshot every 5 s while it is visible. | docs/areas/realtime-events.md: a new live signal is a topic; remote mode opens no WebSocket. |
| D8 | The view shows **active work**: root tasks that are `queued`, `running` or `waiting`, and any root that still has a live worker. Tasks in `review`, `failed`, `done` or `cancelled` are not cards. One summary chip counts tasks in review and links to Tasks. | Planner: review is finished work at the human gate; many review tasks would crowd out live work. |
| D9 | Card placement is stable. A card keeps its column and order while it stays on the view. State changes never move a card. | Planner: a living view that reorders on every change cannot be read. |

## What the user sees

### Project view (`/p/:projectId/activity`)

**Header.** The title "Activity · <project>", a live indicator with the clock in the
user's time zone, and the scope switch "This project / All projects".

**Summary chips.** Needs you, Working, Waiting, Queued, Active workers, Open requests
and In review (a link to Tasks). A count bumps (a short scale animation) when it
changes.

**Task cards.** One card for each active root task. A card shows:

- the status shape from the attention ladder (`deriveAttention`): filled, ring or the
  robot glyph, in the rung's tone;
- the title, and the runner, model, current step and run age;
- a **heartbeat strip**: one bar for each second of the last 30 seconds, as high as
  the number of tool calls that started in that second. A task that waits goes flat.
- the **now box**: a verb, a main line, a detail line and a live age counter. The
  verb and its content come from the table below.
- the task's **workers**, indented under it as a tree. Each worker row has its own
  shape, name, runner and model, and one line in the same vocabulary.
- after workers settle: "✓ N workers finished".

| Run state (rung) | Verb | Main line | Detail and motion |
| --- | --- | --- | --- |
| running | Doing | The latest tool call title, for example `Edit workers/spawn.ts`. Before the first call, or 10 s after the last call ended: "Thinking". | "Last tool 6 s ago". The dot pulses, a light sweeps the box, and the main line slides in at each new call. |
| needs-you (human wait) | Needs you | The ask card's first question. | The card glows in the pending tone. An Answer button opens the task. |
| needs-permission | Needs you | "Permission: <tool>". | Same as above. |
| waiting-on-workers | Waiting for workers | "<mode> of N · M settled". | A bar fills as workers settle. Deadline. |
| waiting-on-subagents | Waiting for subagents | "N native subagents". | Deadline. |
| waiting-for-ci | Waiting for CI | "PR <n> checks · P of T passed". | One segment for each check: passed, running (breathing) or failed. A segment flashes when it passes. Deadline. |
| waiting-for-merge | Waiting for merge | "PR <n> · in queue" or the merge state. | Deadline. |
| waiting-for-command | Waiting for command | The monitored command. | Elapsed time. |
| monitoring (timer) | Waiting for timer | The timer note. | "Wakes 16:00 · in 27:52", counting down. |
| peer wait | Waiting for reply | "From <task>". | Reply deadline. |
| usage-limit | Paused | "Usage limit". | "Resumes 15:40", counting down. |
| waiting-for-capacity, queued | Queued | "Waiting for a free slot". | Elapsed time. |

The worker line uses the same table in a short form, plus one worker-only state:
"Asks parent" with the question text, when the worker has an open request to its
parent. That row is tinted in the family tone.

Every waiting shape breathes slowly (opacity). Every age and countdown ticks once a
second on the client from the server's timestamps.

**Lines between tasks.** One line for each open request:

- task to task (peer): from the sender card to the recipient card, in the peer
  message tone (`--message-peer-accent`);
- worker to parent (family): from the worker row to its parent's status shape, in the
  card's left margin, in the family tone (`--message-inbound-accent`).

The line is dashed, and the dashes march from the sender to the recipient. A peer line
carries a label: "Request · 4:12", a short form of the question, and a bar that shows
how much of the reply window is used.

When a request opens, a **comet** (a bright head with a short tail) travels along the
new line from the sender to the recipient, and the line fades in behind it. When the
reply comes, a comet in the success tone travels back. The line turns solid, the
label says "Replied", and both fade out. A request that closes without a reply
(timed-out, cancelled, destroyed and the other outcomes) fades out with no comet.

**Other motion.**

- A card whose rung changes flashes its border once in the new tone.
- A new worker slides into its parent's card. A worker that settles flashes in the
  success tone (or the danger tone when it failed), stays 3 s, then folds into the
  "finished" count.
- A new card fades in at the end of the shortest column. A card that leaves the view
  collapses, and the cards below it move up (a FLIP transform, not a jump).

**Right rail.**

- **Open requests**: one entry for each open request: sender → recipient, the full
  question (clamped to three lines), "open 4:12" and "reply due in 5:48" with a bar.
  An entry slides in when the request opens and collapses when it closes. With no open
  request: "No task waits for a reply."
- **Just now**: the last six changes the client saw since the view opened, newest
  first, with an age: a state change, a worker that started or finished, a request
  that opened or closed, a check that passed. It starts empty: "Watching since 15:32".
- **Legend**: the shapes, the heartbeat, the two line tones and the comet.

### Global view (`/activity`)

One panel for each project that has active work, in project-rail order. Projects with
no active work collapse into one line at the bottom. A panel holds one compact pill for
each card: shape, title, a small heartbeat and one line (the verb in the rung tone and
a short main line), and one dot for each live worker. Open peer requests are arcs
above the pills, with the same marching dashes, comets and age label. Peer messages
never cross projects, so arcs never leave a panel. "Open project activity →" goes to
the project view. The summary chips count every project.

### Size, motion and access

- **Columns**: as many columns as fit at a minimum card width of 300 px, with 96 px
  gaps so the lines and labels have room. On a narrow screen: one column, and peer
  lines become a small "→ <task>" link on the sender card.
- **Dense mode**: with more than 12 cards, cards drop the detail line and fold workers
  into a row of dots with a count. The heartbeat and the line stay.
- **Many lines**: a line is drawn only when both ends are on screen. A line to a card
  off screen ends at the viewport edge with the card's name.
- **Reduced motion** (`prefers-reduced-motion: reduce`): no pulse, breath, sweep,
  march, comet, slide or FLIP. Lines are static dashes; changes apply at once; the
  ages still tick.
- **Hidden tab**: the view stops its animations and releases its topic subscription
  (`live-visibility`), and reconciles from a fresh snapshot when it becomes visible.
- **Performance**: animations use only `transform` and `opacity` (the pulse is a
  scaled pseudo-element, not an animated `box-shadow`). Line geometry is recomputed on
  layout change (`ResizeObserver`), not on every frame. A `requestAnimationFrame` loop
  runs only while a comet is in flight.
- **Access**: each card is a link to its task. Each card has a text form of its lines:
  "Waiting for a reply from <task>" and "<task> waits for your reply". The summary
  chips are a polite live region; the cards and the feed are not, so a busy project
  does not flood a screen reader.
- **Tokens**: only theme tokens, in light and dark. The purple status token stays
  reserved for running (design guardian). The heartbeat uses `--status-running`.

## Navigation

- Sidebar view tabs (`packages/web/src/components/nav-items.ts`,
  `sidebar-view-tabs.tsx`): Tasks, **Activity**, GitHub, Skills, Settings, then More.
  The row stays at the five-tab cap. **More** holds **Git**, Automations, Workflows and
  Reports.
- Mobile tab bar: Tasks, **Activity**, GitHub. The More sheet gains Git.
- The command palette lists Activity through `visibleNavItems`.
- The Activity tab carries no badge. The needs-you dot stays on Tasks.
- Icon: the lucide `Activity` glyph (Reports already uses a lucide icon).
- Routes: a `projectScopeRoute` child `activity`, and a top-level `/activity` beside
  `/tasks`, so `LegacyPathRedirect` does not send `/activity` to the boot project. A
  `PAGE_TITLE_ROUTES` row "Activity".

The Git move changes a cockpit control. The reader sweep (plan, slice S5) lists every
test, e2e spec and document that pins the tab order.

## Data

### The activity snapshot (contract)

A new `packages/contract/src/activity.ts`. Shapes (field names are final in S1):

```ts
activitySnapshot = {
  generatedAt: iso,            // server clock; the client ticks ages from it
  projects: ActivityProject[], // one entry, or every project for the global read
}
ActivityProject = {
  projectId, name,
  inReview: number,            // D8 chip
  tasks: ActivityRun[],        // active roots (D8)
  requests: ActivityRequest[], // open requests only (D2)
  closed: ActivityClosedRequest[], // closed in the last 30 s, for the reply comet
}
ActivityRun = {
  runId, title, status, rung, // `deriveAttention` rung id, never a label
  runner, model, currentStepId, startedAt,
  wait?: ActivityWait,        // the top wait (`computeWaitingOn`) with its detail
  tool?: { title, toolKind, status, startedAt, endedAt? },
  rate: number[30],           // tool calls started per second, oldest first
  workers: ActivityRun[],     // only on roots; settled workers included with status
}
ActivityWait = { kind, since, deadline?, detail } // detail is per kind, e.g.
  // pr: { number, target: 'checks'|'merge', checks?: { passed, failed, pending, total } }
  // worker: { mode, total, settled }   timer: { wakeAt, note? }   human: { question? }
  // peer: { recipientRunId }           process: { command }      usage: { resumeAt }
ActivityRequest = {
  requestId, relationship: 'family'|'peer',
  senderRunId, recipientRunId, text,        // text clamped to 500 characters
  createdAt, deadline?,
}
ActivityClosedRequest = { requestId, senderRunId, recipientRunId, status, observedAt }
```

### Read model (service)

A new module `packages/cezar/src/activity/` builds the snapshot from the run store
and the two trackers. It reads; it never writes a run.

- **Active roots**: D8, from the store's root summaries in the project.
- **Workers**: `store.listOwnedWorkers(rootId)` for each active root.
- **Top wait**: `computeWaitingOn` and the wait entry it names, so the view and the
  Tasks list never disagree about what a task waits for.
- **Open requests**: from each active root's `delegation.conversation`. A message of
  kind `request` is open while no outcome with its `requestId` exists, in either
  participant's ledger. A peer request sits in the sender's ledger and its reply in
  the recipient's ledger (`packages/cezar/src/delegation/service.ts`), so the read
  model joins both. The outcome status `replied-late` closes nothing again: the request
  closed when it timed out.

Case table for request state (a cross-run relationship):

| Case | Ledger facts | On the view |
| --- | --- | --- |
| Worker asks parent | family `request` in the root ledger, no outcome | Open family line from the worker row |
| Parent replies | outcome `replied` | Closed: reply comet, fade |
| Worker question times out | outcome `timed-out` | Closed: fade, no comet |
| Worker destroyed while asking | outcome `destroyed` | Closed: fade; the worker row leaves |
| Root A asks root B | peer `request` in A's ledger, no outcome | Open peer line A → B |
| B replies | reply in B's ledger; outcome `replied` on the request | Closed: reply comet B → A |
| B's record deleted | outcome `deleted` | Closed: fade; B's card leaves |
| A finishes before a reply | outcome `sender-closed` | Closed: fade |
| Late reply after a timeout | `timed-out`, then amended to `replied-late` | Stays closed; no second animation |
| Either side leaves D8's active set while open | no outcome | Line ends at the card that remains, labelled with the other task's name; the rail entry stays |

### Tool activity tracker (service)

An in-memory `ToolActivityTracker` keyed by run id, fed by the UI event sink
(`packages/cezar/src/runs/ui-event-sink.ts`) for every run:

- `item.started` of a tool item (`UiToolItem`): set the latest tool (`title`,
  `toolKind`, `status: running`, `startedAt` from the event time) and add one to the
  current second's bucket.
- `item.completed`, or `item.updated` to a terminal status, of the latest tool: set
  `status` and `endedAt`.
- Buckets: a ring of 30 one-second counters. A read shifts the ring to the read time.
- A run that leaves the active set is dropped from the tracker. A restart starts the
  tracker empty (D6).
- Every runner emits tool items (AGENT_PROTOCOL.md §6 matrix). Hook telemetry and
  background subagents are not tool calls and do not count.
- The title is the one the task thread already shows, clamped to 160 characters. The
  tracker stores no tool input or output.

### CI check progress (service)

`CiWatcherSupervisor` (`packages/cezar/src/ci-wait/supervisor.ts`) already reads every
check (`gh pr checks --json name,state,link,bucket`) when a CI wait starts, then
discards per-check state until the wait resolves.

- The first snapshot's buckets become the wait's check progress in an in-memory
  `CiProgressRegistry`, keyed by wait id. This costs no extra call.
- While at least one activity subscriber watches the project (or the global view), the
  supervisor's existing 30 s probe (`CI_PROBE_MS`) also reads the checks once and
  updates the progress. With no subscriber, no extra call runs.
- A progress read never changes the wait's outcome. A failed read keeps the last
  progress and is not an error. The `--watch` process, the head probe and the result
  are unchanged.
- Merge waits poll no checks today and get no progress (the detail shows the merge
  state only).

Case table for the probe (a detached process):

| Case | Before | After |
| --- | --- | --- |
| No activity subscriber | head probe every 30 s | Same; no checks read |
| Subscriber present | head probe every 30 s | Head probe, then one checks read; result only updates progress |
| Checks read fails | (no read) | Progress keeps its last value; the wait continues |
| Wait resolves | result has `checks` and `totalChecks` | Same; the progress entry is removed |
| Wait cancelled or service restarts | — | Entry removed; a restart starts empty |

### Live transport

- **Topic** `activity`, workspace-level on the existing bus (`/api/v1/ws`), registered
  with the default `loopbackReadable: false`: it carries run titles, tool titles and
  request text. Subscription parameter: a project id, or `*` for the global view.
- The publisher starts on the first subscriber and stops on the last. It sends a full
  snapshot on subscribe, then a new snapshot at most every 500 ms and only when
  something changed: a run change in the store, a tracker change, or a progress
  change. Rate buckets move every second while any visible run is running, so a
  project with running work sends about one frame a second.
- **HTTP**: `GET /api/v1/workspace/activity?project=<id>` (or no `project` for all)
  returns the same snapshot. The view reads it once on mount (fast first paint and
  remote mode), the topic takes over in local mode, and remote mode re-reads it every
  5 s while the view is visible (D7).
- The client derives every animation from the difference between two snapshots: a new
  request id (open comet), an id in `closed` (reply comet or fade), a changed rung
  (flash), a new or settled worker, a passed check. No event stream is added.

## Compatibility

- Additive HTTP route and topic. No existing route, schema, state file or event
  changes. `BACKWARD_COMPATIBILITY.md` needs no new entry beyond the route list.
- The tab move changes where Git is in the cockpit. Bookmarks to `/git` and
  `/p/:id/git` keep working.
- No `CEZ_*` variable is added.

## Out of scope

- Settled message history (D2).
- Cross-project lines (peers cannot message across projects).
- Persisting tool activity or check progress.
- A per-user layout or saved filters.
