# Isolate real-application verification state

Browser verification runs a real server over an owned isolated clone. Its registry and dry-run
environment belong to the fixture. Build E2E assets into an ignored service mirror rather than
overwriting production dist outputs that other checks consume.

## Consequences

Keep a test invocation’s environment lease through setup, specs and teardown, not only server
startup. Builds, clone refresh and registry changes are shared mutable resources too. Ownership
checks guard replacement of fixture paths; synchronization updates live fixture content without
quietly changing its base revision.

Isolation keeps verification from registering throwaway projects in the user’s home or starting
a second cockpit over live task state. Preserve local setup, timing and provenance annotations
that automated verification uses.

## Considered Options

- **Serve the working checkout and rebuild production dist during tests.** Rejected because tests would mutate live cockpit state and invalidate other checks’ declared build inputs.

Implementation: [build-e2e.sh](../../.ai/scripts/build-e2e.sh), [e2e-served-repo.mjs](../../.ai/scripts/e2e-served-repo.mjs), [test-env-lease.mjs](../../.ai/scripts/test-env-lease.mjs), [agent-browser.ts](../../packages/web/e2e/agent-browser.ts).

Coverage: [fixture-serve-env.test.ts](../../packages/web/src/test/fixture-serve-env.test.ts), [fixture-server-start.test.ts](../../packages/web/src/test/fixture-server-start.test.ts).
