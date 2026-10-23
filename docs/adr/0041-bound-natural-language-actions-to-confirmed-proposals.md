# Bound natural-language actions to confirmed proposals

Voice mode sends one sentence to a typed decision engine. The engine chooses from supplied
questions and candidates; execution code consumes only applicable answers. Keep model choice
behind an engine seam, with a deterministic dry-run implementation.

## Consequences

Opening a task can execute directly. Mutations and other actions become proposals that need
a separate confirming input. The Return that submits a sentence cannot also confirm its result.
Decisions are tied to the exact input and current selection so a late response cannot take over
an action the user already selected. The server resolves meaning; browser code owns debounce,
cancellation and confirmation timing.

Implementation: [engine.ts](../../packages/cezar/src/voice/engine.ts), [use-voice-command.ts](../../packages/web/src/components/voice/use-voice-command.ts), [2026-10-21-voice-mode.md](../../.ai/specs/2026-10-21-voice-mode.md).

Coverage: [use-voice-command.test.tsx](../../packages/web/src/components/voice/use-voice-command.test.tsx).
