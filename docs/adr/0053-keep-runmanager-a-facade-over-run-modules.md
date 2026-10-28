# Keep RunManager a facade over workflows/run modules

`RunManager` stays the one entry point to run execution: `workflows/run.ts` keeps its export, its
constructor and the members that shipped code calls. The code behind those members moves into
modules under `workflows/run/`, one subsystem per module. A module never imports `run.ts`; it
calls back through a host interface that the facade builds, and it reads shared values from one
run context.

## Consequences

`RunManager` still owns wait registration, resolution and result delivery, as ADR 0021 records.
It owns them at its public surface; the code lives in the modules behind it. `activate` and
`dropActive` stay in the facade as the only way into and out of the active-run map.

A move keeps names and bodies and changes no expected test outcome. Methods that tests spy on,
wrap or replace stay manager methods, and modules call them through the host, so those tests
still observe every call. Tests move to the modules only in the last phase, each move with a
red proof. Guards that read `run.ts` by path also cover `workflows/run/` before code moves there,
so a moved function stays under every rule that covered it.

Each module stays under the file-length limit of 1,000 lines. A module whose host would need
about a dozen manager members waits until its dependencies have moved.

Implementation: [run.ts](../../packages/cezar/src/workflows/run.ts), [2026-10-28-run-ts-decomposition.md](../../.ai/specs/2026-10-28-run-ts-decomposition.md).

Coverage: [run-states.test.ts](../../packages/cezar/src/workflows/run-states.test.ts), [run-active-pin.test.ts](../../packages/cezar/src/workflows/run-active-pin.test.ts), [file-length.test.ts](../../packages/cezar/src/file-length.test.ts), [ast-grep-rules.test.ts](../../packages/cezar/src/ast-grep-rules.test.ts).
