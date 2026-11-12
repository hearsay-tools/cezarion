# Gate Cezar workers and task messaging per task

`CEZ_DELEGATION=1` was one process-wide switch for three things: the private loopback listener,
`cez message` between tasks, and every root task's authority to spawn and resume Cezar workers
(hearsay-tools/cezarion#2784). A user could not turn workers on from the cockpit, or keep them
off for one task while another used them.

Each task now carries two settings on its run record: `allowWorkers` ("Allow cezar workers") and
`allowMessaging` ("Allow task messaging"). Both are on by default. A new task stores the explicit
value; a record without the field reads as on. The listener always starts, and `CEZ_DELEGATION`
has no effect.

The delegation service reads the settings on every call, so a change applies at once through a
session's existing credential:

- Workers off refuses new `spawn`, `--resume` of a settled worker and model/runner discovery. The
  serial queue reads the setting again just before acceptance, so a spawn that waited is refused
  too. A replayed request ID still returns its receipt. The task keeps listing, messaging,
  waiting on, inspecting, collecting, stopping and destroying the workers it owns.
- Messaging off refuses new peer sends, peer discovery and new peer waits from the task, and sends
  to it are recorded as not delivered. A reply to a request accepted earlier passes in both
  directions. Messages between a task and its own workers are never gated by either setting.
- A root session with both off, no worker receipt (a deleted worker's receipt counts, so its
  retained result stays collectable) and no open peer request gets the endpoint but no credential, so
  `cez discover` refuses rather than reach the cockpit; worker sessions and roots with owned
  workers keep theirs. The session keeps the governed-session cross-session controls, whose
  reach is runner-specific (`AGENT_PROTOCOL.md` D1); this path does not widen or narrow them.

Every task becomes a root at its first provisioned session. Rules that protect a family, such
as holding Finish or the agent's done while the parent's question is pending, apply only to a root
that has worker receipts; a lone task finishes as before, and Finish closes its question.

A session's instructions follow the settings at launch. Turning a setting on reaches the agent at
its next session; turning one off is enforced by the server at once.

Workers outlive a parent failure (hearsay-tools/squawk#3337,
[spec](../../.ai/specs/2026-11-12-provider-error-hold.md)). A provider error holds the parent
instead of failing it, and a parent that fails for any other reason leaves its live workers
running; only a human Stop of the parent, or a parent that ends `done` or `review`, cancels them.
`--resume` restarts a `cancelled` worker whose worktree and branch exist, in a fresh session when
none was recorded. Destroy stays the permanent end.

## Consequences

AGENTS.md asks for features that widen exposure or cost to be opt-in behind an off-by-default
`CEZ_*` flag. This decision is the named exception: the owner chose workers and messaging on by
default, with a per-task off switch in every creation path (cockpit, `cez task start` and `cez run`
`--no-workers`/`--no-messaging`, automation `task.allowWorkers`/`task.allowMessaging`) and on any
existing task. The listener binds loopback only and authenticates each session with its own
rotating token, as before. Workers are paid agent sessions; the worker limits cap resources and
runaway spawning, not spending.

The settings are cooperative supervision, not process isolation. Native subagents inside one
session are not Cezar workers, and the settings do not change them (hearsay-tools/cezarion#2279).

Callers that set `CEZ_DELEGATION=1` need no change. Callers that relied on its absence turn the
settings off per task.

## Considered Options

- **Off by default for new tasks.** The issue's first proposal. Rejected by the owner: workers and
  messaging are the expected default, and each task can turn them off.
- **Keep `CEZ_DELEGATION=0` as a controller-wide kill switch.** Rejected: a second switch that
  overrides the task's own setting is a knob the per-task settings make unnecessary.
- **Write the choice into the root's delegation permissions.** Rejected: a task without a
  delegation record has nowhere to keep it, and turning workers back on would have to restore
  permissions the record never lost.
- **Gate family messages with the messaging setting.** Rejected: a worker reports and asks its
  questions through them, so existing workers would stop working.

Implementation: [policy.ts](../../packages/cezar/src/delegation/policy.ts),
[service.ts](../../packages/cezar/src/delegation/service.ts),
[conversation-send.ts](../../packages/cezar/src/delegation/conversation-send.ts),
[provision.ts](../../packages/cezar/src/delegation/provision.ts),
[wait-registry.ts](../../packages/cezar/src/workflows/run/wait-registry.ts).

Coverage: [task-access.test.ts](../../packages/cezar/src/delegation/task-access.test.ts),
[provision.test.ts](../../packages/cezar/src/delegation/provision.test.ts),
[patch-run.test.ts](../../packages/cezar/src/server/patch-run.test.ts),
[peer-waits.test.ts](../../packages/cezar/src/workflows/peer-waits.test.ts).
