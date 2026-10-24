# Curate child environments and redact transcript output

Agent processes can execute commands from untrusted task content. Build their environments
from a base toolchain allowlist, backend-specific variables and explicit per-run overrides,
instead of passing every host variable. Match names without case sensitivity while retaining
the host spelling. Command-only children use a narrower environment.

## Consequences

Explicit passthrough and full-environment escape hatches remain available. Per-run overrides
apply last, so their callers must supply trusted values.

Before transcript persistence, redact recognized secret values and known token patterns.
Environment curation and redaction share the secret-name rule. Redaction is a best-effort
filter, not a promise to recognize every credential; user-authored task text has its own handling.
The existing environment and redaction opt-outs retain their documented behavior.

## Considered Options

- **Inherit the full host environment.** Available as an opt-out, but excluded from the normal agent and command paths.

Implementation: [agent-env.ts](../../packages/cezar/src/core/agent-env.ts), [secret-redaction.ts](../../packages/cezar/src/core/secret-redaction.ts), [.env.example](../../.env.example).

Coverage: [agent-env.test.ts](../../packages/cezar/src/core/agent-env.test.ts), [secret-redaction.test.ts](../../packages/cezar/src/core/secret-redaction.test.ts).
