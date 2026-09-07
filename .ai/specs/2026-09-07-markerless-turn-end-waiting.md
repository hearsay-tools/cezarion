# Immediate waiting state for markerless turn ends

> Issue: #119

## Problem

An open interactive session whose agent ends a turn without `CEZ:DONE`,
`CEZ:ASK`, or `CEZ:MONITORING` hands control to the user. Both workflow paths
already mutate the in-memory run and current step to `waiting`, but that state is
left to the store's debounced index write. The run event is also a single live
frame, so a cockpit that misses it has no recovery signal: the session remains
open and `run-reconcile.ts` only treats `session.ended` as evidence that a cached
record is stale.

The observed Codex incident therefore showed a completed markerless turn in the
transcript while `runs.json` and the cockpit continued to report `running` for
minutes. The eventual debounced state change does not satisfy the interaction:
the user needs to see that a reply is due as soon as the turn ends.

## Decision

Apply a bounded two-layer repair.

1. Treat parking as a durability boundary in both workflow turn-end handlers.
   After setting the run to `waiting` with no activity and the current step to
   `waiting`, synchronously flush the run store before releasing the execution
   slot. The store's existing `run` notifications publish the complete mutated
   record; no new event or API shape is introduced.
2. Extend the thread's stale-record healer with an open-session park signal. A
   persisted v1 `turn-end` later than the most recent session/turn opening or
   user message means the latest turn is parked. If the cached record still says
   plain `running` after the existing two-second grace period, invalidate both
   run detail and run list queries. A healthy `waiting` record cancels the timer,
   and `running` plus `activity: 'monitoring'` is already correct and must not be
   reconciled to attention.

The server remains authoritative. The transcript signal causes a refetch rather
than writing a guessed `waiting` record into the browser cache. This also heals a
dropped monitoring frame correctly: the refetch obtains the server's persisted
`running`/`monitoring` state.

## Constraints

- Markerless open-session turn ends persist both run and step as `waiting`
  before turn-end handling yields.
- The existing store `run` event carries a record whose run and current step are
  both `waiting`.
- Apply the durability write at both construction sites: initial agent steps and
  live-session continuations.
- `CEZ:MONITORING` remains `status: 'running', activity: 'monitoring'`, retains
  its wake behavior, and never becomes a Needs-you signal.
- `CEZ:DONE`, structured/native asks, autonomous turns, session failure, idle
  timeout, and monitoring wake behavior are unchanged.
- Do not add a status, event schema, route, environment variable, dependency, or
  compatibility layer.
- Reconciliation keeps the existing two-second grace and invalidates both the
  detail query (thread) and list query (sidebar/attention surfaces).

## Verification

- A real Codex app-server fixture and the bundled dry-run runner each prove that
  the published park record is complete and `runs.json` is already `waiting`
  after the turn-end callback yields.
- A continuation turn proves the second workflow handler has the same durable
  boundary.
- Web tests prove a stale plain-running record over a latest `turn-end` refetches,
  while healthy waiting, monitoring, and a later resumed turn stay quiet.
- Existing monitoring, task-group, attention, and thread tests remain green.
