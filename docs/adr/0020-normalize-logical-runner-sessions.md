# Normalize logical sessions behind one runner seam

Each backend implements AgentRunner and AgentSession. The factory and RUNNER_IDS own the
runner set. A logical session supports follow-up input, interruption and resume even when its
adapter replaces the native process between turns. Backend wire types stay behind this seam.

Runners emit the legacy event stream alongside the normalized item-lifecycle vocabulary.
Pure mappers translate native events; display code consumes the common item identity and
status vocabulary rather than inferring each backend’s wire.

## Consequences

Old recordings and mixed transcripts remain readable. The normalized protocol is additive;
legacy-only content still needs a fallback rather than an invented normalized twin.

Adapters declare field support, prompt-on-resume policy and observable input delivery. A transport
acknowledgement is distinct from model consumption. Native mock-wire parity checks exercise
every registered runner and require explicit exemptions for real wire limits. Tool restrictions
remain adapter capabilities, not a general shell sandbox.

Implementation: [AGENT_PROTOCOL.md](../../AGENT_PROTOCOL.md), [agent-runner.ts](../../packages/cezar/src/core/agent-runner.ts), [ui-events.ts](../../packages/cezar/src/core/ui-events.ts), [thread-state.ts](../../packages/web/src/routes/task-thread/thread-state.ts).

Coverage: [harness-parity.test.ts](../../packages/cezar/src/core/harness-parity.test.ts), [ui-parity.test.ts](../../packages/cezar/src/core/ui-parity.test.ts).
