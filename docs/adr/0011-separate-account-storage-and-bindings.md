# Keep account identity and session bindings together

Named accounts and their per-project selections live in `agent-accounts.json`, separate
from the project registry. A version that rewrites only the registry cannot remove them.
Selections use canonical project roots, and account removal clears its selections in the same
write. The discovered default stays implicit.

## Consequences

A named account must select a supported native home or profile that keeps login and session
state together. The core mapping is pure; workspace code resolves stored selections and
checks availability. The default adds no override. Named overrides apply after the environment
allowlist, and terminal takeover carries the same account context.

The implemented mapping supports account relocation only where cezar has an accepted mapping;
a config-only relocation is insufficient. Broad XDG relocation is not used for named accounts
because it would also change tools called by the agent. Unknown stored selections can fall
back in `selectProfile`; known unavailable named accounts refuse launch instead of silently
using the default. Explicit request validation can be stricter.

Ordinary steps prefer their recorded account, then a matching run override, then the project
selection and default. Owned workers instead use their accepted pinned identity.

## Considered Options

- **Keep account keys in the registry.** Rejected because their survival would depend on other versions preserving unknown keys.
- **Relocate settings alone.** Rejected because the displayed account and the billed login could differ.

Implementation: [agent-accounts.ts](../../packages/cezar/src/workspace/agent-accounts.ts), [agent-profiles.ts](../../packages/cezar/src/workspace/agent-profiles.ts), [agent-profiles.ts](../../packages/cezar/src/core/agent-profiles.ts).

Coverage: [agent-accounts.test.ts](../../packages/cezar/src/workspace/agent-accounts.test.ts), [agent-profiles.test.ts](../../packages/cezar/src/core/agent-profiles.test.ts), [agent-profiles.test.ts](../../packages/cezar/src/workspace/agent-profiles.test.ts).
