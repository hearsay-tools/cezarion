# Bound managed skill updates after the server listens

Managed Open Mercato skills have default-on background updates as an explicit exception to
the opt-in network rule. Start the coordinator after the server listens. Serialize its work
and absorb failures so update availability cannot block startup. A global setting overrides
the environment default; disabling automatic application retains background detection.

## Consequences

Only recognized installation lock metadata authorizes skill names from the canonical source.
Untracked folders do not cause an installation. Checks and updates pass explicit names in
fixed argument arrays, with command time and output bounds. Checks use a six-hour cache and
a cross-process lock; this is bounded background work, not a boot prerequisite.

Before updating, intersect the last available names with freshly read lock ownership.
Recheck after releasing the lock and invalidate the catalog after a successful scope update.
Partial failures remain visible without undoing successful scopes. The browser cannot widen
the authorized update list. These rules describe cezar's invocation policy, not a guarantee
about the external package manager's future behavior.

Implementation: [skills-update.ts](../../packages/cezar/src/skills-update.ts), [server.ts](../../packages/cezar/src/server/server.ts), [config.ts](../../packages/cezar/src/workspace/config.ts), [.env.example](../../.env.example).

Coverage: [skills-update.test.ts](../../packages/cezar/src/skills-update.test.ts), [skills-update-api.test.ts](../../packages/cezar/src/server/skills-update-api.test.ts), [config.test.ts](../../packages/cezar/src/workspace/config.test.ts).
