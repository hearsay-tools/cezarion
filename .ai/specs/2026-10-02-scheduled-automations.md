# Scheduled automations — stage 1 of three (issue #766)

> Status: implemented (stage 1) · Fork adaptation of upstream open-mercato/cezar #985
> (`fbfb492493058acd8ddfca1a311c92f107c24386`). Extends the fork's
> `.ai/specs/2026-07-25-github-automations.md` (amended by #801 opt-in gating and #651 lease
> safeguards).

## TLDR

Automations in the fork react to GitHub events only, behind `CEZ_AUTOMATIONS=1`. This stage adds a
second trigger kind, **a schedule** (every day, weekdays, one weekday a week, every N hours, in the
server's time zone), evaluated by the existing workspace timer through a new schedule runner: one
durable receipt per occurrence, at most one catch-up of a missed occurrence, auto-pause after three
consecutive launch failures, and a manual "Run now". The cockpit gets a kind-aware editor with a
next-five-runs preview, a list that shows each automation's trigger and next run, Run now, and the
execution log with the new results. A schedule needs no GitHub remote. Every launched run is an
ordinary task: own worktree, review gate, governed workers, never auto-merged.

Owner decisions (2026-10-02): the work ships as **three PRs**; this ticket is stage 1. Stage 2
(`cez automation` CLI, built-in skill, prompt part, Copy as CLI) and stage 3 (templates, week and
day calendars, statistics) are filed as follow-up issues. Dollar figures follow
`capabilities.costMetrics` wherever they appear (stage 3).

## What this stage keeps from the fork, and what it declines from upstream

| Topic | Fork (this spec) | Upstream #985 |
|---|---|---|
| Gating | `capabilities.automations = CEZ_AUTOMATIONS === '1'`, unchanged. No breaking-change path. | Default-on (`!== '0'`). |
| Nav / route gate | Follow `capabilities.automations` alone; the forge no longer gates the item. Deep-link copy: "Automations are off". | Same change. |
| Lease | The #651 store lease (reclaim guard, identity checks) stays. The schedule runner takes it and checks `isCurrent()` before reserving. A held or lost lease logs `skipped` and retries through the existing workspace floor; it never advances the shared `nextRunAt`. | #985 advanced the loser's `nextRunAt`; #1099 replaced the lock with `proper-lockfile`. Neither adopted. |
| `setState` | Read-modify-write against a fresh disk read, function form. | Same. |
| Delegation | No `task.dispatch`, no review-child suffix. Launched runs get governed workers like every run. | `task.dispatch` → dispatch intent. |
| Boot brake | Ported: an enabled poll idle longer than its lookback is re-baselined at boot with a `baseline` log row. Idleness is measured from the later of `lastSuccessAt` and `baselineAt`, so a poll enabled or re-enabled but not yet due is left alone. | Measures from `lastSuccessAt` alone. |
| UI | Composed from the fork's existing primitives; one file per screen component. | Pixel-matched design kit; four promoted primitives. |
| CLI, skill, prompt part, Copy as CLI | Stage 2. | Included. |
| Templates, calendars, rail, stats, cross-project templates route | Stage 3. | Included. |

## Architecture

```
WorkspaceAutomationScheduler (existing, one timer)
  ├─ ProjectAutomationScheduler.check(github definition)   existing, needs handle.github
  └─ ScheduleRunner.fire(schedule definition)              NEW, needs no remote
        → store.acquireLease() (#651) → reserveReceipt(schedule:<iso>) → launchScheduledRun → log → setState
contract/automation-schedule.ts (NEW, pure, Intl only): nextOccurrence, occurrencesBetween, cronOf, parseCron, scheduleLabel
contract/zoned-time.ts (NEW, moved out of core/usage-limit.ts)
server.ts automations family: kind-aware routes, POST /automations/:id/run, every project gets a handle
web routes/automations/*: route shell, list, editor (+ schedule / github fields), next-runs preview, log
```

### Modules

| Path | Change |
|---|---|
| `packages/contract/src/zoned-time.ts` | New. `zonedParts`, `zonedWallTimeToUtc`, `isoWeekday`, `timeZoneOffsetMs`, `isValidTimeZone`, `localTimeZone`, lifted from upstream. `packages/cezar/src/core/usage-limit.ts` imports them from the contract and drops its private copies; its tests stay green unchanged. |
| `packages/contract/src/automation-schedule.ts` | New, lifted from upstream. `automationScheduleSchema` (`type`, `hour`, `minute`, `day`, `every`), `normalizeSchedule`, `scheduleLabel`, `cronOf`, `parseCron`, `occurrencesBetween`, `nextOccurrence`. Exported from the contract index. |
| `packages/contract/src/automations.ts` | `kind: 'github' \| 'schedule'` on the definition; `events`, `intervalSeconds`, `filters` optional; `schedule` optional; `automationLogResultSchema` gains `manual`, `catch-up`, `failed` (`skipped` exists); runtime state gains `nextRunAt`, `lastRunAt`; list response gains `timeZone` and per-entry `nextRunAt` (schedule → `state.nextRunAt`; github → `state.nextCheckAt` when enabled); `automationRunResponseSchema = { runId }`; request bodies carry `kind` and `schedule`. |
| `packages/contract/src/runs.ts`, `packages/cezar/src/runs/store.ts` | New optional `automationTrigger: { automationId, automationRevision, receiptId, trigger: 'schedule' \| 'catch-up' \| 'manual', occurrenceAt }`. `automation` is untouched: its strict `githubUrl` would make a downgraded cezar drop the whole index on a record without it, whereas an unknown key is stripped. |
| `packages/cezar/src/automations/types.ts` | Storage mirror: `kind` defaults to `'github'` so every existing file parses unchanged; a preprocess fills `intervalSeconds`/`filters` defaults for the github kind only; `superRefine` requires `schedule` for the schedule kind and the three poll keys for github; `GithubAutomationDefinition` / `ScheduleAutomationDefinition` narrowed types with guards; receipt gains `occurrenceAt`; state gains `nextRunAt`/`lastRunAt`; log results as above. |
| `packages/cezar/src/automations/store.ts` | `setState(id, update: (current) => next)` re-reads the state file, applies the update to that id's on-disk record, writes atomically, returns the next record. `update()` keeps revision in state through it. `reserveReceipt` accepts `occurrenceAt`. The lease code is untouched. |
| `packages/cezar/src/automations/schedule-runner.ts` | New (see Lifecycle). `dueAt`, `fire`, `runNow`, `retry`. Takes `{ projectId, store, timeZone, launch?, onChange?, now? }`. |
| `packages/cezar/src/automations/scheduler.ts` | `ProjectAutomationHandle`: `owner/repo/poller` move into an optional `github` sub-object; `timeZone`, `launchSchedule` added. `check()` throws "No GitHub remote is configured" without `github`. `WorkspaceAutomationScheduler.schedule()` gathers due items of both kinds (`nextCheckAt` / `ScheduleRunner.dueAt`), skips github items without `handle.github`, keeps the `retryAfter` floor for both kinds (a rejected fire re-arms at `max(60 s, …)`). |
| `packages/cezar/src/automations/task-template.ts` | `validateAutomationPrompt(prompt, kind)` with schedule placeholders `{{date}}`, `{{time}}`, `{{project}}`, `{{automation}}`; `renderScheduleTask` appends a machine-owned "Scheduled run context" block (automation, project, scheduled-for in the zone, trigger, "nobody is waiting to answer questions"); `launchScheduledRun` writes `automationTrigger`; `reconcileAutomationReceipts` reads both provenance keys; `rebaselineIdleAutomations` (boot brake). |
| `packages/cezar/src/server/server.ts` | `automationProjects` holds every registered project (`{ root, github? }`); the handle is built for all of them; boot warm-up runs reconcile and the brake, then starts the timer; create/update/enable/pause/check/retry become kind-aware; `POST /automations/:id/run`; list answers `timeZone` and `nextRunAt`; `emitAutomationChange` after run. Gate middleware unchanged. |
| `packages/web/src/components/nav-items.ts` | Automations item: `automations: true`, no `forge`. |
| `packages/web/src/api/client.ts` | `runAutomationNow`, `deleteAutomation`. |
| `packages/web/src/routes/automations/` | `automations.tsx` is replaced by `automations-route.tsx` (gate, data, mode switch), `automations-list.tsx`, `editor.tsx`, `editor-schedule-fields.tsx`, `editor-github-fields.tsx`, `next-runs-preview.tsx`, `log.tsx`. `lib/automation-format.ts` (`relativeIn`, `dayTime`). |
| `.env.example`, `README.md`, `BACKWARD_COMPATIBILITY.md`, `AGENTS.md`, `.ai/upstream/ledger.yaml` | Env row rewritten for both kinds; README Automations paragraph; §2 lists `POST /automations/:id/run` and the schedule semantics, §3 `automationTrigger`; AGENTS.md routing row for automations; ledger row for #985 → `partial`, `fork.issue: 766`. |

## Lifecycle (schedule kind)

1. `reschedule()` refreshes the coordinator and calls `schedule()`; the coordinator still discovers
   a project by its optional `automations.json` only. The refresh also re-reads a store it already
   holds when another cockpit changed `automations.json` or `automation-state.json`
   (`reloadIfChanged`: two `stat`s, inode + mtime + size), and every timer wake goes through
   `reschedule()`. With nothing due, a project carrying the file keeps an idle wake at the 60 s
   cap, so a schedule enabled, edited or created by another process (which may have exited since)
   arms here within one cap; a workspace with no definitions file arms no timer at all.
2. `schedule()` collects due items: github → `state.nextCheckAt`; schedule → `ScheduleRunner.dueAt`,
   which returns `state.nextRunAt` or computes `nextOccurrence(schedule, now, tz)` and persists it,
   so every process agrees on the instant. A `PUT` that changes `schedule` (or resumes through
   `PUT`) sets `nextRunAt = nextOccurrence(now)` when the result is enabled and clears it when
   paused; `enable` sets `nextRunAt = nextOccurrence(now)` and writes no baseline; `create` with
   `enable` arms the same way. Each arms in the request, so the list refetched on the change event
   already shows the next run, and arms through the store's `create`/`update` `arm` callback:
   under the definitions write lock, after the revision and not-found checks, the state write
   lands BEFORE the definition write. A reader loads definitions, then state, so another
   cockpit's fire sees the old definition beside the new (future) instant — not due, skipped — or
   the new pair, never the new definition beside the old, possibly past, `nextRunAt`. A failed
   definition write puts the armed keys back; a conflict or a missing id writes nothing.
   The timer sleeps `min(earliest due − now, 60 s)`. A wake short of the due instant fires
   nothing and calls `reschedule()` again from fresh state.
3. At due time, `fire(definition)` applies the **age rule** from the due instant:
   - `now − due ≤ 10 min` → launch as `launched` (trigger `schedule`);
   - `≤ 24 h` → the latest missed occurrence launches once as `catch-up`; older missed ones are
     logged `skipped` with their count;
   - `> 24 h` → nothing launches; log `skipped` "missed N occurrences while cezar was not running
     or the machine was asleep";
     `nextRunAt` advances from `now`.
   Then: acquire the project lease. **Lease held or not current** → log `skipped` (reason names
   the lease), leave `nextRunAt`, reject the fire so the workspace floor retries in ≥ 60 s; the
   winning process fires the same occurrence from the same on-disk state, and the receipt makes a
   second launch impossible. **Receipt exists** → log `duplicate`, advance `nextRunAt` from
   `max(occurrence, now)`, not a failure. Otherwise reserve `receiptKey =
   ${automationId}:schedule:${occurrenceIso}` with `occurrenceAt`, launch, mark the receipt
   `launched` with `runId`, log the result with `runId`, and set `nextRunAt =
   nextOccurrence(max(occurrence, now))`, `lastRunAt = occurrence`, `lastSuccessAt = now`,
   `consecutiveFailures = 0`. Advancing from `max(occurrence, now)` is what forbids a burst.
4. **Launch failure**: receipt `launch-error` with the message, log `failed`, `nextRunAt` still
   advances, `consecutiveFailures++`. On the third consecutive failure the definition is paused
   (`store.update` with `enabled: false`), a `failed` row says "Paused after 3 consecutive launch
   failures; fix the task and enable it again", and `automation-change` fires. Held leases and
   duplicates never increment the counter.
5. **Restart or sleep**: step 3 covers both. After a restart, the first `schedule()` after boot
   finds past-due items. After a sleep, the 60 s timer cap does: Node timers count on a monotonic
   clock that stops while the machine is suspended, so one timer armed for a week-long distance
   would wake late by the whole time asleep (a weekly on a laptop that sleeps nightly would land
   more than 24 h late and be skipped every week). A capped wake reads the wall clock at least
   once a minute, so a fire comes at most one cap after the machine wakes. The cap applies to
   github polls too; a poll still fires only once its `nextCheckAt` is due. Upstream has the
   single long timer.
6. **Run now** (`POST /automations/:id/run`, schedule kind, allowed while paused): fires
   immediately outside the timer under the same lease with `receiptKey = …:manual:<nowIso>`, logs
   `manual`, leaves `nextRunAt` and `enabled` untouched; answers `202 { runId }`. Lease held →
   `409`.
7. **Retry** (`POST /automation-log/:receiptId/retry`) for a schedule receipt in `launch-error`
   (no `candidate`, has `occurrenceAt`): re-reserves the same receipt and fires it as `manual`;
   the github path is unchanged.
8. **Boot brake** (github kind): before the timer arms, every enabled poll whose idleness
   reference, the later of `lastSuccessAt` and `baselineAt`, is absent or older than `filters.lookbackDays` is
   re-baselined (`baselineAt = cursor = now`,
   `frozenHighWatermark`/`backlogAfter`/`backoffUntil` cleared, `nextCheckAt = now + interval`)
   with a `baseline` log row and an `automation-change` event. Polls that succeeded within their
   lookback continue exactly as today. Deviation from upstream, which reads `lastSuccessAt`
   alone: `enable` writes a fresh `baselineAt` but no `lastSuccessAt` (a re-enable keeps the
   stale one), so a restart inside a fresh or resumed poll's first interval would re-baseline it, drop the events since the enable, and push its
   first check out again.
9. **Crash recovery**: at boot, `reconcileAutomationReceipts` turns a `reserved` receipt that no
   run claims into `launch-error` and appends a `failed` log row carrying its `receiptId`, so the
   lost occurrence shows in the log with "Retry task" (both kinds). A reservation this process
   wrote and has not settled is skipped: a non-boot project's context is built lazily by the
   first launch, and building it reconciles while that launch is in flight. The store keeps the
   in-flight set process-wide per data directory; a crash empties it, so the next boot
   reconciles a real leftover. Boot reconciles only projects whose context exists, so a schedule
   fire that meets a `reserved` receipt not in flight here (a lazy secondary project's leftover,
   or one another process left after this boot) first calls the handle's `reconcileReceipts`
   (build the context, then `reconcileAutomationReceipts`) before the duplicate path: the receipt
   ends `launched` or `launch-error` + `failed` row, then `nextRunAt` advances as before.

GitHub-kind polling, cursors, baselines, receipts and backoff are otherwise unchanged.

## Data model

Definition (`automations.json`, v1 file, additive):

```ts
kind: 'github' | 'schedule'           // storage default 'github'
events?, intervalSeconds?, filters?   // required for github (superRefine); refused for schedule
schedule?: { type: 'daily'|'weekdays'|'weekly'|'hours'; hour?: 0–23; minute?: 0–59; day?: 1–7 (Mon=1); every?: 1|2|3|4|6|8|12 }
                                      // required for schedule; defaults hour 4, minute 0, day 1, every 6
```

Runtime state gains `nextRunAt?`, `lastRunAt?`. Receipts gain `occurrenceAt?`; shape otherwise
unchanged, so retention and compaction apply as they are. Log `result` gains `manual`, `catch-up`,
`failed`; github fields stay optional and absent on schedule rows. Run records gain the optional
`automationTrigger` described above. The derived cron string is never stored.

Validation: `kind === 'schedule'` with `events`/`filters`/`intervalSeconds` → 400 "a scheduled
automation has no GitHub filter". A `POST` without `kind` is github; a `PUT` without `kind`
inherits the stored kind. Switching kind on `PUT` → 409 "change the kind by creating a new
automation" (receipts and cursors are kind-specific). The `changedLabels` rule stays for github.

## API

All under the automations family, behind the origin guard and the `CEZ_AUTOMATIONS=1` gate,
mounted at both scope spellings.

- `GET /automations` → `{ available, reason?, scheduler, timeZone, automations[] }`; each entry
  adds `nextRunAt?`. `available`/`reason` keep describing GitHub only; the UI words it as "GitHub
  unavailable · <reason>" and disables the GitHub kind in the editor.
- `POST /automations`, `PUT /automations/:id` — bodies gain `kind` and `schedule`; kind rules above.
- `POST /automations/:id/enable` — github baseline as today; schedule arms `nextRunAt`.
- `POST /automations/:id/run` — new; schedule kind only; `202 { runId }`; `409` for github ("use
  check with mode execute"), a held lease, or an unlaunchable project.
- `POST /automations/:id/check` — github only; `409` for schedule ("a schedule has nothing to
  preview; use run").
- `POST /automation-log/:receiptId/retry` — kind-aware as in Lifecycle 7.
- `GET /automations/:id`, `DELETE`, `GET /automation-log`, `GET /automation-checks/:id` unchanged.
- Workspace SSE `automation-change` unchanged; also emitted after `run`.

Contract parity tests cover every changed response; `bc-route-inventory.test.ts` and
`BACKWARD_COMPATIBILITY.md` §2 list the new route.

## UI

Route map unchanged (`/automations`, `/new`, `/:id`, `/:id/log`). Every mode waits for health and
renders the "Automations are off" state when the capability is absent, as today.

- **List**: header "Automations" with subtitle "Schedules and GitHub checks run while Cezarion is
  open." and status line "Scheduler running|idle · GitHub available|unavailable · <timeZone>"; `New
  automation` button. One card per automation: name, `Pill` enabled|paused, kind icon, trigger
  label (`scheduleLabel` or "on issue.opened · every 5 min"), "Next run: Thu 04:00" (`—` when
  paused, "continuous" for github), latest log row summary. Actions: Edit, Execution log,
  Pause|Enable, and **Run now** (schedule → `run`) / **Test filter** (github → preview check).
  Empty state via `CenteredState`: "No automations yet — create one paused, preview it, then
  enable it."
- **Editor**: Name; **When** segmented control "On a schedule | When GitHub changes" (the
  existing `SegmentedControl`); schedule fields: shape chips (Every day, Weekdays, Weekly, Every N
  hours), weekday chips for weekly, `Select` for every-N, HH/MM inputs with the zone, derived cron
  in mono; GitHub fields: event chips (multi-select), poll interval `Select`, a `Collapsible`
  "Filters" with authors, assignees, all/any/exclude labels, changedLabels, lookback and max
  records; GitHub segment disabled with the reason when the forge is unavailable. **What to run**:
  prompt `Textarea` with kind-specific placeholder hint, workflow / runner / model via the composer's
  `PickerPill`s, Autonomous `Switch`, the note "Each run is an ordinary task in its own worktree,
  queued behind the parallel cap, never auto-merged". **Enable** `Switch` (github adds the baseline
  sentence). Right column: **Next 5 runs** preview computed live from the form through
  `occurrencesBetween`, or the "how it polls" sentence for github. Save → `POST`/`PUT`; a `409`
  shows "Edited elsewhere — reload to see the latest version" with a Reload action; 400s render
  under their section with `role="alert"`; the draft survives an error.
- **Log**: rows with time in the zone, `Pill` result (launched/manual/catch-up → success;
  skipped/no-match/preview/baseline/duplicate → neutral; failed/error/rate-limited → danger), reason,
  "Open task" link, "Retry task" on `launch-error` rows; result and event filters.
- Mobile: single column, 16 px gutters, no horizontal overflow at 390 px; keyboard reachable
  controls; light/dark/system; `prefers-reduced-motion` respected for any transition.

## Edge cases

| Case | Behaviour |
|---|---|
| DST gap (`daily 02:30` on spring-forward) | `zonedWallTimeToUtc` settles on one instant near the gap; fires once. Fall-back repeated hour fires once. Fixtures: `Europe/Warsaw`, `America/New_York`. |
| `hours` shape across DST | Anchored at 00:00 wall time per day: one slot fewer or more that day. |
| Server zone changes between boots | `nextRunAt` is an instant; the next arm recomputes from the schedule. Header shows the current zone. |
| Down or asleep for hours/days | Age rule: one catch-up at most, else skipped with count; `nextRunAt` advances from now. The 60 s timer cap notices a wake within a minute, so a sleep that ends before the occurrence still fires it on time. |
| Two cezar processes, one project | Lease loser logs `skipped` and retries via the floor; receipt dedupes. `setState` RMW keeps both processes' keys. |
| Run queue at capacity | The run is created queued; the row is `launched`. |
| Workflow/model/runner missing at fire time | `failed` with the reason; third consecutive failure pauses. |
| Old `automations.json` without `kind` | Parses as github; nothing rewritten until the next edit. |
| Older cezar reads a schedule-launched run | `automationTrigger` is stripped as unknown; `automation` absent; index stays readable. |
| Project without a GitHub remote | Gets a handle; schedules fire; github definitions are refused at create with the forge reason. |
| Capability off | Everything as today: no nav item, routes 409, timer never starts, nothing on disk touched. |

## Risks

- **New launch path.** Mitigated by receipts per occurrence, the shared lease, the one-catch-up
  rule, auto-pause, and fake-clock tests including DST and a simulated three-day sleep.
- **Nav gating change.** A repo without GitHub now sees the page with the GitHub kind disabled;
  deliberate, the schedule kind is the point.
- **Shared timer.** A schedule fire that throws re-arms through the floor like a failed poll; a
  throwing `dueAt` (unknown zone) skips the item rather than stalling the timer.
- **Zero-config default path.** With the flag unset nothing changes. With the flag set and no
  schedule defined, the only new behaviour is the boot brake, which only ever prevents launches.

## Testing

- Contract: every shape, week boundaries, DST fixtures, `parseCron(cronOf(s)) ≡ s`, `nextOccurrence`
  strictly after `after`.
- Store: `setState` RMW with two stores on one directory (other id and same id races survive).
- Runner (fake clock, temp store): on-time launch; catch-up of the latest missed; skipped beyond
  24 h; no burst after a 3-day sleep for daily and hourly; duplicate receipt across two store
  instances launches once; held lease logs skipped, leaves `nextRunAt`, and does not count; three
  failures pause, a success resets; manual leaves `nextRunAt`; retry fires the same receipt.
- Scheduler: project without github arms schedule items only; mixed kinds arm the earlier; a
  rejected fire re-arms at the floor.
- Routes (`automations-api.test.ts`): kind rules, run 202/409, check 409 for schedule, retry both
  kinds, list `timeZone`/`nextRunAt`, boot brake through `startServer`, old definitions file parses.
- Contract parity, route parity, versioned surface, BC inventory.
- Web unit: editor draft round-trips both kinds, preview shows five instants, 409 reload action,
  list Run now, log tones, nav gating without forge.
- E2E (`automations.e2e.ts`): the opted-out case stays on the shared environment; the enabled
  journeys spawn their own fixture server with `CEZ_AUTOMATIONS=1` through `fixtureServeEnv`, the
  way `mobile-tab-bar.e2e.ts` does, so they run in CI instead of skipping. Schedule journey
  (new → schedule → save paused → Run now → task appears → log shows `manual` → enable → next run
  shown → pause → delete); github journey as today; `ios-sweep.e2e.ts` covers list and editor.
  Browser QA screenshots in light and dark at 1440×900 and 390×844.
- Full gate before the PR: `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`,
  `npm run test:package`, `npm run test:e2e:local`.

## Out of scope (stages 2 and 3, filed as follow-ups)

Stage 2: `cez automation` CLI (JSON output, `cez task` exit codes), the built-in
`create-cezar-automation` skill (`source: 'builtin'`), the system-prompt part composed at both
session construction sites, the composer template, Copy as CLI. Transport constraint recorded for
stage 2 (owner, 2026-10-02): `cez task` has started a second cockpit when misused on a taken port,
so the automation CLI must never start a server, its no-cockpit error must not tell an agent to run
`cez`, and a run under a cockpit gets the bound origin and project id injected into the agent env
once the server listens, so the CLI calls that address and skips port discovery. The same injection
is the "cockpit attached" signal that gates the prompt part and the built-in skill; a headless `cez
run` injects nothing and composes nothing. Stage 3: built-in and cross-project templates
(`GET /workspace/automation-templates`), week and day calendars, next-runs rail, this-week stats
strip and per-row 7-day tallies (cost following `costMetrics`), owned workers nested in the log.
Also not done: default-on, `task.dispatch`, PR-review triggers (upstream #1016/#1056), Jira/Linear
(upstream #1045), full cron expressions, automations while the server is stopped.
