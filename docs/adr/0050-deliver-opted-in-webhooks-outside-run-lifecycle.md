# Deliver opted-in webhooks outside the run lifecycle

Task webhooks are explicit per-run subscriptions. A run with `notify` on reports to every
project webhook that has task notifications on. A project once had one webhook target;
hearsay-tools/cezarion#1639 replaced it with a list. A legacy single `webhook` key reads as one
webhook in that list. One store subscriber derives selected attention-state transitions rather
than observing every lifecycle call site. Attach it before recovery so startup transitions are
not mistaken for initial state.

## Consequences

Deliveries use an ordered queue per run and per webhook, with a timeout and bounded retries.
A slow or failing webhook does not delay another. Failure records
an outcome but never drives task settlement. The queue is in memory; a restart can lose pending
deliveries. This is best-effort notification, not a durable outbox or exactly-once guarantee.

The API exposes whether a token is set, not its value. Empty token input retains it and an
explicit clear removes it. A webhook can also be exposed to agents. An agent report is a
separate on-demand delivery through such a webhook; agents never see its URL or token. Selected-state filters and question projection remain shared with
the contract; a raw waiting status does not alone mean a reportable human question.

Implementation: [webhook.ts](../../packages/cezar/src/runs/webhook.ts), [webhooks.ts](../../packages/cezar/src/workspace/webhooks.ts), [webhooks-section.tsx](../../packages/web/src/routes/settings/webhooks/webhooks-section.tsx), [attention.ts](../../packages/contract/src/attention.ts).

Coverage: [webhook.test.ts](../../packages/cezar/src/runs/webhook.test.ts), [project-webhooks-api.test.ts](../../packages/cezar/src/server/project-webhooks-api.test.ts).
