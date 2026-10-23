# Bound managed skill updates after the server listens

**Retired** by [hearsay-tools/cezarion#1541](https://github.com/hearsay-tools/cezarion/pull/1541).
Cezar no longer ships managed Open Mercato skill updates or default team sources. This record
describes the removed policy, not a current capability.

Managed Open Mercato skills had default-on background updates as an explicit exception to
the opt-in network rule. The coordinator started after the server listened, serialized its
work and absorbed failures so update availability could not block startup. A global setting
overrode the environment default; disabling automatic application retained background detection.

## Consequences

Only recognized installation lock metadata authorized skill names from the canonical source.
Untracked folders did not cause an installation. Checks and updates passed explicit names in
fixed argument arrays, with command time and output bounds. Checks used a six-hour cache and
a cross-process lock; this was bounded background work, not a boot prerequisite.

Before updating, the service intersected the last available names with freshly read lock
ownership. It rechecked after releasing the lock and invalidated the catalog after a successful
scope update. Partial failures stayed visible without undoing successful scopes. The browser
could not widen the authorized update list. These rules described cezar's invocation policy,
not a guarantee about the external package manager's behavior.

Implementation at the last inspected pre-removal snapshot: [skills-update.ts](https://github.com/hearsay-tools/cezarion/blob/921e09ee614bd5480fd16c16d9f5da1a0fefe884/packages/cezar/src/skills-update.ts), [server.ts](https://github.com/hearsay-tools/cezarion/blob/921e09ee614bd5480fd16c16d9f5da1a0fefe884/packages/cezar/src/server/server.ts), [config.ts](https://github.com/hearsay-tools/cezarion/blob/921e09ee614bd5480fd16c16d9f5da1a0fefe884/packages/cezar/src/workspace/config.ts), [.env.example](https://github.com/hearsay-tools/cezarion/blob/921e09ee614bd5480fd16c16d9f5da1a0fefe884/.env.example).

Coverage at that snapshot: [skills-update.test.ts](https://github.com/hearsay-tools/cezarion/blob/921e09ee614bd5480fd16c16d9f5da1a0fefe884/packages/cezar/src/skills-update.test.ts), [skills-update-api.test.ts](https://github.com/hearsay-tools/cezarion/blob/921e09ee614bd5480fd16c16d9f5da1a0fefe884/packages/cezar/src/server/skills-update-api.test.ts), [config.test.ts](https://github.com/hearsay-tools/cezarion/blob/921e09ee614bd5480fd16c16d9f5da1a0fefe884/packages/cezar/src/workspace/config.test.ts).
