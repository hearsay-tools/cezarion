# Unified waits: one list, four tools, one turn-end rule

Status: approved by the owner (2026-10-17). Phase 1: hearsay-tools/cezarion#1233; the
calls its build made are under [Phase 1 decisions](#phase-1-decisions). On 2026-10-18 the owner
split the human wait out of `cezar_wait` into its own tool, `cezar_ask`, with a required card
that may hold open questions (hearsay-tools/cezarion#1234, [Phase 2 decisions](#phase-2-decisions)).
Supersedes the narrow re-arm design for hearsay-tools/cezarion#1197 and absorbs
hearsay-tools/cezarion#1226 (agent-facing cancel).

## Why

An agent can park a run in at least eight ways today, each with its own state,
exit and slot rule:

| Mechanism | How the agent signals it | Stored as | Exit |
|---|---|---|---|
| Done | `CEZ:DONE` text line | session closed | — |
| Structured question | the ask marker with JSON | `waiting` + `hasPendingHumanAsk` | human answer |
| Prose question | a sentence matching a regex (`turnParkSignals`) | `waiting` + prose-gate note | human answer |
| Markerless turn end | nothing | `waiting` (or autonomous / final-message nudge) | human, nudge, 15-min idle close |
| Monitoring | `CEZ:MONITORING` text line, or Claude `ScheduleWakeup` | `running` + `activity: monitoring` + `monitoringWakeAt` | wake timer (40-wake cap) |
| CI | `cezar_wait_for_ci` MCP tool | `running` + `monitoring` + `ciWait` | CI result; **any human message withdraws it** |
| Workers | `cez worker wait` CLI | `waiting` + `delegation.wait` | worker outcome / message / deadline |
| Native question | Codex / OpenCode / Cursor ask tool | `waiting` + `hasPendingHumanAsk` | human answer |

Every interaction between two of these is a special case: a human message
withdraws CI (hearsay-tools/cezarion#476, which then needs re-arming,
hearsay-tools/cezarion#1197); an ask withdraws CI; a CI wait refuses while a
worker wait is wake-pending (hearsay-tools/cezarion#1200); `classifyTurnEnd`,
`parkAfterAck`, `settleIdleBoundary`, `prepareProseHumanGate`,
`maybeFinalMessageNudge` and `tryAutonomousNudge` each re-derive the same
decision in both turn-end handlers of `workflows/run.ts`. The owner's ask: stop
patching the matrix and make parking deterministic.

## Goals

- One list of waits per run. The agent registers and cancels waits through MCP
  tools. Several waits can be open at once.
- **A wait ends only when its own event fires, its deadline passes, or someone
  cancels it.** Nothing else ends a wait as a side effect.
- **Everything wakes.** Any resolved wait, any human message and any worker
  message wakes the agent. One wake never cancels another wait.
- One turn-end rule with three branches, the same in every handler and runner.
- Stored status means "is the agent working": `running` during a turn, `waiting`
  while parked on anything. "Needs you" is always derived.
- One slot rule and one line order, written down.

## Non-goals

- Changing how human input reaches a live session mid-turn (the H1–H5 harness
  mechanics, `holdsHumanInput`, steering). Delivery mechanics stay; only the park
  decision changes.
- Permission prompts. They block mid-turn and keep their current path and rank.
- `CEZ:PR=`, `CEZ:ISSUE=` and `CEZ:TITLE=` metadata markers.
- Worker spawn, send, reply, collect and destroy. Only *waiting* on workers moves.

## Anti-goals

- A parked state with no exit. Every wait except a human wait has a deadline.
- A wait that disappears because something unrelated happened.
- Heuristics over the agent's prose deciding what the run is waiting for.
- A replacement that ships off. Each phase changes the default path and keeps
  every old exit working.

## The model

### Waits

A run holds `waits: Wait[]` (open and recently settled) on its `RunRecord`.

| Kind | Registered by | Payload | Deadline | Resolves when |
|---|---|---|---|---|
| `human` | agent (`cezar_ask`), an alias, a native ask, or Cezar's no-wait fallback | question card (`askRequestSchema`), required from `cezar_ask` | none | a human message arrives |
| `ci` | agent or the `cezar_wait_for_ci` alias | PR identity and head, as `ciWaitSchema` today | required, 1 s–2 h, default 30 min | checks settle, head changes, or deadline |
| `worker` | agent or the `cez worker wait` alias | worker ids or request ids, mode `one`/`any`/`all`, as `workerWaitSchema` today | required, as today | worker outcome(s), request reply, or deadline |
| `timer` | agent, the monitoring-marker alias, or Claude `ScheduleWakeup` | seconds and an optional note | required: the timer itself | the time passes |

Each wait has an `id`, `kind`, `source` (`agent` or `cezar`), `registeredAt`,
optional `deadline`, `phase` (`open` → `resolved` → `delivered`, or
`cancelled`), the kind's payload, and a `result` once resolved. Identical
registrations are idempotent and return the existing id (same kind and same
target: PR URL, worker/request set, or for timers the same note and seconds
inside one turn). At most 16 open waits per run.

Settled waits move to a bounded `lastWaits` history (16) for the header and the
transcript.

### Messages are not waits

Human messages and worker messages (progress, request, reply) always wake the
agent; nobody registers for them. A human message resolves **every open human
wait** and nothing else. A worker reply resolves only the request wait that
names it. This part is new: today an unrelated reply or message retires the
current worker wait after delivery (`run.ts` `4558-4560`, `4699-4707`), and a
parent's answer withdraws a worker wait registered before the question
(`4220-4229`). Under this model neither retires anything.

### Native asks

A native ask (Codex `requestUserInput`, OpenCode's question tool, Cursor's ask)
is an RPC the provider blocks on **inside** its turn, so the turn has not ended
and there is no boundary to wake at. Cezar treats it like a permission prompt:
the run shows Needs you at once (a human wait with `source: native`), and every
result that resolves meanwhile waits for the boundary, as any mid-turn result
does. This is not an exception to "everything wakes"; the agent simply is not
parked. Its answer path through the human seam, and its behaviour in autonomous
runs (`AGENT_PROTOCOL.md` 1185-1189), are unchanged. Cezar's prompt teaches
`cezar_ask`, which parks at a real boundary and lets everything else wake the agent.

### Tools

One MCP server, already wired into every runner through the `cezarTools` list in
`ci-wait/tools.ts` (Claude `--mcp-config`, Codex `mcp_servers`, OpenCode, Cursor
`mcpServers`, Pi and OMP extensions). Adding a tool there reaches every runner.

- `cezar_wait({ kind, ... })` → `{ wait_id, kind, deadline, open_waits }`, for every kind but
  `human`. Validates synchronously and refuses with a typed reason (`invalid_request`,
  `capacity`, `timers_disabled`, …).
- `cezar_ask({ questions })` → `{ wait_id, open_waits }`: the human wait, with its card. The
  card is required: 1–4 questions in the ask format, each with 2–4 options or, with the
  options left out, an open question the user answers in words. Refuses with a typed reason
  (`invalid_request`, `capacity`, `autonomous_run` in an autonomous run, …). A separate tool,
  so `cezar_wait`'s schema never carries a field only one kind takes, and the one call that
  needs a card always has one.
- `cezar_cancel_wait({ wait_id })` → `{ cancelled, open_waits }`, or
  `not_found` with `open_waits`. Cancel of an already-resolved but undelivered
  wait is a no-op that says so: its result is delivered with the next wake.
- `cezar_done({ summary? })` → accepted, or refused with a reason the agent can
  act on. The refusal reuses today's completion gate (`run.ts` `3830-3857`,
  `delegation/readiness.ts`) unchanged: live workers, workers whose process has
  not provably terminated, settled results not yet collected at their current
  revision, an unanswered worker question, a pending root finish. Each refusal
  names the workers and the command that clears it. Accepted means: at this
  turn's end, cancel every open wait and finish. It does not end the turn by
  itself. Both answers carry `open_waits`.

Aliases keep old prompts and skills working and map into the same list:
`cezar_wait_for_ci` → `cezar_wait({kind:'ci'})`; `cez worker wait` and
`cez worker cancel-wait` → worker waits; the `CEZ:DONE` line → `cezar_done`; the
ask-marker line → a human wait with that card; the `CEZ:MONITORING` line →
`timer` with `resources.monitoringWakeIntervalMinutes`; Claude `ScheduleWakeup`
→ `timer` with its delay; Codex / OpenCode / Cursor native asks → a human wait
(their native answer path is unchanged). Marker lines are applied at turn end,
before the rule below, exactly as if the tool had been called. Cezar's own prompt
(`handoff.ts`) stops teaching the lifecycle markers and teaches the three tools;
the alias parsing stays.

### The turn-end rule

At a turn end, in both handlers, through one shared function:

0. **Input already owed.** If input is already on its way into this session
   (a held human follow-up, an unread or in-flight agent input, an admitted wake),
   make no decision: the next turn end decides. This is today's delivery
   mechanics, unchanged.
1. **Done.** `cezar_done` was accepted this turn (or the done alias): cancel open
   waits and finish — the session closes and the run goes to review/done; a
   worker settles; a non-final workflow step completes.
2. **Any open wait.** Park. Status `waiting`. Nothing else is decided here.
3. **No open wait.**
   - Non-final workflow step: the step completes and the workflow advances, as an
     ordinary non-final step with nothing pending does today. (Branches 1 and 2
     apply to every step: a non-final step parks on its open waits, as it parks on
     questions and CI/worker waits today.)
   - Otherwise, if the previous turn was not already Cezar's no-wait nudge: send
     the nudge — "Your turn ended without a wait or done. Call `cezar_ask` if you
     need the user, `cezar_wait` (`ci`, `worker` or `timer`) if you are waiting on
     something, or `cezar_done`." It counts against the automatic-wake budget.
   - Otherwise Cezar opens a human wait (`source: cezar`, reason `no-wait`) and
     the run shows Needs you, with a note.

There is no prose classification, no final-message nudge and no ask override.
An agent that asks in prose without a human wait gets the nudge, registers the
wait, and parks: one extra turn, deterministic.

### Waking

At a turn boundary with at least one resolved wait or one pending message, Cezar
runs one turn that delivers all of them together: resolved waits' results
(CI observation, worker outcomes, timer note), worker messages, and human
messages as user messages. Every delivered turn — human or automatic — ends with
a footer listing the waits still open ("Still open: your question q1 to the user; CI wait
w2 for org/repo#12, deadline 15:40"). The footer replaces the CI withdrawal note. It
offers `cezar_cancel_wait` only for CI waits and timers, and says the user's reply answers
an open question, which cannot be cancelled once the user has seen it.

Results that land mid-turn wait for the boundary. A human message mid-turn keeps
its current native delivery.

A CI observation for an older head reports the head it observed, as today. A CI
wake never answers a human wait: the human wait stays open and the run keeps
showing Needs you while the agent works on the CI result.

### Status and display

Stored `status`:

| Status | Meaning |
|---|---|
| `queued` | never started, waiting in the line |
| `running` | a turn is in progress |
| `waiting` | parked: the turn is over and the run is not finished, whatever it waits on (including a usage-limit hold) |
| `review`, `done`, `failed`, `cancelled` | lifecycle, as today |

`activity: monitoring` is no longer written. A usage-limited run is `waiting`
with `autoResumeAt`, not `failed`.

`waitingOn` (new summary field) names the top open wait by this order:
**human > usage limit > workers > CI > timer.** One pure function in
`packages/contract` computes it; `deriveAttention` reads it:

1. live permission prompt → needs permission (unchanged)
2. `failed` without a resume → failed
3. an open human wait, at any status → **Needs you**
4. `review` → needs review
5. `running` → running
6. `waiting` + usage limit → "usage limit, resumes 15:00"
7. `waiting` + workers → "waiting on 2 workers" (robot)
8. `waiting` + CI → "waiting for CI on org/repo#12" (ring)
9. `waiting` + timer → "next check 15:05" (ring)
10. `waiting` with a resolved wake in the line → "waiting for a slot"
11. `queued`, `done`, `cancelled` as today

`hasPendingHumanAsk`, `ciWait`/`lastCiWait`, `delegation.wait`/`lastWait` (for
parking), `monitoringWakeAt` and `monitoringWakeCapReached` are replaced by
`waits`, `lastWaits` and `waitingOn`, read from old rows on load (see
Compatibility).

### Slots and the line

Two pools, as today's arithmetic, with one change: a parked CI or timer run keeps
the slot it holds, so its wake runs at once.

| Top wait | Slot while parked |
|---|---|
| human | none |
| usage limit | none |
| workers | none (its workers need slots; at `maxParallel: 1` a held slot would deadlock) |
| CI | keeps one: a monitoring slot if free (`maxMonitoringSessions`, default 2), else its regular slot |
| timer | same as CI |

A CI or timer park moves into a free monitoring slot and gives its regular slot
back; when a monitoring slot frees and a CI/timer park sits in a regular slot, it
moves over. Defaults stay `maxParallel: 2`, `maxMonitoringSessions: 2`.
The monitoring pool stays per project manager, as `busySlots` applies it today
(`run.ts` `2246-2251`); the regular pool stays workspace-wide plus the
per-project ceiling. Whether the monitoring pool should become workspace-wide is a
separate question this spec does not change.

The line, for anything that needs a regular slot:

1. Wakes of runs already in progress (worker results and messages, resumes after a
   usage limit, any wake of a run that held no slot), first come first served by
   when the wake joined.
2. Runs that have not started, first come first served.

An entry leaves the line when a regular slot is free **and its account is not on
a usage-limit hold** (`accountHeldFor`, which already applies to every queued
entry). Human messages skip the line and may exceed the cap, as today. A run that
hits a usage limit gets one resume entry due at the reset; results that arrive
during the hold stay on their waits and are delivered with the resume.

### Session failure with open waits

A provider failure, crash or clean session close while waits are open leaves the
run `waiting` and recoverable, for every kind: the failed attempt keeps its error,
finish time and `session.ended(error)`; a non-final workflow agent keeps its
`workflowResumeStepId`; the next wake reopens the run through the scheduler-owned
continuation and delivers what resolved. This generalises today's CI policy
(R72–R76) to workers, timers and human waits. Today's "clean close with an
outstanding worker wait is an error" (`run.ts` `7276-7280`) becomes a park. A
terminal status (stop, Finish, cancel, deletion) cancels open waits without
waking the agent, as it retires CI intent today. A failure or a clean close while
resolved results are still undelivered is a failed delivery: the retry waits for a short backoff,
and the delivery bound below settles the run `failed` with the results kept
instead of retrying forever. Only a `failed` run that owes results keeps its waits.
One exception keeps an authored deadline terminal (hearsay-tools/cezarion#427 Q8,
hearsay-tools/cezarion#470 T3): when a step's own `timeoutMs` has passed, its human waits
are cancelled with it and the failure settles `failed`. CI and timer waits still park it.

### Liveness bounds

- Every non-human wait has a deadline, so every parked state has an exit: its
  event, its deadline, a cancel, or a human.
- `resources.monitoringWakeIntervalMinutes: null` ("Park until resumed") keeps
  its meaning, no automatic re-checks: `cezar_wait({kind:'timer'})` refuses with
  `timers_disabled`, and the monitoring-marker alias opens a human wait instead of
  a timer. A run parked that way shows Needs you, because only a human or an
  integration can resume it.
- **Automatic-wake budget:** 40 self-generated wakes (timer expiries and Cezar's
  nudges) since the last human message. At the budget, Cezar opens a human wait
  (`reason: budget`) instead. CI, worker and usage-limit wakes are external events
  and do not count; usage-limit resumes keep their own cap of 12.
- **Delivery bound:** at most 3 consecutive failed automatic attempts to deliver
  resolved results, counted across the sessions that retry them, each retry after
  a short backoff. At the bound the run settles `failed` with its last error and a
  note; it keeps the results for a human, and nothing wakes it automatically.
  Usage-limit failures are not counted; their own hold and resume take them.
- Parks that hold no slot close their session after 15 minutes idle (today's
  `IDLE_TIMEOUT_MS`, now for worker and usage-limit parks too); a wake reopens it
  through the existing scheduler-owned continuation. CI and timer parks hold a
  slot and stay open, bounded by the two pools.

### Autonomous runs

`cezar_ask` refuses with `autonomous_run` and the autonomy
instruction until the automatic-wake budget is spent; the no-wait nudge uses the
autonomous wording and repeats until the budget instead of falling back after
one. After the budget, human waits are accepted and the fallback opens one.

### Owned workers

A worker's human wait is routed to its parent as a request, as
`routeWorkerQuestion` does today, and the parent's reply resolves it. A worker's
no-wait fallback is routed the same way. `cezar_done` in a worker settles its
outcome.

## Compatibility

- **Run records.** On load, convert legacy fields into `waits` (upgrade-on-read):
  `ciWait` → `ci`; `delegation.wait` → `worker`; a pending ask derived from events
  → `human`; `activity: monitoring` with `monitoringWakeAt` → `timer`; `failed` +
  `autoResumeAt` → `waiting` + `autoResumeAt`. Writes go through the new schema.
- **Downgrade.** Not supported, but it must fail loudly. An older cezar reading a
  row without `ciWait` / `delegation.wait` would recover an owned worker as a
  plain waiting worker and settle it as successful (`run.ts` `2730-2763`). So the
  first phase that stops writing a legacy field also appends a run-store
  migration that raises `RUN_DATABASE_SCHEMA_VERSION`; an older cezar then refuses
  the store with `unsupported-schema` (`run-database.ts` `663`) instead of
  misreading it. Document the recovery step (upgrade again) in
  `BACKWARD_COMPATIBILITY.md` §3.
- **Status.** `waiting` now also covers worker, CI, timer and usage-limit parks;
  webhook consumers of `task.status` get one `waiting` transition per park and read
  `task.attention` to know whether a human is needed. `task.activity` events stop
  for new parks. Document in `BACKWARD_COMPATIBILITY.md` and `.env.example`
  (no env var changes expected).
- **Markers.** Kept as aliases; documented as such in `AGENT_PROTOCOL.md`.
- **`cezar_wait_for_ci`.** Deprecated in phase 1, removed in phase 4. Phase 1 keeps
  it working as an alias with an unchanged receipt, but its description points to
  `cezar_wait` and the tool instructions only suggest `cezar_wait` for CI, so new
  sessions stop choosing it. Phase 4 removes the tool and its private route, and
  records the break and its migration ("call `cezar_wait` with `kind: "ci"`") in
  `BACKWARD_COMPATIBILITY.md`, which lists the name as a model-facing surface today.
- **Parity.** R69–R71 pin "human input withdraws CI" and are retired with that
  rule. New cells (below) replace them.

## Verification

Each phase adds `RUNNER_IDS` cells driven through each runner's native mock wire
(`HARNESS_ADAPTERS`), registered in the parity guard, with named exemptions only
for genuine wire gaps, and proven red without the change (`AGENTS.md` §Runner
regressions):

- **U1** each kind registers through its tool on the native wire, parks, and
  wakes with its result.
- **U2** two waits open (CI + worker, CI + human): one resolving wakes the agent,
  the other stays open and is listed in the footer; turn end re-parks without
  re-registration.
- **U3** a human message during a CI wait delivers the message, the CI wait stays
  open, and its later result is delivered in a later turn (closes
  hearsay-tools/cezarion#1197's acceptance).
- **U4** `cezar_cancel_wait` cancels; no observation is delivered
  (hearsay-tools/cezarion#1226).
- **U5** no-wait turn end → one nudge → second no-wait turn end → Needs you.
- **U6** `cezar_done` refused with live workers and with settled but uncollected
  workers; accepted once collected; open waits cancelled.
- **U9** a provider failure and a clean session close with each kind of wait open
  leave the run recoverable, and the next wake reopens and delivers (extends
  R72–R76 to every kind).
- **U7** each alias (done line, ask line, monitoring line, `ScheduleWakeup`,
  native ask, `cezar_wait_for_ci`, `cez worker wait`) lands in the same list.
- **U8** a CI/timer park keeps its slot and wakes without queueing; a worker park
  frees it; wakes go ahead of unstarted runs; an account hold blocks wakes too.

Unit tables for `waitingOn`/`deriveAttention`, the slot arithmetic, the line
order, the budget and the upgrade-on-read conversion. Cockpit: header lists open
waits; the sidebar Needs-you bucket follows the new attention.

## Delivery plan

Phases ship in order; each leaves the default path complete.

1. **Wait list, CI and timers.** `waits` on the record with upgrade-on-read for
   `ciWait` and monitoring; `cezar_wait` (`ci`, `timer`) and `cezar_cancel_wait`;
   `cezar_wait_for_ci`, the monitoring line and `ScheduleWakeup` become aliases;
   human messages and asks stop withdrawing CI; the footer; CI/timer slot rule;
   `waiting` + `waitingOn` for CI/timer parks; `cezar_wait_for_ci` deprecated.
   Closes #1197 and #1226.
2. **Human waits and done.** `cezar_ask` and `cezar_done`;
   ask and done lines and native asks become aliases; the three-branch turn-end
   rule replaces `classifyTurnEnd`'s park inference, the prose gate, the
   final-message nudge and the ask override; autonomous handling; the budget.
3. **Workers.** Worker waits move into the list (several at once, CLI aliases);
   parent completion becomes a `cezar_done` refusal; worker human waits route to
   the parent; worker parks free their slot and idle-close.
4. **Line and usage limit.** Wakes-first line; account hold for every entry; a
   usage-limited run becomes `waiting`; `deriveAttention` finishes its rewrite;
   dead state (`parkAfterAck` branches, `workerWaiting`/`monitoring` sets,
   `hasPendingHumanAsk`) removed; the deprecated `cezar_wait_for_ci` tool and its
   route removed.

## Calls made by the agent (owner to check)

- Footer on every delivered turn, human or automatic.
- Timer idempotency keyed on note and seconds within one turn.
- 16 open waits per run.
- Automatic-wake budget counts only timers and nudges; 40, like today's caps.
- Worker and usage-limit parks idle-close after 15 minutes and reopen on wake.
- Autonomous runs refuse human waits until the budget is spent.
- A non-final workflow step with no open wait completes without a nudge.
- `cezar_done` cancels open waits instead of refusing while they are open.
- Native asks stay a mid-turn block (like permission prompts) instead of being
  disabled in favour of `cezar_ask`.
- A session that fails or closes with open waits parks and recovers for every
  kind, generalising today's CI rule.
- `monitoringWakeIntervalMinutes: null` refuses agent timers and turns the
  monitoring marker into a human wait.
- Downgrade fails loudly through a run-store schema bump rather than dual-writing
  legacy fields.
- The monitoring pool stays per project, as today.

## Left to the builder

Helper and field names beyond those above; the shape of `Wait` payload types as
long as they reuse the existing CI, worker and ask schemas; the exact nudge and
footer wording within the meaning above; how the pools are tracked in memory.

## Phase 1 decisions

Calls made while building phase 1 (hearsay-tools/cezarion#1233), within "Left to the
builder" unless a bullet says otherwise.

- **Timer bounds.** `seconds` is 60–7,200 (`TIMER_MIN_SECONDS`, `TIMER_MAX_SECONDS`) and
  `note` at most 512 characters. The floor keeps a timer from turning into a busy loop; the
  ceiling matches the CI deadline's.
- **`via`.** Every entry records what opened it, beside `source`: `cezar_wait`,
  `cezar_wait_for_ci`, `monitoring-line` or `schedule-wakeup`. An alias registration stays
  distinguishable from the tool without a per-kind field, for the transcript and for the U7
  parity cells.
- **Flat tool schema.** The Anthropic tool API refuses a top-level `oneOf`/`anyOf`/`allOf`,
  so `cezar_wait` advertises one flat `type: 'object'`: a `kind` enum and every kind's fields
  side by side, each with the bounds of its kind's schema. The discriminated union
  (`cezarWaitRequestSchema`) validates only on the server, and a field that does not fit its
  kind answers `invalid_request` naming it.
- **`wake_budget_spent`.** Phase 1 has no human wait to fall back to, so once the
  automatic-wake budget is spent `cezar_wait` refuses a timer with `wake_budget_spent`, a new
  code beside `timers_disabled`. Timer wakes count against the existing
  `MAX_AUTO_CONTINUES = 40`. Phase 2 replaces the refusal with the `reason: budget` human wait
  described above.
- **`lastWaitsError`.** `lastCiWaitError` becomes `lastWaitsError` (at most 256 characters):
  the retained recovery message when saved wait metadata cannot be trusted. It keeps today's
  rule that invalid wait state degrades to a visible "unavailable" observation, never success.
- **Open timers survive an interval change.** `resources.monitoringWakeIntervalMinutes`
  supplies the seconds of a timer the monitoring-line alias opens. Changing it affects only
  timers opened afterwards; a timer already open keeps its deadline.
- **Header.** The run header lists every open CI and timer wait (a CI wait with its PR link
  and deadline, a timer with its time and note), then the newest settled CI observation from
  `lastWaits`, or `lastWaitsError`, unless a CI wait is open. A settled timer is not shown.
  Kinds the header does not render (phase 2's human waits, phase 3's worker waits) are
  skipped; the pill already reports them through `waitingOn`.
- **Human input cancels nothing.** No wait, CI or timer, whatever its `via`, is cancelled by
  a human message, `resumeParkedRun`, a question or a permission request. The message is
  delivered and the wait keeps its deadline; the footer replaces the CI withdrawal note.
  A question or permission park leaves the monitoring pool and keeps its waits.
- **Aliases are idempotent per run and `via`.** The monitoring line opens a `monitoring-line`
  timer of the interval × 60 seconds, and `ScheduleWakeup` a `schedule-wakeup` timer of its
  `delaySeconds` clamped to 60–3,600, or of the interval when it gave none. While one is
  open, a later alias of the same `via` keeps it; a line and `ScheduleWakeup` in one turn
  open the `schedule-wakeup` timer only. A `cezar_wait` timer keeps the tool's own rule: the
  same seconds and note in the same turn return the open one. With re-checks off or the
  budget spent, an alias registers nothing, adds a note, and the run parks as a plain wait
  (phase 1 has no human wait for it to open). An autonomous run whose nudge would fire skips
  the alias.
- **A worker park cancels no wait.** Every open timer, whatever its `via`, and every CI wait
  keeps its deadline when the run parks on workers. Attention and slots follow
  `computeWaitingOn`: workers outrank CI and timers, so the park holds no slot and reads as
  the workers, and a `wake-pending` worker wait reads `waiting for capacity` above an open CI
  or timer wait. Until phase 3 puts worker waits in the list, a wait that resolves during the
  worker park is held: the worker wake is delivered first, and the held result at a later
  boundary.
- **Worker completion keeps `activity: monitoring` until phase 3.** Worker waits keep their old
  machinery in phase 1, and so does the completion gate: `deferParentCompletion` still writes a
  root parent whose completion is blocked on live workers, while its session is open
  (completion `attention`), as `running` with `activity: 'monitoring'`. That parent keeps a
  monitoring slot for its workers' wakes and opens no timer. It is the only remaining writer of
  that activity. A store read of that row (a restart, the read-only runs index) upgrades it like
  any legacy row: `waiting`, no timer, `activity` dropped. Phase 3 moves it into the wait list.
  *Replaced in phase 3b (hearsay-tools/cezarion#1301): nothing writes `activity: 'monitoring'`;
  a blocked done gets a refusal nudge, and an ignored one parks on Cezar's list worker wait. See
  § Phase 3b decisions.*
- **A resolved wait in the line reads `waiting for capacity`.** Rung 10: a `waiting` run with
  a resolved wait and no human signal is bucket none, tone running, a ring, no pulse. An open
  CI or timer wait still reads `waiting for CI` or `monitoring`.
- **Turn-end order.** A question or permission gate, then `CEZ:DONE`, then a worker wait,
  then the owed-input checks (held human input, unread or in-flight agent input, an admitted
  wake), and only then the wait park. A turn that parks on waits gets no final-message
  nudge. A non-interactive workflow step parks on its open waits too.
- **Slots.** Pool membership changes only at a turn end or on a terminal path, and always
  through `releaseSlot()`. A pool member running its wake turn keeps its slot until that turn
  ends; a wake of a pool member is admitted at once, with no `chargedCiWake` bookkeeping.
- **Wakes beside questions.** At a boundary, a wake is delivered beside a pending portable
  question; the card stays answerable and its answer keeps its `askSeq`. The wake goes through
  `sendAgentMessage(content, ids, { besideQuestion: true })`, never the answer transport. The
  runners that refuse agent input while a portable `CEZ:ASK` is pending (Claude, Pi, OMP,
  Cursor) skip only that refusal for it, and its provider acknowledgement is the checkpoint.
  A rejected acknowledgement fails the session like any rejected agent input (every runner
  that can reject one reports it as a provider error), and the waits stay resolved and the
  question pending: the run stays `waiting` on its waits, and a scheduler continuation delivers
  them after the wake backoff and re-parks as Needs you; a rejection that persists stops at the
  delivery bound (below). An acknowledgement after the wake turn ended parks the run for
  the question again. A pending native question delivers nothing mid-turn:
  the wake waits for the answer's turn end.
- **Recovery.** A parked run with waits stays parked and its wake folds in queued messages.
  A run with a pending question, or one that was not `waiting` and has queued messages,
  falls through to ordinary recovery so they are handled; its waits are re-armed either way.
- **The automatic-wake budget counts admitted turns.** An automatic batch that carries a timer
  result reserves one unit of `monitoringWakeups` when it is submitted, however many timers it
  carries; a refused submission or a rejected acknowledgement gives the unit back, and the
  acknowledgement keeps it. Nothing is charged per resolution, per retry or for a human-opened
  turn, and a human message resets the count as before (a batch still awaiting its
  acknowledgement keeps its unit). The count, reservations included, is checked when a timer
  comes due and again before a batch with timer results is sent: at `MAX_AUTO_CONTINUES` (40)
  those timers are cancelled into `lastWaits` with a cap note and wake nothing, while CI results
  in the same batch are still delivered and other waits are untouched. A parked run left with
  nothing open or resolved becomes a plain park: it reads Needs you, leaves the monitoring pool
  and arms the idle timer.
- **The budget is per live session in phase 1.** `monitoringWakeups` lives on the in-memory
  `ActiveRun`, not the run record, so it bounds automatic wakes per live session, not per run.
  A restart, any continuation (Continue, and the scheduler continuation that delivers a wait
  result to a closed session) and a human message start it again at 0. Durable per-run
  accounting is phase 2, with the `reason: budget` human wait.
- **Failed deliveries are bounded across sessions.** The per-session budget cannot stop a
  delivery whose session keeps failing, because every retry is a new session. So a session that
  fails (a provider error on the opening or resume prompt, a rejected acknowledgement beside a
  question, a crash) or closes cleanly while the run still owes resolved, unacknowledged results
  counts one failed delivery, in `execute` and in `runContinuation` alike. The next attempt waits `WAKE_RETRY_BACKOFF` (15 s,
  then 30 s) instead of starting at once; the third consecutive failure
  (`MAX_WAKE_DELIVERY_ATTEMPTS`, beside `MAX_AUTO_RESUMES`) settles the run `failed` through
  the ordinary failure path, with the last error and the note `could not deliver wait results
  after 3 attempts — continue this task to retry`. When the last attempt closed cleanly, that
  error is `the session closed before the wait results were delivered`
  (`WAKE_SESSION_CLOSED_ERROR`), on the step and, prefixed as any failure is, on the run. The count lives on the `RunManager`, in
  memory: a restart starts it again, like the per-session budget. A delivery acknowledgement,
  human input or a question answer, Continue, Stop, Finish and cancel reset it. A session that
  fails or closes cleanly with nothing resolved is not counted, and keeps today's park: its open
  waits wake it later. A usage-limit failure that owes results settles `failed` at once without being counted,
  so the usage-limit hold and its automatic resume take it, and the resume delivers them.
- **A failed run keeps the results it owes.** A `failed` run with a resolved wait is the one
  terminal row whose waits are not cancelled: its resolved waits stay resolved and undelivered,
  its open waits stay armed (also after a restart) and still resolve, and nothing wakes it.
  Continue delivers them once; a pending portable question stays answerable, and its answer
  opens the turn that also delivers them. Stop discards them and leaves the run `failed`:
  every wait, open and resolved, moves to `lastWaits` as `cancelled` and its undelivered input
  goes, the backoff, the admission retry, the delivery count and any automatic resume are
  cleared, no session starts, and the note `Stop discarded the waits this task held and their
  results; the task stays failed` (`WAITS_DISCARDED_NOTE`) is written. A later Continue is a
  plain continuation that delivers nothing from them. Deletion drops them with the row.
- **The held failed run's controls.** The cockpit offers Continue (delivers the results once),
  Stop (discards them, the run stays `failed`), Archive and Delete. `runActionFlags(run).cancel`
  is true for a `failed` run with a non-empty `waits` (`holdsWaitResults`) as for an active run,
  and the composer's Stop follows that flag. It is the one record that offers Stop and Delete
  together, since there is no session to stop. Stop takes the composer's outline slot there, so
  the header carries Archive on the Session tab (`archiveInComposer`). Finish stays unavailable,
  as on every failed run: `finishDecision` needs an open session. Archive does not discard the
  results; Continue on an archived run unarchives it and delivers them, as for any archived run.

## Phase 2 decisions

Calls made while building phase 2 (hearsay-tools/cezarion#1234). The owner approved the first
group at the design gate; the rest were made while building it, within "Left to the builder".
Phase 2 ships as two pull requests: 2a adds the tools, the aliases, the durable counters and the
prompt; 2b adds the three-branch turn-end rule and removes the prose gate, the final-message
nudge and the ask override. The decisions for 2b (the no-wait nudge absorbing the final-message
nudge, and the dry-run mocks answering it) are recorded with it.

- **A session without cezar tools keeps the markers.** When the tool controller is unavailable,
  the session gets today's marker prompt (`HANDOFF_ONLY_INSTRUCTIONS`), and its monitoring wake
  keeps the marker wording (`MONITORING_WAKE_NUDGE_MARKERS`). Every other session gets one
  "Lifecycle tools (cezar)" paragraph in place of the completion, still-working and
  structured-question marker paragraphs, and a wake that names `cezar_done` and `cezar_wait`.
  The marker lines stay accepted as aliases either way.
- **The user is asked with `cezar_ask`, and its card is required (owner, 2026-10-18).** The
  human kind left `cezar_wait`, whose one flat schema (the Anthropic tool API refuses a
  top-level union) otherwise carried a `questions` field only one kind takes; the narrower
  tools make the call that needs a card unmistakable. `cezar_wait` refuses `kind: "human"`
  with `invalid_request` and a message that names `cezar_ask`. The answer has no `kind` and no
  `deadline`, and the wait's `via` is `cezar_ask`. Nothing shipped with the human kind, so
  nothing is aliased.
- **Open questions.** A question with its `options` left out is open: the cockpit card shows only
  an answer field, like today's Other answer, and sends `header: text`. A list of options keeps
  its 2–4 bound, so an empty or one-option list is refused rather than read as open, and
  `multiSelect` applies only to options. The ask format is shared, so the ask line accepts open
  questions too; the native mappers still build questions with options. A worker's open question
  reaches its parent with `<header>: <your answer>` as its reply line.
- **A worker's human wait carries a card**, since every `cezar_ask` does. A worker's no-wait
  fallback stays today's plain park until phase 3. *Phase 3b (hearsay-tools/cezarion#1301)
  routes the second no-wait turn end to the parent as an open question; see § Phase 3b
  decisions.*
- **The budget is durable.** `automaticWakes` (timers, and in 2b nudges) lives on the run
  record. A human message and a human Continue reset it; a scheduler continuation and a restart
  keep it. A parent's answer to its worker does not reset it. A batch carrying timer results
  reserves its unit in memory when submitted and charges the record on the provider
  acknowledgement, so a batch a restart cuts off is charged once, at its redelivery. The
  delivery-failure count (`waitDeliveryFailures`) is on the record too and keeps phase 1's reset
  points. Both counters are committed at once, never on the store's debounced save: the charge
  and the cleared failure count are part of the delivery's own commit, and every other change
  to them (a nudge, a failed delivery, a reset) is its own commit.
- **One human wait per run.** A second registration in the turn that opened it replaces its card
  and returns the same `wait_id`. A registration after the user saw it returns that wait
  unchanged. A human wait registered while a question without a wait is pending (a prose gate)
  attaches to that question at the turn end instead of raising a second card.
- **Surfacing.** A human wait registered mid-turn is shown to the user (an `ask.requested`
  event, recorded as its `askSeq`) at that turn's end, or by the failure, close or recovery path.
  One registered at a boundary is shown at once. Recovery shows an unsurfaced human wait, sets
  the run `waiting` with its other waits re-armed, and resumes nothing.
- **The answer settles it.** Any human message settles every human wait as `delivered` (it never
  becomes `resolved`, so it queues no wake), and messages to a run whose only open wait is human
  are delivered as the answer, not held back.
- **A shown human wait cannot be cancelled by the agent.** `cezar_cancel_wait` answers
  `human_question` for it; only the user's answer ends it. One from the same turn, not yet
  shown, can be cancelled.
- **Aliases.** `cezar_ask` opens a `cezar_ask` human wait. The ask line opens an `ask-line` human wait with its card, a native ask a
  `native-ask` one, the monitoring line with re-checks off a `monitoring-line` one, and a spent
  budget a `budget` one (`source: 'cezar'`). In 2a a rejected ask line opened a cardless
  `ask-line` wait only where the turn already raised the prose gate; from 2b it opens nothing.
- **`cezar_done` keeps the completion gate.** It refuses with `human_question_pending` while an
  earlier turn's question is pending and with `worker_wait_pending` while a worker wait is
  registered, as the done line is overridden today; a root parent also refuses with
  `worker_questions`, `workers_outstanding` or `workers_uncollected`, listing up to 64 workers
  and the command that clears each. The session refusals are the ones `cezar_wait` and `cezar_ask` answer. An
  accepted done is taken by the turn end that reads it, and a human message clears it, so a
  later turn must call it again. A workflow step that is not the last refuses it with
  `not_final_step`, because that step's turn end runs the next step; it still ignores the done
  line. A human wait from the same turn is cancelled by the done (a later done beats an
  earlier ask).
- **The closing record.** `cezar_done`'s `summary` becomes a `note` event just before
  `goal achieved — session closed`, and that lifecycle event carries `via: 'cezar_done'` or
  `via: 'done-line'`. Both close through one helper.
- **Attention stays where it is.** Attention rung 3 ("an open human wait at any status") and the
  upgrade-on-read of pending asks into human waits wait for phase 4. Transcript gate facts stay
  authoritative until then, and `computeWaitingOn` reads both.
- **Schema 5.** The run store moves to schema 5, so a phase-1 build refuses a store that holds
  human waits (`unsupported-schema`) instead of dropping them as unreadable.

### Transitions out (phase 2a)

Required by AGENTS.md (hearsay-tools/cezarion#1247) for every state phase 2a adds or keeps. Added
with the 2a pull request, after its implementation; review it with that PR. Defaults are the
shipped ones: re-checks on, budget 40, no autonomy.

| State | Trigger | Who or what fires it | Behavior at shipped defaults |
| --- | --- | --- | --- |
| Human wait open, not yet shown (registered this turn) | The turn ends | The runner's turn end | It is shown (card, or the gate without one), and the run parks `waiting`, Needs you |
| | A human message arrives mid-turn | The user (`deliverMessage`) | Settled `delivered`; no card is raised for it |
| | `cezar_cancel_wait` | The agent | Moved to `lastWaits` as `cancelled` |
| | `cezar_done` accepted in the same turn | The agent, then the turn end | The run finishes; the wait is cancelled |
| | Provider failure, clean close, or a crash and restart | The failure, close or recovery path | It is shown and the run parks `waiting`, Needs you; recovery resumes nothing |
| | The step's authored `timeoutMs` passes | The runner's deadline kill | Cancelled into `lastWaits`; the run settles `failed` as before human waits (Q8). CI and timer waits still park it |
| `waiting` on a shown human wait (Needs you) | A human message, Continue, or the card's answer | The user | Settled `delivered` only once the answer is saved; the answer starts the next turn. **The only default exit that ends the wait is a human action** (for a worker, its parent's `worker reply`) |
| | 15 minutes idle | The idle timer (`IDLE_TIMEOUT_MS`) | The session closes; the run stays `waiting` with the wait, and the answer reopens it through the continuation |
| | The step's authored `timeoutMs` passes | The runner's deadline kill | Cancelled into `lastWaits`; the run settles `failed` and later steps do not run (Q8). CI and timer waits still park it |
| | A CI or timer wait resolves | The CI watcher or the wait timer | Its wake is delivered beside the question and the run re-parks Needs you; the human wait stays open |
| | Stop, Finish, delete | The user | Cancelled into `lastWaits`; the run settles |
| `cezar_done` accepted, turn still running (in memory) | The turn ends | The runner's turn end | The run closes as done there, or at the boundary that settles input still owed to the agent; a completion gate that fails at the turn end (`deferParentCompletion`) parks it instead |
| | A human message arrives | The user | The request is cleared; the agent must call `cezar_done` again |
| | The session fails or the process exits | The failure path | The request is lost with the session; the run follows its failure path |
| `waiting` on CI or timer waits (kept from phase 1) | A wait resolves (result, deadline) | The CI watcher or the wait timer | Its wake is delivered; a timer wake spends one unit of `automaticWakes` |
| | A timer comes due with the budget spent | The wait timer | The timer is cancelled with the cap note; with nothing else open, a `budget` human wait opens and the run reads Needs you, with or without a live session (recovery fires an overdue timer before one exists; U16b) |
| | A human message | The user | Delivered; every wait stays open with its deadline; the budget resets |
| | Stop, Finish, delete | The user | Every wait cancelled; the run settles |
| `waiting` with a result owed (waiting for capacity, kept) | A slot or a monitoring slot frees | The scheduler | The wake turn starts and delivers every resolved wait |
| | The delivery fails | The session's failure or clean close | Retried after 15 s, then 30 s (`waitDeliveryFailures` survives a restart); the third failure settles `failed` holding the results |
| `failed` holding wait results (kept) | Continue | The user | Delivers the results once |
| | Stop | The user | Discards them; the run stays `failed`. **No default exit is automatic** |
| Automatic-wake budget spent (`automaticWakes` ≥ 40) | A human message or a human Continue | The user | Reset to 0. A restart, a scheduler continuation and a parent's answer keep it. **Only a human action resets it** |

### Phase 2b decisions

Calls made while building 2b (hearsay-tools/cezarion#1234), within "Left to the builder".

- **One rule, applied in one place.** `decideTurnEnd` (`workflows/turn-end.ts`) is a pure function;
  `applyTurnEnd` applies it in both turn-end handlers and at the boundary an acknowledgement
  settles after its turn ended (`settleIdleBoundary`). Its order: input already owed defers; done
  finishes; any open wait or question parks; a step that is not the last completes; a spent budget
  opens a `budget` human wait; an autonomous run gets the autonomous nudge; any other turn end gets
  the no-wait nudge, once, before Cezar opens a `no-wait` human wait. A spent budget outranks the
  second no-wait turn end, because the cap is the more specific cause.
- **The nudge's words.** "Your turn ended without a wait or done. Call cezar_ask if you need the
  user, cezar_wait (ci or timer) if you are waiting on something, or cezar_done if the task is
  complete. If you owe the user a reply, write it in the same turn." It names only the kinds
  `cezar_wait` takes in this phase. A session without cezar tools gets the same sentence with the
  three marker lines, because it was taught the markers (phase 2 decision 1). The nudge spends one
  unit of the automatic-wake budget.
- **The no-wait nudge absorbs the final-message nudge (#544).** A silent tail is a turn end with no
  wait, so it gets the same one nudge. The final-message nudge's reply bound stays as the no-wait
  nudge's (`NO_WAIT_NUDGE_REPLY_MS`, 5 minutes): with no reply, the run notes it and Cezar opens
  its no-wait wait, and a reply that arrives later still resumes the run. Its rows F1–F11 stay and
  pin the no-wait nudge.
- **Cezar's own human waits raise no gate.** A `no-wait` or `budget` wait is not the agent's
  question. It is shown as its note, which is recorded as its `askSeq`, and the run reads Needs
  you because it is `waiting`. The run takes what the plain park took before: worker messages wake
  it, and its wait registrations, `cezar_done` and the user's Finish are not refused. A wait or
  question the agent registers replaces it (cancelled into `lastWaits`). It ends with the session
  that opened it, so a clean close completes the step and an idle close settles as the plain park
  did. The agent never registered it, so `open_waits` and the "Still open" footer leave it out, and
  a closing session or a late acknowledgement counts only the agent's waits.
- **A worker's fallback stays the plain park** (decision 4 above). A worker gets the no-wait nudge;
  its second no-wait turn end, or a nudge it never answers, parks it as before.
- **No prose is read.** `turnParkSignals` finds the markers only. A question or review request in
  prose with no wait gets the nudge; beside the monitoring line, live workers or another wait, the
  run parks on them and does not read Needs you. The gate a human wait without a card raises (the
  monitoring line with re-checks off) keeps the `unstructured-human-gate` note code, which older
  transcripts carry for the prose gate.
- **A rejected ask line registers nothing.** Its diagnostic note and raw text stay, and the turn is
  a turn end with no wait. `invalidAsk` clears at the next turn end, so a worker whose nudge reply
  also registers nothing settles done, not failed.
- **An autonomous ask line before the budget is not registered**, as `cezar_ask` refuses
  `autonomous_run`. The run notes `autonomous — question not registered; continuing` with the
  questions, and takes the autonomous nudge. The nudge still goes through the answer transport,
  because the runner holds the line as a pending portable ask; a wire that refuses the nudge
  registers the line after all.
- **The dry-run mocks answer the nudge.** With `CEZ_MOCK_NUDGE_REPLY` unset, every native mock
  answers the nudge with a `cezar_ask` card (the ask line in a session taught the markers), so a
  dry-run task parks on a question after one extra turn. With `plain` the mocks answer in plain
  text, and the run reaches Cezar's no-wait wait. The unit fixtures default to `plain`, the
  closest to the plain park they were written for, and so does the packaged `task-cli.test.ts`.
  The cells that need the card opt out. `composer.e2e.ts` runs on the card, which Finish closes.
- **Finish closes an open question; Stop keeps it** (hearsay-tools/cezarion#1260). On the default
  dry-run path a task parks on the card, and a card that stayed answerable after Finish hid the
  one-click Continue. An accepted Finish now records `human-ask-closed` (`reason: 'finish'`) with
  the question's `askSeq`. The question is retired as an answer would retire it, but no
  `human-input-delivered` is written, and the card reads "Closed when the task finished". Stop
  records nothing, so a stopped run's question stays for a human to answer (#505). A root's Finish
  is still refused while its question is open (U5c).
- **The compare column keeps the agent's summary.** The nudge's extra turn writes another
  `turn complete — …` heartbeat at the top of the Progress log. The variants compare column reads
  the log's first lines, so `handoffProgressExcerpt` now shows the agent's own lines and falls back
  to the lifecycle heartbeats only when the agent wrote none.

### Transitions out (phase 2b)

Required by AGENTS.md for every state 2b adds or keeps. Defaults are the shipped ones: re-checks
on, budget 40, no autonomy. The 2a table above still holds for the states it lists.

| State | Trigger | Who or what fires it | Behavior at shipped defaults |
| --- | --- | --- | --- |
| No-wait nudge sent, reply turn running (`running`, slot held) | The reply turn ends with a wait, a question or done | The runner's turn end | The rule parks, shows the question or finishes |
| | The reply turn ends with no wait again | The runner's turn end | Cezar opens its `no-wait` human wait and the run reads Needs you; a worker parks plain |
| | No reply within `NO_WAIT_NUDGE_REPLY_MS` (5 minutes) | The reply timer | The no-reply note, then the same as above; a reply that arrives later resumes the run |
| | A human message | The user | Delivered as the next turn; the budget resets |
| | Stop, Finish | The user | The run settles |
| | Provider failure or process exit | The failure path | The failure path as before; nothing is owed to the nudge |
| `waiting` on Cezar's own human wait (`no-wait` or `budget`, Needs you) | A human message, Continue | The user | Settled `delivered`; the answer starts the next turn; the budget resets |
| | A worker message | The worker (`worker send`) | Wakes the run, as the plain park did; the wait stays open until the agent's own wait or question replaces it |
| | The agent registers a wait or question in a woken turn | The agent | Cezar's wait is cancelled into `lastWaits`; the run parks on the agent's wait |
| | `cezar_done` in a woken turn | The agent | Accepted; the run finishes |
| | 15 minutes idle | The idle timer (`IDLE_TIMEOUT_MS`) | The session closes and the wait ends with it; the run stays `waiting`, and Continue reopens it. **No default exit other than this close and a human action** |
| | Stop, Finish, delete | The user | The run settles; Finish is not refused |
| Autonomous run, ask line before the budget | The turn ends | The runner's turn end | The line is not registered; the note and the autonomous nudge; this repeats until the budget |
| | The budget is spent | The runner's turn end | The nudge is refused with the cap note and the line is registered as an `ask-line` human wait (Needs you) |
| Prose question or rejected ask line beside the monitoring line, live workers or another wait | The turn ends | The runner's turn end | The run parks on its waits (monitoring or waiting on workers) and does not read Needs you; the timer's wake or the worker's message is the next exit |
| `waiting` on the agent's question (kept from 2a; amends its Finish row) | Finish, with or without a live session | The user | The wait is cancelled into `lastWaits` and `human-ask-closed` closes the question unanswered; no question stays pending, and Continue reopens the run with nothing typed (U18). A root's Finish is refused (U5c) |
| | Stop | The user | The wait is cancelled; the question stays pending for a human to answer (#505) |

## Phase 3a decisions

Phase 3a of hearsay-tools/cezarion#1235 moves agent-registered worker waits into the wait
list (hearsay-tools/cezarion#1235). This section and the table below are self-contained.

Calls made by the agent (owner to check):

- **U9 in 3a.** A provider failure or clean close with a worker wait open parks and recovers,
  as phase 1's path does for CI and timers. The "clean close with a worker wait is an error"
  branch is removed.
- **The completion park is unchanged until 3b.** The completion gate's own wait stays in
  `delegation.wait` with its old engine, including the `reason: 'message'` stand-in and the
  retirement of that wait by a non-progress message. The routing test is the one predicate
  "parked on the completion wait". Each kept piece carries a comment naming 3b.
  *Replaced in phase 3b (hearsay-tools/cezarion#1301): the completion wait and its old engine are
  gone; see § Phase 3b decisions.*
- **Upgraded queued wake inputs are kept.** An upgraded `wake-pending` wait records its
  already-queued input as `wakeInputId`; the result is delivered once, and a cancelled
  receipt's undelivered input is delivered as an ordinary input.
- **Done is not refused by agent worker waits.** `cezar_done` cancels open waits; only the
  completion gate's worker blockers refuse it.

Calls made by the owner (2026-10-19):

- **Messages beside a pending question.** A pending portable question no longer holds worker
  and parent messages back (this changes hearsay-tools/cezarion#505's hold). At a boundary
  they are delivered beside the card, which stays answerable and keeps its `askSeq`.

Decisions made during execution:

- Delivery beside a question applies to PORTABLE questions (`cezar_ask`). Beside a NATIVE
  question nothing is delivered mid-turn, and a parent's routed answer to a native worker
  question is admitted mid-turn.
- A human message keeps the old guarantees without withdrawing any wait: on a queued
  lifecycle wake continuation it flips the origin to `human` durably (so it answers a pending
  ask), and a startup-deferred message is persisted. This holds for every list wait kind.
- The delivery checkpoint and the resume to `running` are one commit
  (`commitWaitDelivery(..., resumed)`); upgrade reads the old crash window as `running`.
- A refused wake continuation notes once per refusal and retries at 1 Hz.
- The 32-input cap counts conversation inputs; the lifecycle wait-result input is outside it.

### Transitions out (phase 3a)

Required by AGENTS.md for every state 3a adds or keeps. Defaults are the shipped ones:
`maxParallel: 2`, `maxMonitoringSessions: 2`, re-checks on, budget 40, no autonomy
(`IDLE_TIMEOUT_MS` is 15 minutes; a failed delivery retries after 15 s, then 30 s, and the third
failure settles). The earlier tables still hold for the states they list. One row per exit.

| State | Trigger | Who or what fires it | Behavior at shipped defaults |
| --- | --- | --- | --- |
| `running`, a worker wait open (registered this turn) | The turn ends | The runner's turn end | `decideTurnEnd` sees an open wait and parks the run `waiting` (worker park) |
| | The provider fails or the process exits | The failure path | Parks `waiting` with the wait open; recoverable. Replaces the old error. With results owed it counts a failed delivery (retry 15 s, 30 s; the third settles `failed` holding the results) |
| | The session closes cleanly | The close path | Same as the failure row |
| | `cezar_done` accepted | The agent | Open worker waits are cancelled into `lastWaits` without a wake and the run finishes at the turn end; an agent worker wait does not refuse done (only live or uncollected workers do) |
| | Stop, Finish, delete | The user | Worker waits are cancelled into `lastWaits`; no wake; the run settles |
| `waiting`, top wait workers (worker park, session open, no slot held) | A worker settles (mode satisfied) or a named request is replied | Worker settlement / reply, through `reconcileWorkerFamily` | The wait resolves `outcome`; the wake joins the queue for a regular slot and the wake turn delivers it with the "Still open" footer |
| | The wait's deadline passes | The per-wait timer | Resolves `timeout`; wakes as above |
| | A worker message, an unrelated reply or a parent answer | The worker or the parent | Wakes the run; no wait is withdrawn; the footer lists it; the turn end re-parks |
| | A human message | The user | Delivered; every wait stays open; the budget resets |
| | Another wait (CI, timer) resolves | The CI watcher or the wait timer | Wakes the run; the worker wait stays open |
| | 15 minutes idle | The idle timer (`IDLE_TIMEOUT_MS`) | The session closes; the run stays `waiting` with the wait open (idle-closed row) |
| | `cezar_cancel_wait` / `cez worker cancel-wait` | The agent, in a woken turn | Cancelled into `lastWaits`; no wake |
| | Stop, Finish, delete, parent terminal | The user, or the parent's terminal path | Cancelled into `lastWaits`; no wake; the run settles |
| `waiting`, worker park idle-closed (or no session after a failure, clean close or restart) | A resolution, a deadline or a message | As in the worker-park rows | `queueWaitWake` reopens it through a scheduler-owned continuation, which delivers the results and messages |
| | The continuation is refused | The scheduler | One note per refusal; retried at 1 Hz until admitted (message-only wake row) |
| | Continue | The user | Reopens; the wait stays open |
| | Restart | Recovery | Re-arms deadlines, re-observes outcomes, and queues any owed wake |
| | Stop, Finish, delete | The user | Cancelled into `lastWaits`; the run settles |
| `waiting`, results or messages owed, refused a slot (message-only wake included) | A regular slot frees | The scheduler | The wake turn starts (or the session takes it at its boundary) and delivers every resolved wait and pending message |
| | No slot yet, no session | `retryWaitAdmission` | Re-queues the wake every second; a refused continuation notes once |
| | The delivery fails | Session failure or clean close | Failure count and backoff as in the first table; the third failure settles `failed` holding the results |
| | An inbox read takes the messages | The agent (`worker inbox`) | Nothing is left to deliver: `retireEmptyWake` frees the reserved slot and the run returns to its park |
| | Stop, Finish, delete | The user | Cancelled; the run settles |
| Pending NATIVE question, no session (or mid-turn) | Results (CI, timer, worker) or messages arrive | The watcher, a timer, a worker or the parent | **Not an exit.** `owesWake` is false while a native-ask wait is open, so nothing is delivered and no continuation starts; the provider would ask again |
| | The answer arrives | A human; or the parent, for a routed worker question | The answer is delivered (a parent's routed answer is admitted mid-turn); owed results and messages follow at that turn's end. **For a human-owned question the only default exit is this human action** |
| | Stop, Finish, delete | The user | The wait is cancelled; the run settles (Stop leaves the question for a human, as before) |
| Pending PORTABLE question (`cezar_ask`), results or messages owed | A boundary | The runner's turn end | Delivered beside the card (`besideQuestion`); the card stays answerable and keeps its `askSeq`; a parent's answer goes through the answer seam and withdraws no wait |
| Completion park (`delegation.wait` named by `completion.waitId`; replaced in phase 3b, see § Transitions out (phase 3b)) | The wait's workers settle (`mode: all`) | `reconcileWorkerFamily`, the old engine | The completion wake delivers; a list wait that resolved meanwhile is held until it |
| | The wait's deadline (10 minutes) passes | `workerWaitTimers` | Resolves `timeout`; the completion wake delivers |
| | A progress message | A worker | The stand-in `reason: 'message'` wakes the run; the completion wait is retained |
| | Any other message | A worker, the parent or a human | The stand-in wakes the run and delivering it ends the completion wait (old behavior, removed in 3b) |
| | Stop, delete | The user | Cancelled; the run settles. A root's Finish is refused while it is blocked on workers |

No state's only default exit is a human action except a pending native question for a
human-owned asker, which is the question's own gate and not a wait: every worker wait has a
deadline. (Phase 3b adds Cezar's deadline-less completion worker wait, which its workers'
settlement ends; its rows are in § Transitions out (phase 3b). The completion park row above is
superseded there.)

## Phase 3b decisions

Phase 3b (hearsay-tools/cezarion#1301), the second half of phase 3 (hearsay-tools/cezarion#1235),
moves the last two waits off the old worker-wait engine: the completion gate's own wait and a
worker's no-wait fallback.
This section and the table below are self-contained, and they replace phase 1's "Worker
completion keeps `activity: monitoring`" and phase 3a's "The completion park is unchanged until
3b" bullets, phase 2's "a worker's no-wait fallback stays today's plain park", and phase 3a's
completion park rows.

Calls made by the owner (2026-10-19):

- **A blocked done becomes a refusal nudge.** At a turn end whose done the completion check
  refuses (the done line, or a `cezar_done` accepted earlier in the turn whose check fails at the
  turn end), Cezar opens no wait and parks nothing. It sends the agent the refusal `cezar_done`
  returns mid-turn (`worker_questions`, `workers_outstanding`, else `workers_uncollected`) as one
  automatic turn, built by the one helper both paths share. The agent then waits, stops or
  collects on its own. The 10-minute Cezar-opened `delegation.wait`, its deadline and its
  `delegation.completion` record are gone. A pending human question still parks for the user, as
  before.
- **The nudge says what happens next.** When live workers block the done, the nudge adds exactly
  one sentence (`COMPLETION_WILL_WAIT`): *If you end your turn with done again while these workers
  are live, Cezar will wait on them for you and wake you when they have all settled.* The
  mid-turn `cezar_done` answer never carries it.
- **A closed session gets the nudge too.** A block found after the session closed
  (`settleSuccess` after its async work, a restart, a legacy accepted Finish) queues the refusal as
  one lifecycle input, charged as the live nudge is; `queueWaitWake`'s scheduler continuation
  reopens the session and delivers it, and that turn counts as the nudge's. Its reply is bounded
  like the live nudge's (`awaitCompletionNudgeReply`: the reply timer, armed again after the wake's
  checkpoint). A run owes one refusal at a time: a done blocked again while it is owed queues no
  second copy and charges nothing. The owed refusal holds the closing session like a wait does
  (`holdsClosingWakes`): a reopened session that closes or fails before Cezar submits it is a failed
  delivery, with the backoff and the bound of `MAX_WAKE_DELIVERY_ATTEMPTS`, after which the run
  fails keeping the refusal for Continue to deliver once. Its delivery clears the failure count, as
  a message's does.
- **An ignored refusal parks on the workers.** One nudge per cycle. If the turn that answers it
  ends on a blocked done again with workers still live, Cezar registers a list `worker` wait on
  them for the agent: `source: 'cezar'`, `via: 'completion'`, `mode: 'all'`, the live blocking
  workers only, no `deadline` and no `timeoutSeconds`, no slot, idle-closing at `IDLE_TIMEOUT_MS`
  like phase 3a's worker parks. Their settlement resolves it; their messages and routed questions
  wake the parent beside it. With only uncollected results or unanswered worker questions, Cezar
  opens its own human wait (`via: 'completion'`, the refusal as its note) and the run parks for
  the user.
- **A worker's no-wait fallback: nudge, then parent.** A worker keeps the one no-wait nudge. When
  its next turn also ends with no wait and no done, Cezar's `no-wait` human wait carries one open
  question (`WORKER_FALLBACK_QUESTION`: *Worker `<id>` ended its turn without waiting on anything
  or finishing. Reply with what it should do next.*), raised as `ask.requested` so
  `routeWorkerQuestion` takes it to the parent as a request. The parent's reply resumes the worker
  through the answer seam; a parent that cannot receive leaves it with the human
  (`worker-question-fallback`).

Calls made by the agent (owner to check):

- **Waits and owed input come first.** A refused done is not a done: it cancels no wait. With an
  open agent wait or input owed at that turn end, there is no nudge; the run parks on its waits or
  takes the input, and the refusal is a timeline note. The agent meets the refusal again at its
  next done. Cezar's own human waits are withdrawn by the nudge instead.
- **One cycle.** A cycle is consecutive turns: the turn that answers a refusal nudge is the only
  one whose blocked done takes the second step; any other turn end, a human message, a wake or
  the agent's own wait starts a fresh cycle. A human message or a wake clears the cycle even when
  it arrives before the nudge's turn ends (a harness that never answered the nudge); only the
  delivery of the queued refusal itself marks its turn as the nudge's. The queued refusal is known
  by `purpose: 'completion-refusal'` on its persisted `AgentInput`, never by process memory, so a
  Continue after a run that failed at the delivery bound, and a restart, deliver it as the nudge:
  under the nudge's reply bound, and holding a closing session as a wait does. Stop retires an
  undelivered refusal, as it discards the run's waits, so no later Continue delivers a stale one;
  on a `failed` run that owed only the refusal it answers `{ cancelled: true }`, the run stays
  `failed`, and the note is `Stop discarded the completion refusal this task still owed; the task
  stays failed` (`REFUSAL_DISCARDED_NOTE`). Deletion drops it with the row.
- **Bounds.** The nudge and every parent reply that resumes a worker from its fallback question
  are charged to the automatic-wake budget (`MAX_AUTO_CONTINUES`, 40) through
  `chargeAutomaticWake`, so neither an agent that keeps declaring done nor a parent and worker
  going back and forth spins without bound. The nudge's reply is bounded by the no-wait nudge's
  reply timer (`COMPLETION_NO_REPLY_NOTE`). A spent budget opens Cezar's `budget` human wait for a
  root, and plain-parks a worker without routing.
- **Autonomous runs** are nudged again instead of parked, until the budget, as the no-wait nudge
  is (§ Autonomous runs), so an autonomous parent is never parked for a human while its workers
  run.
- **Agent-registered worker waits keep their deadline.** `workerWaitEntrySchema` makes
  `deadline` and `timeoutSeconds` optional for `source: 'cezar'` entries only; the agent's worker
  waits still require both (1–1800 seconds), and the legacy `WorkerWait` shape keeps its deadline.
- **`via: 'completion'`** is a new `via` value; `openHumanAlias` treats it as `source: 'cezar'`,
  like `no-wait` and `budget`.

Decisions made during execution:

- **The fallback question is Cezar's, not the worker's.** What the plain park it replaced let
  through still goes through: a parent's steer, an automatic message, an admitted Continue, a clean
  exit or a restart supersedes it. Its routed request gets the `completed-without-reply` outcome
  (so it no longer holds the parent's done), the parent's unread copy is retired, and only then is
  the question closed unanswered (`human-ask-closed`, reason `superseded`) and Cezar's wait
  withdrawn. A refused Continue leaves all three intact. A question the worker asked itself is
  never superseded.
- **A legacy accepted Finish intent** (`delegation.finishRequestedAt`) is cleared and takes the
  same refusal path as a done.
- **The old engine is deleted.** The `reason: 'message'` stand-in, `retainsWorkerWaitOnProgress`,
  `prepareWorkerWaitBatch`, `parkWorkerWait`, the completion deadline timers and admission caches
  are gone. `delegation.wait`, `delegation.lastWait`, `delegation.completion` and
  `activity: 'monitoring'` are no longer written; the schema keeps them optional so old rows
  parse. `worker_wait_pending` stays in the contract's `DoneErrorCode` (and the ask and CI wait
  codes) for old clients and is never returned.
- **Upgrade on read, store schema 7.** A stored root whose `delegation.wait` is the completion
  wait (`completion.waitId === wait.id`) is read into a `worker` list entry (`source: 'cezar'`,
  `via: 'completion'`, its workers, mode, deadline and phase; an already-queued wake input kept as
  `wakeInputId`), and `delegation.wait`/`completion` are dropped. Its promised wake happens once,
  through the list engine. A schema-6 build refuses a schema-7 store as `unsupported-schema`.
- **Inspection.** The legacy `WorkerWait` shape keeps its required deadline, so worker
  inspection's `wait` never carries the completion wait. Inspection adds an optional
  `completionWait` (`workerCompletionWaitSchema` in `packages/contract`: that shape without
  `deadline` or request fields, plus `via: 'completion'`), present while the parent holds an open
  or owed completion wait on the worker; the cockpit's Workers section reads the same projection
  (`completionWaitView`) and says the wait has no deadline. The open-waits footer names it
  `worker wait <id> on N workers, no deadline`.
- **Display.** A refusal nudge reads like the no-wait nudge: a `running (completion nudge)`
  heartbeat and a note naming the refusal code (`COMPLETION_NUDGE_NOTE`). The completion human
  wait reads as Cezar's own human wait (note `completion blocked; waiting for you` or the refusal).
  A routed fallback reads on the worker as a routed question and on the parent as an incoming
  request.
- **Coverage.** `RUNNER_IDS` cells in `workflows/waits-parity-cells.testkit.ts`, each on every runner's
  native mock wire through `HARNESS_ADAPTERS`: U20 and U20u (the nudge, with and without the
  will-wait sentence), U20h and U20m (a human message, in the opening session or a continuation, or
  a worker message after a nudge the harness acknowledged on its native wire and never answered
  starts a fresh cycle), U20a (a done in the turn that answers an input acknowledged after that
  turn ended: the done waits at the boundary and the acknowledgement's settlement gives the nudge;
  Claude and Cursor print are exempt, as neither ends a turn before its acknowledgement), U11 (an open timer at a blocked done: no
  nudge, the refusal is a note), U21
  (an ignored refusal parks on the completion worker wait, which settlement wakes), U21r (that
  wait restarted and settled), U21m (a worker message wakes it beside the open wait), U21t (an
  agent timer beside it keeps its deadline), U21h (only uncollected results: Cezar's human wait),
  U21a (autonomous: nudged again until the budget), U22 (a closed session reopened to deliver the
  refusal), U22s (a reopened session that acknowledges it on its native wire and never answers:
  the reply bound parks it), U22c (reopened sessions that keep closing first: one copy, the delivery bound, the
  run fails keeping it and Continue delivers it once; a legacy Finish too), U22f (one such close
  counts a failure and the delivery clears it), U24 (a worker's fallback routed to its parent, whose reply resumes it), U25 (an
  automatic message supersedes it) and U9v (an upgraded completion wait wakes once through the
  list). The silent harness is each native mock's `mock:ack-only` reply
  (`CEZ_MOCK_COMPLETION_REPLY`). Cursor print takes named exemptions from U20h, U20m and U22s (no
  acknowledgement before native model work, as F8), and OpenCode from U20h (one prompt per turn: a
  human prompt waits for a turn that never goes idle). `workflows/old-engine-removed.test.ts` guards that no source writes `delegation.wait` or
  `activity: 'monitoring'`.

### Transitions out (phase 3b)

Required by AGENTS.md for every state 3b adds or keeps. Shipped defaults: `maxParallel: 2`,
`maxMonitoringSessions: 2`, budget 40, no autonomy, `IDLE_TIMEOUT_MS` 15 minutes, the no-wait
nudge's reply bound (`NO_WAIT_NUDGE_REPLY_MS`, 5 minutes). Earlier tables hold for the states they
list, except phase 3a's completion park rows, which this table replaces. One row per exit.

| State | Trigger | Who or what fires it | Behavior at shipped defaults |
| --- | --- | --- | --- |
| `running`, root turn ending on a blocked done (first in the cycle) | The turn ends | The runner's turn end | Refusal nudge submitted (one automatic turn, charged); the run stays `running` |
| | An open wait or owed input | `canAutoContinue` | No nudge; parks on its waits or takes the input; the refusal is a note |
| | The session is gone | `settleSuccess` / recovery | The refusal is queued as a lifecycle wake; the scheduler continuation reopens the session and delivers it |
| | The session is gone and a refusal is already owed | `settleSuccess` / recovery | No second copy and no charge; the owed copy's wake reopens the session |
| | The reopened session closes or fails before the refusal is submitted | The close/failure path (`holdsClosingWakes`) | A failed delivery: `waiting`, retried after the backoff; at `MAX_WAKE_DELIVERY_ATTEMPTS` (3) the run fails keeping the refusal (`WAKE_DELIVERY_CAP_NOTE`), and Continue delivers it once |
| | The budget is spent | The budget | Cezar's `budget` human wait; parks for the user |
| `running`, refusal nudge turn | The turn ends with a wait | The runner's turn end | Parks on that wait (earlier tables) |
| | The turn ends on a blocked done again, workers live | The runner's turn end | Cezar registers a list worker wait on them (no deadline); parks `waiting`, no slot |
| | The turn ends on a blocked done again, only uncollected or questions | The runner's turn end | Cezar's own human wait with the refusal note; parks `waiting` for the user |
| | The turn ends on a blocked done again, autonomous run | The runner's turn end | Nudged again, charged, until the budget; then Cezar's `budget` human wait |
| | The turn ends with no wait and no done | The runner's turn end | The ordinary turn-end rule: the no-wait nudge (if unspent this session), else Cezar's `no-wait` human wait |
| | The done is no longer blocked | The runner's turn end | Finishes |
| | No reply within the nudge reply bound (a live nudge, or a queued one delivered to the reopened session) | The reply timer | Cezar's own human wait; parks for the user; a late reply resumes it |
| | Provider failure or clean close | The failure/close path | As phase 2b's no-wait nudge rows |
| `waiting`, root on Cezar's completion worker wait (no slot, no deadline) | Every worker on it settles | Worker settlement, `reconcileWorkerFamily` | Resolves `outcome`; wakes the parent; its next blocked done starts a fresh cycle |
| | A worker message or routed question | The worker | Wakes the parent; the wait stays open |
| | A human message | The user | Delivered; the wait stays open; the budget resets |
| | 15 minutes idle | The idle timer | Session closes; the run stays `waiting`; a wake reopens it through the scheduler continuation |
| | Restart | Recovery | Re-observes outcomes; a settlement meanwhile resolves it and wakes the parent once |
| | `cezar_cancel_wait` | The agent, in a woken turn | Cancelled into `lastWaits`; no wake |
| | Finish | The user | Refused while workers are live or uncollected or a worker question is unanswered (`delegationFinishBlockedReason`, the readiness check every Finish action runs first); the wait stays open. Accepted once readiness holds |
| | Stop, delete | The user | Cancelled; the run settles |
| `waiting`, root on Cezar's completion human wait (no slot) | A worker settles, messages or asks | The worker | Wakes the run (Cezar's own wait does not hold worker input); a fresh cycle |
| | Every worker already settled, with results uncollected and nothing owed (no message, no question) | Nothing | **No default exit: only a human action ends it.** No settlement or message is left to come, so the parent waits for the user (Needs you, the refusal as its note) |
| | A human message | The user | Delivered; the wait settles; a fresh cycle; the budget resets |
| | 15 minutes idle | The idle timer | The session closes; the run stays `waiting`; a worker wake, if one remains, reopens it through the scheduler continuation |
| | Finish | The user | Refused while results are uncollected or a worker question is unanswered (`delegationFinishBlockedReason`); the run stays parked. Accepted once readiness holds |
| | Stop, delete | The user | Settles |
| `waiting`, root with an upgraded completion wait (schema 7) | Its workers settle, or its stored deadline passes | `reconcileWorkerFamily` / the per-wait timer | Resolves once through the list; the woken turn's done takes the 3b path |
| `running`, worker turn ending with no wait (first) | The turn ends | The runner's turn end | No-wait nudge, unchanged |
| `running`, worker no-wait nudge turn | The turn ends with no wait and no done | The runner's turn end | A human wait with an open card; `ask.requested`; routed to the parent; the worker parks `waiting` (no slot) |
| `waiting`, worker on a routed fallback question | The parent replies | The parent (`worker reply`) | Answered through the answer seam, charged to the worker's budget; the worker resumes (reopened through the scheduler if its session closed) |
| | The parent steers, or an automatic message arrives | The parent or Cezar | Supersedes the question (`human-ask-closed`, `superseded`; the routed request completes without reply); the message is delivered and the worker resumes |
| | An admitted Continue | The user | Supersedes the question; the worker continues. A refused Continue leaves it intact |
| | The worker's process exits cleanly, its session idle-closes (15 minutes), or a restart finds no process | The close path, the idle timer, recovery | Supersedes the question; the worker goes on as the plain park did (a workflow continues; an idle-closed worker settles and its parent can collect it) |
| | The parent cannot receive | `routeWorkerQuestion` | `worker-question-fallback`; the question waits for a human (Needs you); a human message answers it |
| | The parent finishes, stops or fails | The parent's terminal path | Live owned workers are cancelled with their root, as before |
| | The parent goes to review | The parent's review path | Workers keep running; the routed question falls back to the human |
| | A human message | The user | Refused while the question is routed to the parent (as for a worker's own routed question); after `worker-question-fallback` it answers it and the worker resumes |
| | Stop, delete | The user | Settles |
| `running`, worker turn with its budget spent | The turn ends with no wait | The runner's turn end | Plain park, not routed; a human message or a parent message continues it. **Its only default exits are a human or the parent** |

Two states 3b adds or keeps have no automatic exit, and the table says so. The completion human
wait, once every worker has settled and only uncollected results remain, has a human as its only
default exit: nothing is left to come from the workers, and only the parent itself could collect,
which needs a turn the user starts. The budget-spent worker park keeps phase 2b's plain park and
ends only on a human or a parent message. Otherwise no state 3b adds waits only on a human: the completion worker
wait ends on its workers' settlement, the completion human wait with workers still live on a
worker's next settlement, message or question, and the fallback question on the parent's reply.
Finish never ends a completion park early: the readiness check refuses it while any blocker
remains.

## Phase 4a decisions

Phase 4a (hearsay-tools/cezarion#1236) is the first half of phase 4. It puts wakes of started runs
ahead of new tasks, holds every line entry on a usage-limited account, and stores a usage-limited
run as `waiting`. The "Slots and the line", "Status and display" and "Liveness bounds" sections
stay authoritative; this section records the calls made within "Left to the builder".

Calls made by the owner (2026-10-21):

- **The split.** 4a is this section and references the issue without closing it. 4b, the next
  pull request on the same issue, closes it: the rest of the `deriveAttention` rewrite on
  `waitingOn`, removal of the legacy park state, removal of `cezar_wait_for_ci` and its private
  route (with its `BACKWARD_COMPATIBILITY.md` entry), and removal of
  `RunStore.commitCiWaitWithdrawal` and the `human_ask_pending` / `human_ask_unanswered` codes.
  4b gets its own decisions section and Transitions out table.
- **A withdrawn appointment ends `failed`.** A per-task cancel, an archive, the setting switched
  off, a missed window, the cap or a refused resume settles the held run `failed`, with its kept
  error and the note it has today. The end state is the one before 4a.

Calls made by the agent:

- **The line has two classes** (`workflows/line-order.ts`, `nextLineEntry`). A *wake* is a queued
  wait wake or a queued continuation (a scheduler continuation, a usage-limit resume, a
  Continue), ordered by when it joined the line (`waitWakeQueuedAt`, or the continuation's
  `lineJoinedAt`). A queued owned worker counts as a wake that joined at its creation: it is
  its family's work in progress, so its parent's later wake (a worker wait that timed out) does
  not take the slot before the worker has run. An *unstarted* run is any other queued job, in
  queue order. Wakes go first. An entry
  that cannot leave (no capacity, an account hold, a cleanup, a pending finish) keeps its place,
  and the next eligible entry is taken.
- **Across projects**, the workspace semaphore wakes the project with the oldest wake first
  (`oldestWakeAt()`, optional on a participant), then the oldest queued entry as before.
- **Every line entry honours an account hold.** A CI or timer wake for a run in the monitoring
  pool joined no line before; while its account is held it now joins the line, keeps its
  monitoring slot, and leaves (without a regular slot) on the first pump after the hold lifts. A
  `deadline` hold blocks every entry on the account. An `inFlight` hold blocks every entry except
  other resumes, so it blocks a wake.
- **A usage-limited run is `waiting` with `autoResumeAt`.** The failure path writes `waiting`, no
  `finishedAt`, and keeps `error`. The store clears `autoResumeAt` on every status but `waiting`,
  so a resume that starts (`running`) retires the appointment. `failed` + `autoResumeAt` from an
  older store loads as `waiting` + `autoResumeAt` (schema 8).
- **The held run is never woken by its own waits.** They stay open, resolve and stay owed; the
  resume's opening turn delivers them, as a scheduler continuation delivers results.
- **A human message or Continue during the hold** is the user's own Continue: it retires the
  appointment and joins the line as a wake (origin human, budget reset, human waits answered). It
  starts at once when a slot is free and no other run holds its account; another run's known
  deadline on that account keeps it queued until the hold lifts. Human input into a live session
  still skips the line.
- **Holds are keyed by the execution account** (`workflows/execution-account.ts`): a live
  session's step settings, a queued continuation's backend, else the step that holds the run's
  latest session, else the record's `runner` and `agentProfile`. A mixed-runner step is held by
  the account it ran on, on both sides of the hold.
- **A held wake is not advertised.** `oldestWakeAt()` leaves out a wake its account holds, so
  another project's eligible wake gets a freed slot first.
- **A withdrawal is committed before it is reported** (`RunStore.commitAutoResumeWithdrawal`):
  status, `finishedAt` and the cleared appointment are written at once, then the timer goes and
  the note is appended.
- **The cockpit treats a hold as a closed session** (`isRunActive(run)`): Continue with its
  runner and account pickers, Archive, Delete and Don't resume; Stop only when it holds wait
  results; no paused hint and no Finish.
- **Stop during the hold** keeps the behaviour of the scheduled `failed` run: with open waits,
  Stop discards them, withdraws the resume and the run ends `failed`; with none, Stop is refused.
- **Restart.** Recovery re-arms the held run's open waits and leaves the resume to
  `reconcileAutoResumes`; it does not reopen a session.
- **Attention.** `waitingOn.kind === 'usage-limit'` reads `{ bucket: 'none', tone: 'neutral',
  shape: 'ring', pulse: false, label: 'usage limit' }`, after the human rung and before workers.
  The old `failed` + `autoResumeAt` → `scheduled` rung is gone. The cockpit's meta line says
  `usage limit, resumes in 12m`; `cez task` says `usage limit, resumes <ISO time>`. The sidebar
  group family keeps the word `scheduled`.
- **Webhook.** A usage-limit hold sends no delivery, as the scheduled resume sent none
  (`deriveWebhookState` returns `undefined`).

### Transitions out (phase 4a)

Required by AGENTS.md for every state 4a adds or keeps. Shipped defaults: `maxParallel: 2`,
`maxMonitoringSessions: 2`, auto-resume on, at most 12 resumes. Earlier tables hold for the states
they list. One row per exit.

| State | Trigger | Who or what fires it | Behavior at shipped defaults |
| --- | --- | --- | --- |
| `waiting` + `autoResumeAt` (usage limit, no session, no slot) | The resume time passes | The auto-resume timer (`fireAutoResume`), re-armed by `reconcileAutoResumes` after a restart | A resume continuation joins the line as a wake; it starts when a slot is free (a resume passes an `inFlight` hold); its opening turn delivers every resolved wait |
| | A human message or Continue | The user | The appointment is retired; the continuation joins the line as a wake and starts when a slot is free and no other run holds the account |
| | Per-task cancel (`DELETE /runs/:id/auto-resume`) or archive | The user | Settles `failed` with the kept error and the note it has today |
| | Auto-resume switched off | The user (settings), seen by the next pump | Settles `failed`, note `automatic resume cancelled — auto-resume is switched off` |
| | The window was missed by over a day | `reconcileAutoResumes` | Settles `failed` with the expiry note |
| | The cap is reached, the run is archived or unreadable at fire time | `fireAutoResume` | Settles `failed` with the matching note |
| | `continueRun` refuses at fire time | `fireAutoResume` | Settles `failed` with the `could not start` note |
| | Stop with open waits | The user | Waits discarded, the resume withdrawn; settles `failed` |
| | Stop with no open wait | The user | Refused, as for the scheduled `failed` run before 4a; the hold stays |
| | Delete | The user | The run and its timers go |
| | One of its waits resolves | The wait's own watcher or timer | Stays resolved and owed; no wake; the resume delivers it |
| | Restart | Recovery | Open waits re-armed; the resume re-armed by `reconcileAutoResumes` |
| A wake held by an account hold (live session, regular or monitoring slot) | The hold lifts | The resume timer, the resume's turn end, a per-task cancel, an archive or the settings change, each of which pumps | Admitted by that pump and delivered at the session's turn boundary |
| | Stop, cancel or delete | The user | Waits cancelled; the queued wake is dropped |
| | A human message | The user | Delivered at once (human input skips the line); the held results stay owed and go with the next admitted wake |
| A wake queued behind capacity (no hold) | A slot frees | Any slot release (the semaphore wakes the project with the oldest wake first) | Admitted before any unstarted run |
| An unstarted run queued | A slot frees with no wake able to leave and no hold on its account | Slot release | Starts, as before 4a |

Every state above has a default exit that needs no human: the resume timer for the hold (or a
settlement to `failed`), a pump for a held or queued wake, and a slot release for an unstarted
run.
