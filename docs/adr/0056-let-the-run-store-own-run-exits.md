# Let the run store own run exits

A run's status changes only by a **run exit**: a named kind of status write that declares the
statuses it may leave from, the status it writes, the fields it settles and whether it commits at
once or on the debounced save. The exit table lives in `runs/`, and `RunStore` applies an exit
through one entry point. Callers name the exit and pass only data the exit cannot know, such as
an error message. `updateRun` takes no `status`.

Before this record, `RUN_EXITS` lived in `workflows/run-states.ts`. Callers wrote the status
through `RunManager.move`, a `transition()` value in a patch, or `transitionVia` around a store
commit. Each caller also chose which fields to clear, and `updateRun` chose durability from the
patch's fields. `record-write-rules.ts` kept one rule list per write path. Four of the five
commits after it was extracted fixed a rule that one path skipped (hearsay-tools/cezarion#2376 to
hearsay-tools/cezarion#2382).

## Consequences

The dependency reverses: `workflows/run-states.ts` keeps the state and trigger catalogue
(`RUN_STATES`, `RUN_TRIGGERS`) and imports the exits from `runs/`. A trigger row names the exit
it takes.

A store commit that writes a status with a precondition (a root with a pending Finish intent, a
held usage-limit resume) is an exit with a named guard. A failed guard writes nothing and returns
false, as the commit's early return did. `transitionVia` and the separate status-writing commits
go away. The store's own load-time status writes and the Draft-PR review accept are exits too, so
the `run-status-write-outside-transition` rule and its baseline go away: the patch type refuses a
status outside an exit.

An undeclared transition behaves the same in tests and in production. The store writes it and
records a violation; production logs a warning, and the test setup fails the test after it ran
(`afterEach`). Nothing throws in the write path, so a test runs the path the app runs. Refusing an
undeclared transition in production is a later decision that needs the warnings as evidence.

Each exit keeps today's durability. An enclosing commit, then a record rule (an exit to `done` with a completion option), can raise a debounced exit to committed; nothing lowers a committed one. A plain Finish stays on the debounced save so a locked
database cannot stop cleanup; Done with a completion option, handoff records and the archive
options commit at once. The record rules run as one ordered pipeline on both saves. A rule that
differs between them on purpose is a named difference in that pipeline, not a separate list.

ADR 0005 (publish after commit), ADR 0006 (fence inside the write transaction), ADR 0007 (keep
unknown fields) and ADR 0021 (outcomes commit with what they depend on) still hold. ADR 0053
still holds: `RunManager` stays the facade and its modules call the store's exit entry point
through their context.

Implementation: [run-states.ts](../../packages/cezar/src/workflows/run-states.ts),
[store.ts](../../packages/cezar/src/runs/store.ts),
[record-write-rules.ts](../../packages/cezar/src/runs/record-write-rules.ts),
[2026-11-03-run-store-owns-exits.md](../../.ai/specs/2026-11-03-run-store-owns-exits.md).

Coverage: [run-states.test.ts](../../packages/cezar/src/workflows/run-states.test.ts),
[store.test.ts](../../packages/cezar/src/runs/store.test.ts).
