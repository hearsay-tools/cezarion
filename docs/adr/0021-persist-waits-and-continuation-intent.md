# Persist waits and continuation intent before delivery

Waits are durable run entries. RunManager owns registration, resolution and result delivery;
pure helpers describe them. One turn-end decision serves initial sessions, Continue and late
input acknowledgements. Owed input defers closure; accepted done, explicit waits and nonfinal
step completion have defined precedence. Agent prose is not classified to infer completion.

## Consequences

A final turn without wait or done gets a bounded nudge policy and then a human wait. Autonomous
runs can nudge until their budget is spent. Timer and process waits consume that budget; external
events are distinct. Persist delivered outcomes with their saved input and any required charge,
or after those dependencies commit.

Queued prompts and continuation intent survive the process-local job maps. Recovery rebuilds
execution from records, including when no session exists. Provider acceptance and its durable
checkpoint cannot be atomic; identified input can be replayed after a crash. Do not claim
exactly-once model delivery. The unified-waits spec holds the detailed transition rules.

Queued prompt hydration is read-only: compose task and message stack for execution without
writing the composite back to the task. Recovery must not append the same stack repeatedly.

Chained agent steps share a task and handoff, but each must finish its own goal. The step
note explicitly prevents an earlier step’s done report from completing a later step’s work.

Implementation: [turn-end.ts](../../packages/cezar/src/workflows/turn-end.ts), [waits.ts](../../packages/cezar/src/workflows/waits.ts), [run.ts](../../packages/cezar/src/workflows/run.ts), [2026-10-17-unified-waits.md](../../.ai/specs/2026-10-17-unified-waits.md), [types.ts](../../packages/cezar/src/workflows/types.ts).

Coverage: [turn-end.test.ts](../../packages/cezar/src/workflows/turn-end.test.ts), [waits.test.ts](../../packages/cezar/src/workflows/waits.test.ts), [run.test.ts](../../packages/cezar/src/workflows/run.test.ts), [human-waits.test.ts](../../packages/cezar/src/workflows/human-waits.test.ts), [waits-wake.test.ts](../../packages/cezar/src/workflows/waits-wake.test.ts).
