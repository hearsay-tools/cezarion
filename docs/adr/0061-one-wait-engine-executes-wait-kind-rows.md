# One wait engine executes the wait-kind rows

Each stored wait kind (`pr`, `timer`, `process`, `human`, `worker`, `peer`, `subagent`) has one
row in a **wait-kind table**. A row states the kind's rules: its deadline rule, whether it keeps
the run's slot, whether its wake costs budget, whether the agent can cancel it, whether
`timers_disabled` refuses it, its `cezar_wait` answer kind, its duplicate check, how its entry is
built, what watches it, its default result and its text. The table type requires a row for every
kind, so a new kind fails typecheck until its row exists.

One **wait engine** executes the rows. It opens a wait: it compares the open-wait limit through
one function, withdraws Cezar's human waits, commits, arms and parks. Each registration path keeps
the steps it runs today, their order and its failure policy: the open operation reads the arm,
the park guard and the returned entry from the row, and the path chooses the rest.
The engine resolves a wait (budget check, commit with its input, queue the wake),
re-arms it after a restart, refreshes a changed open wait (commit, then re-arm), cancels it (commit, then disarm every watch kind) and forgets a
deleted run's watches. In `packages/cezar`, only the engine, the table, the watch adapters, the
read-time upgrade of old rows and the boundary views branch on a wait's kind; other code asks the
engine.

Before this record, each kind's rules were spread over the files that use them. A new kind
touched 8 to 22 files, counting neither tests, testkits nor fixtures
(hearsay-tools/cezarion#1522, hearsay-tools/cezarion#2033, hearsay-tools/cezarion#2449). The
open-wait limit was compared at nine sites with four refusal shapes. Eleven sites wrote a
`cancelled` outcome under five disarm policies. `WAIT_KINDS` in `workflows/run-states.ts` already
listed some rules per kind, but nothing executed it.

## Consequences

`workflows/run-states.ts` imports the table, as it imports the run exits, and keeps its state and
trigger catalogue. The engine is a module behind `RunManager` under ADR 0053: it never imports
`run.ts`, it calls back through a host, and the facade keeps the methods that tests spy on. Wake
admission and the wake-budget ledger stay outside the engine and call it.

The run store checks wait-phase transitions with the ADR 0056 rule. `WAIT_PHASES` is the
declared set. An undeclared transition is written and recorded as a violation: production logs
a warning, and the test setup fails the test. Nothing throws in the write path.

The contract package keeps the wire schemas and the attention facts: it stays Node-free and
shares no code with the table. The web package does not change. The CLI keeps the legacy
`WorkerWait` answer shape as a boundary view (`BACKWARD_COMPATIBILITY.md`). Every refusal code and
message stays as it was. One P4 slice changes one refusal, in its own pull request.

A provider-error or usage-limit hold is a run state, not a wait-kind row
(hearsay-tools/squawk#3337). A held worker is `waiting`, so its parent's worker wait stays open
until the worker retries to an end or its hold is withdrawn; a held parent keeps its own waits,
and a wait that resolves during the hold is delivered by the retry.

ADR 0021 still holds: waits are durable, an outcome commits with what it depends on, and
`RunManager` owns waits at its public surface. ADR 0053 and ADR 0056 still hold.

Implementation: [2026-11-09-wait-kind-table-and-engine.md](../../.ai/specs/2026-11-09-wait-kind-table-and-engine.md),
`packages/cezar/src/workflows/run/wait-kinds.ts` and `packages/cezar/src/workflows/run/wait-engine.ts`
(created by the spec's slices; hearsay-tools/cezarion#3153 merged the resolve and cancel classes into the engine), [run-states.ts](../../packages/cezar/src/workflows/run-states.ts),
[wait-registration-write.ts](../../packages/cezar/src/runs/wait-registration-write.ts).

Coverage: [run-states.test.ts](../../packages/cezar/src/workflows/run-states.test.ts),
[waits-store.test.ts](../../packages/cezar/src/runs/waits-store.test.ts),
[waits.test.ts](../../packages/cezar/src/workflows/waits.test.ts), and the wait parity cells
([waits-parity-cells.testkit.ts](../../packages/cezar/src/workflows/waits-parity-cells.testkit.ts) registers
the `waits-parity-<part>-cells.testkit.ts` module of each part).
