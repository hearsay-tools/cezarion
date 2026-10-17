# Unified waits: one list, three tools, one turn-end rule

Status: approved by the owner (2026-10-17). Phase 1: hearsay-tools/cezarion#1233.
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
| `human` | agent (`cezar_wait`), an alias, a native ask, or Cezar's no-wait fallback | optional question card (`askRequestSchema`) | none | a human message arrives |
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
`cezar_wait({kind:'human'})`, which parks at a real boundary and lets everything
else wake the agent.

### Tools

One MCP server, already wired into every runner through the `cezarTools` list in
`ci-wait/tools.ts` (Claude `--mcp-config`, Codex `mcp_servers`, OpenCode, Cursor
`mcpServers`, Pi and OMP extensions). Adding a tool there reaches every runner.

- `cezar_wait({ kind, ... })` → `{ wait_id, kind, deadline?, open_waits }`.
  Validates synchronously and refuses with a typed reason (`invalid_request`,
  `capacity`, `autonomous_run` for a human wait in an autonomous run, …).
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
     the nudge — "Your turn ended without a wait or done. Call `cezar_wait`
     (`human` if you need the user; `ci`, `worker` or `timer` if you are waiting on
     something) or `cezar_done`." It counts against the automatic-wake budget.
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
a footer listing the waits still open ("Still open: human question q1; CI wait
w2 for org/repo#12, deadline 15:40"). The footer replaces the CI withdrawal note.

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
waking the agent, as it retires CI intent today.

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
- Parks that hold no slot close their session after 15 minutes idle (today's
  `IDLE_TIMEOUT_MS`, now for worker and usage-limit parks too); a wake reopens it
  through the existing scheduler-owned continuation. CI and timer parks hold a
  slot and stay open, bounded by the two pools.

### Autonomous runs

`cezar_wait({kind:'human'})` refuses with `autonomous_run` and the autonomy
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

- **U1** each kind registers through the tool on the native wire, parks, and
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
2. **Human waits and done.** `cezar_wait({kind:'human'})` and `cezar_done`;
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
  disabled in favour of `cezar_wait({kind:'human'})`.
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
