# Store runs as transactional SQLite rows

Each project keeps run history in embedded synchronous SQLite. A row holds complete record
JSON, its summary, and indexed query columns. The database layer treats JSON as opaque; the
run codec computes the record projection and columns together. Lists can read summaries
without decoding every record.

## Consequences

The store holds live, pinned, related and unsettled records in memory. Other reads return
fresh records. Optimistic writes can debounce. Durable writes include earlier pending dirty
rows in the same transaction and publish memory changes and events only after commit.

Forward-only migrations maintain persisted predicates such as `live`; changing a predicate
requires recomputing stored rows. Database failures leave files in place and return typed
errors. Cezar does not delete or truncate a damaged database to make startup succeed.

## Considered Options

- **Debounced whole-file run JSON.** Replaced by per-row transactions to make multi-record durability explicit and avoid whole-history rewrites.

Implementation: [run-database.ts](../../packages/cezar/src/runs/run-database.ts), [run-row.ts](../../packages/cezar/src/runs/run-row.ts), [store.ts](../../packages/cezar/src/runs/store.ts).

Coverage: [run-database.test.ts](../../packages/cezar/src/runs/run-database.test.ts), [store-live-set.test.ts](../../packages/cezar/src/runs/store-live-set.test.ts).
