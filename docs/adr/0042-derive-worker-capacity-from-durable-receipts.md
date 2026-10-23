# Derive worker capacity from durable receipts

An owned worker consumes resources beyond its active model turn. Capacity therefore counts
accepted workers until verified destroy or completed history deletion releases their receipt.
Derive that count from durable state rather than incrementing a process-local counter. A
separate lifetime creation ceiling bounds runaway spawning and ledger size.

## Consequences

Done, review and a missing worker record do not alone release capacity. Continue can spend
again, so neither capacity nor creation count is a token budget. Admission resolves each agent
step’s account, runner and grants before acceptance; authored tools can narrow inherited grants.
Native adapter support still determines effective tool restriction, so this is not hard shell
isolation.

Conversation acceptance, provider delivery, model consumption, explicit reply and lifecycle
completion remain distinct. First durable request settlement wins, apart from the defined late
reply amendment after timeout. Review is readiness rather than request completion. Waits observe
these outcomes without turning any progress message into a reply.

Implementation: [capacity.ts](../../packages/cezar/src/delegation/capacity.ts), [service.ts](../../packages/cezar/src/delegation/service.ts), [conversations.ts](../../packages/cezar/src/delegation/conversations.ts).

Coverage: [capacity.test.ts](../../packages/cezar/src/delegation/capacity.test.ts), [conversations.test.ts](../../packages/cezar/src/delegation/conversations.test.ts).
