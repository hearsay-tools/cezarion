# Import legacy history once with exact-byte evidence

The move to SQLite must not silently destroy the old run index. Import `runs.json` once,
keep an exact-byte backup, and commit every imported row with the completion marker in one
transaction. Recheck the marker under the write lock so competing imports cannot duplicate it.

## Consequences

A live cockpit lock or a changed input file refuses the import. The final pre-commit check
and synced backup preserve the bytes used. A refused or crashed transaction leaves no completed
import. The old index remains untouched and stops being authoritative after success.

These checks cannot detect an old writer that holds no cockpit lock and writes nothing during
the import. Later writes by that process are not imported. Invalid records are skipped with
evidence retained; an invalid index can produce an empty import, not an erased source file.

Implementation: [legacy-index.ts](../../packages/cezar/src/runs/legacy-index.ts), [store.ts](../../packages/cezar/src/runs/store.ts).

Coverage: [store-import.test.ts](../../packages/cezar/src/runs/store-import.test.ts), [store.test.ts](../../packages/cezar/src/runs/store.test.ts).
