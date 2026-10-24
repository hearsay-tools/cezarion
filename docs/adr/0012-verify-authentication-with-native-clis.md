# Keep native CLIs authoritative for authentication

Authentication status comes from each provider’s CLI. Cache connected answers longer than
negative ones and serve known status while refreshing in the background. Before refusing an
action on cached unavailability, recheck it. Disabled providers are a settings fact and need
no probe.

## Consequences

Runtime authentication errors raise an incident that overrides ordinary probes. A targeted
native check can clear it only on a connected result for the observed incident generation.
Named-account checks update that account’s cache, never the default’s. Unresolvable accounts
and inconclusive checks leave the incident intact.

Verification is bounded and coalesced. A cooldown decline schedules one deferred check so a
new incident does not become permanent. Cache peeks never spawn a process; they are suitable
for inventory reads, not fresh authorization decisions.

## Considered Options

- **Refuse from an aging negative cache entry.** Rejected because a terminal login may have changed it.
- **Require a human retry for every runtime incident.** Native verification now also permits recovery, while generation checks protect newer failures.

Implementation: [provider-auth.ts](../../packages/cezar/src/core/provider-auth.ts), [server.ts](../../packages/cezar/src/server/server.ts), [provider-auth-runtime.ts](../../packages/cezar/src/server/provider-auth-runtime.ts).

Coverage: [provider-auth.test.ts](../../packages/cezar/src/core/provider-auth.test.ts).
