# Fence writes by run-family ownership

A cockpit and a headless run can open the same project. Only the store that claims a run
family may write its rows, transcripts or cleanup state. Claims identify the store session,
process incarnation and acquisition generation. Unknown liveness blocks takeover; only a
proven dead owner can be replaced.

## Consequences

Each transaction checks row revisions and claim generations. An unexpected conflict first
saves original, proposed and current evidence, then quarantines the affected writer until
restart. Failure to save evidence leaves the pending write for another attempt.

Read routes remain available for foreign runs. Controls refuse a live foreign owner. A control
can adopt a dead family and settle its live rows without launching agents. Continue can then
start work. This differs from startup recovery, which can resume interrupted work.

Implementation: [run-claims.ts](../../packages/cezar/src/runs/run-claims.ts), [store.ts](../../packages/cezar/src/runs/store.ts), [server.ts](../../packages/cezar/src/server/server.ts).

Coverage: [run-claims.test.ts](../../packages/cezar/src/runs/run-claims.test.ts), [run-ownership-controls.test.ts](../../packages/cezar/src/server/run-ownership-controls.test.ts).
