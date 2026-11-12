# Stage and verify application self-updates

**Retired.** The cockpit no longer updates its own installation: the Update button, its
routes and `packages/cezar/src/application-update/` are gone. A new release still accepts
`--restart-exact` and reports `application-update-listening` over IPC, so the helper of an
older release (v0.14.9 to v0.18.0) can update into it
(`packages/cezar/test/e2e/restart-handshake.test.ts`). This record describes the removed
policy, not a current capability.

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

Implementation: [discovery.ts](https://github.com/hearsay-tools/cezarion/blob/v0.18.0/packages/cezar/src/application-update/discovery.ts), [service.ts](https://github.com/hearsay-tools/cezarion/blob/v0.18.0/packages/cezar/src/application-update/service.ts), [launcher.ts](https://github.com/hearsay-tools/cezarion/blob/v0.18.0/packages/cezar/src/application-update/launcher.ts), [helper.ts](https://github.com/hearsay-tools/cezarion/blob/v0.18.0/packages/cezar/src/application-update/helper.ts), [npm-process.ts](https://github.com/hearsay-tools/cezarion/blob/v0.18.0/packages/cezar/src/application-update/npm-process.ts).

Coverage: [discovery.test.ts](https://github.com/hearsay-tools/cezarion/blob/v0.18.0/packages/cezar/src/application-update/discovery.test.ts), [service.test.ts](https://github.com/hearsay-tools/cezarion/blob/v0.18.0/packages/cezar/src/application-update/service.test.ts), [helper.test.ts](https://github.com/hearsay-tools/cezarion/blob/v0.18.0/packages/cezar/src/application-update/helper.test.ts), [npm-process.test.ts](https://github.com/hearsay-tools/cezarion/blob/v0.18.0/packages/cezar/src/application-update/npm-process.test.ts), [lock.test.ts](https://github.com/hearsay-tools/cezarion/blob/v0.18.0/packages/cezar/src/application-update/lock.test.ts).
