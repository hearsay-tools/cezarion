# Deliver opted-in webhooks outside the run lifecycle

Task webhooks are explicit per-run subscriptions to a configured project target. One store
subscriber derives selected attention-state transitions rather than observing every lifecycle
call site. Attach it before recovery so startup transitions are not mistaken for initial state.

## Consequences

Deliveries use an ordered queue per run with a timeout and bounded retries. Failure records
an outcome but never drives task settlement. The queue is in memory; a restart can lose pending
deliveries. This is best-effort notification, not a durable outbox or exactly-once guarantee.

The API exposes whether a token is set, not its value. Empty token input retains it and an
explicit clear removes it. Selected-state filters and question projection remain shared with
the contract; a raw waiting status does not alone mean a reportable human question.

Implementation: [webhook.ts](../../packages/cezar/src/runs/webhook.ts), [task-webhook.tsx](../../packages/web/src/routes/settings/task-webhook.tsx), [attention.ts](../../packages/contract/src/attention.ts).

Coverage: [webhook.test.ts](../../packages/cezar/src/runs/webhook.test.ts).
