# Journal installation and respect shared artifacts

Installation is a strategy of ordered check/run/undo steps over injected UI and command
interfaces. The engine holds a single-writer lock, resumes recorded work and undoes completed
or partially created work in reverse. The artifact ledger distinguishes cezar-owned resources
from shared tools that the operator may now use elsewhere.

## Consequences

Uninstall removes owned artifacts and gives manual guidance for shared ones. Persist the
ledger atomically with restrictive permissions. Cancellation is a value that can be saved,
and failed or skipped reruns must retain earlier artifact evidence.

A dry-run over a real installation cannot replace its durable ledger. A real run must reset
preview outcomes rather than treat them as installed work. Privileged steps show the command
and verify the resulting state before advancing; they do not silently escalate. The TUI library
stays behind the installer UI adapter and outside ordinary server imports.

## Considered Options

- **Treat all installed tools as removable ownership.** Rejected because shared tools and certificates can outlive cezar.
- **Resume a real install from preview success.** Rejected because a preview creates no corresponding resources.

Implementation: [engine.ts](../../packages/cezar/src/server-install/engine.ts), [state.ts](../../packages/cezar/src/server-install/state.ts), [types.ts](../../packages/cezar/src/server-install/types.ts), [ui.ts](../../packages/cezar/src/server-install/ui.ts).

Coverage: [engine.test.ts](../../packages/cezar/src/server-install/engine.test.ts), [state.test.ts](../../packages/cezar/src/server-install/state.test.ts).
