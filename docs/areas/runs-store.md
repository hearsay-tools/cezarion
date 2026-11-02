# Runs store and state persistence

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/runs/store.ts`

## Rules

One embedded SQLite file per project, `.ai/cezar/runs.db` (`node:sqlite`, WAL; Node 24.21.0 is the floor, verified by build/package CI), plus one append-only NDJSON event file per run.

**Read first, in this order: `runs/run-database.ts` (SQL boundary: schema, `transaction()`, claims, fenced writes) and its query modules (`runs/report-rows.ts` prepares the report-cache statements), `runs/run-row.ts` (record to row: columns, summary, `isLiveRecord`), `runs/raw-record.ts` (keeps unknown fields across a write), `runs/store.ts` (`RunStore`, import, open), then `runs/run-index.ts` (read-only cold reader), `runs/legacy-index.ts` and `runs/store-open-error.ts`.** Each row holds the complete `RunRecord` JSON plus a stored `toRunSummary()` column and the few columns the store queries; `RunRecord` stays a zod schema, so new fields must still be optional or defaulted and rows written by an older cezar still parse.

**Only the live set is in memory**: queued, running and waiting runs, runs a `RunManager` holds, pending wake timers and parents waiting on workers (`isLiveRecord`, plus `pin`). Finished runs load from the row on demand as fresh copies (frozen under vitest), so never keep or mutate one, and never rebuild a full scan of `runs`: add an indexed column. A delegation family is held, claimed and released as one unit (`run_claims`: session UUID, pid and start identity, checked inside the write transaction), so two processes on one project never both write a run. A foreign live run is readable and every control answers 409 `{ error }` (`requireRunControl`); `run_claims` and `run_conflicts` are private. `runs.json` is imported once on first open into `runs.db` (exact bytes kept in `runs.json.pre-sqlite.bak`, completion marker in the same transaction), never written again and never deleted; there is no dual-write, so an older cezar sees only history up to the import.

**A store that cannot open never reads as empty**: `RunStore.open` throws a typed `RunStoreOpenError` (`corrupt`, `busy`, `permission`, `disk-full`, `unsupported-schema`, `legacy-writer`, `other`), a damaged file is left byte-for-byte alone, and `serve` answers 409 `{ error }` for that project's routes instead of treating it as no runs. Recovery steps live in [run history recovery](../run-history-recovery.md). Cold readers (`readRunIndexFromDisk`) open `runs.db` read-only and never build a context. Spec: `.ai/specs/2026-10-05-sqlite-run-store.md`. A **queued** run's prompt stays editable until the scheduler picks it up (open-mercato/cezar#472): `task` plus the optional `queuedMessages` stack are folded into `{{task}}` at dequeue, and that fold is read-only — never write it back to the record. The store is also the in-process event bus for SSE.

## Published report cache

Schema 10 adds `artifacts`, an HTML-only cache of owned snapshot metadata. Files remain the
source of truth. The server starts backfill after listening; lazy project contexts start it
behind the running listener. `reports-backfill-complete` in `meta` records a completed pass.
Run-row transactions mark `reports-dirty:<runId>` when a row is or was live. Reconciliation
clears a marker only when its revision still matches the directory read. Shelf queries reconcile
live and dirty runs; a transition from a live to a terminal status reconciles the settled run
and dirty runs. Read, pin and archive events on terminal runs do not start reconciliation.
Listing pages through joined summaries, checks content only for the selected page and fills
past missing files. History deletion removes cache rows and dirty markers with the run row.
Deleting `runs.db` removes task ownership too: artifact bytes survive, but orphan snapshots
stay outside the shelf until their source tasks are restored. Dropping the cache table alone
is unsupported; removing the completed-backfill marker lets the next pass rebuild cache rows.
