# Keep native configuration and model authority

Cezar edits known native config files as raw text. A maintained catalog owns paths, formats
and precedence descriptions; an unknown path is not guessed. Validate syntax, preserve the
user’s bytes, check a content version, and write through symlinks rather than replacing them.
Do not impose a copy of a vendor schema.

## Consequences

Tracked configuration reaches task worktrees through commits. Only the supported ignored
personal layer is seeded and excluded from Git. The editor refuses to empty a populated file
accidentally. Its version check detects stale reads but is not a cross-process transaction.

Discover model choices from the host where a native adapter is available, with bounded failure
and preset fallback. Keep canonical provider/model identity separate from backend wire forms.
Unknown custom model ids remain allowed; known cross-runner presets can be refused. A native-model
lock can defer selection to the installed CLI. Vendor file and discovery behavior must be
rechecked when adapters change.

## Considered Options

- **Validate vendor schemas or reserialize config.** Rejected because a raw editor must preserve fields and formatting it does not own.
- **Treat preset ids as a whitelist.** Rejected because custom and native-discovered model ids must remain usable.

Implementation: [catalog.ts](../../packages/cezar/src/agent-config/catalog.ts), [files.ts](../../packages/cezar/src/agent-config/files.ts), [host-model-catalog.ts](../../packages/cezar/src/core/host-model-catalog.ts), [model-identity.ts](../../packages/cezar/src/core/model-identity.ts).

Coverage: [files.test.ts](../../packages/cezar/src/agent-config/files.test.ts), [validate.test.ts](../../packages/cezar/src/agent-config/validate.test.ts), [model-presets.test.ts](../../packages/cezar/src/core/model-presets.test.ts).
