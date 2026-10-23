# Stage and verify application self-updates

Self-update operates only on recognized npm-owned installations. Unsupported layouts retain
manual updates. Preparation installs an engine-checked release into a separate stage and
validates its package and assets before offering Restart. It keeps the original installation
and command-link recovery evidence until a replacement boot is proven.

## Consequences

A detached helper is copied outside the package npm replaces. Its runtime dependencies are
built-ins, and credentials stay in the inherited environment rather than the saved plan.
Discovery and mutation share a verified, shell-free npm invocation. Installation locks and
claim checks fence preparation, promotion and rollback.

Restart waits for the old process to exit. Success needs both private IPC from the exact child
and matching HTTP health identity; a different server on the port is insufficient. A failed
replacement must be proven stopped before rollback or relaunch. Uncertain exit or failed
recovery requires manual repair rather than another competing process. Recovery copies remain
until a later locked preparation can remove them.

Implementation: [discovery.ts](../../packages/cezar/src/application-update/discovery.ts), [service.ts](../../packages/cezar/src/application-update/service.ts), [launcher.ts](../../packages/cezar/src/application-update/launcher.ts), [helper.ts](../../packages/cezar/src/application-update/helper.ts), [npm-process.ts](../../packages/cezar/src/application-update/npm-process.ts).

Coverage: [discovery.test.ts](../../packages/cezar/src/application-update/discovery.test.ts), [service.test.ts](../../packages/cezar/src/application-update/service.test.ts), [helper.test.ts](../../packages/cezar/src/application-update/helper.test.ts), [npm-process.test.ts](../../packages/cezar/src/application-update/npm-process.test.ts), [lock.test.ts](../../packages/cezar/src/application-update/lock.test.ts).
