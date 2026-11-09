# Runs store and state persistence

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/runs/store.ts`

## Two project directories before P5

`project-paths.ts` supplies ordered read roots: `.ai/cezar/`, then `.ai/squawk/`.
Writes stay in `.ai/cezar/`, in both release-switch states. Run IDs form a union;
the legacy record wins a duplicate. History, artifacts, handoffs, transcript facts,
worker results and cleanup proofs follow that record's source. Never select each
sidecar independently. Cold indexes use the same selection without opening a manager.

Fallback SQLite opens read-only. It never migrates schemas, imports `runs.json`,
recovers runs or changes records. Normal WAL coordination may create or update
`runs.db-wal` and `runs.db-shm`; these SQLite sidecars are the sole fallback-write
exception. An unknown/newer schema or a locked/unreadable fallback source produces
one warning and no fallback runs. It does not fail boot. A damaged legacy database
keeps its existing failure contract; fallback cannot conceal it.

When only fallback runs exist, the legacy connection stays in memory. Reads,
report-cache backfill and boot create no empty legacy `runs.db`. An explicit
family write preserves only that family's records and sidecars in the existing
primary transaction after ownership checks. It leaves fallback records and
evidence unchanged. No boot copy, whole-tree copy, move or symlink occurs.

| Operation | Fallback or duplicate item |
| --- | --- |
| Read a run ID | Legacy record first; all evidence follows its source |
| Explicit write to a family | Preserve missing family records/evidence under legacy; keep ownership fences |
| Explicit logical delete of run, workflow or automation | Refuse whenever its ID/name also exists under `.ai/squawk/`, even if legacy wins |
| Refusal message | Name the `.ai/squawk/` path; tell the user to use the binary that migrated the project |
| Automatic record retention | Skip fallback and duplicate IDs; report one count per sweep |
| Automatic worktree/orphan cleanup | Skip fallback-only resources; report one count per sweep |
| Writes in a fallback worktree | Refuse agent launch/Continue, setup, preview commands and Git writes; autosave/cleanup skip with a count; diff, files and result collection remain readable |
| Byte cleanup of a legacy-only resource | Existing ownership and cleanup rules still apply |
| Legacy-only project | Existing reads, writes, imports, recovery and deletion |

No tombstone or new setting is added. Legacy-directory notices start only with
the release switch. Project migration and path rewriting belong to P4b/P5.

## Rules

One embedded SQLite file per project, `.ai/cezar/runs.db` (`node:sqlite`, WAL; Node 24.21.0 is the floor, verified by build/package CI), plus one append-only NDJSON event file per run.

**Read first, in this order: `runs/run-database.ts` (SQL boundary: schema, `transaction()`, claims, fenced writes) and its query modules (`runs/report-rows.ts` prepares the report-cache statements), `runs/run-row.ts` (record to row: columns, summary, `isLiveRecord`), `runs/raw-record.ts` (keeps unknown fields across a write), `runs/legacy-waits.ts` (upgrade-on-read of older wait fields), `runs/worker-resource-holders.ts` (generation-gone proof for worker paths), `runs/claim-families.ts` (family-claim take and busy retry), `runs/worker-result-commit.ts` (worker-result snapshot publish and parent pointer), `runs/owned-run-create.ts` (owned worker run and parent receipt), `runs/archive-family.ts` (family archive eligibility), `runs/store.ts` (`RunStore`, import, open), then `runs/run-index.ts` (read-only cold reader), `runs/legacy-index.ts` and `runs/store-open-error.ts`.** Each row holds the complete `RunRecord` JSON plus a stored `toRunSummary()` column and the few columns the store queries; `RunRecord` stays a zod schema, so new fields must still be optional or defaulted and rows written by an older cezar still parse.

**Only the live set is in memory**: queued, running and waiting runs, runs a `RunManager` holds, pending wake timers and parents waiting on workers (`isLiveRecord`, plus `pin`). Finished runs load from the row on demand as fresh copies (frozen under vitest), so never keep or mutate one, and never rebuild a full scan of `runs`: add an indexed column. A delegation family is held, claimed and released as one unit (`run_claims`: session UUID, pid and start identity, checked inside the write transaction), so two processes on one project never both write a run. A foreign live run is readable and every control answers 409 `{ error }` (`requireRunControl`); `run_claims` and `run_conflicts` are private. `runs.json` is imported once on first open into `runs.db` (exact bytes kept in `runs.json.pre-sqlite.bak`, completion marker in the same transaction), never written again and never deleted; there is no dual-write, so an older cezar sees only history up to the import.

**A store that cannot open never reads as empty**: `RunStore.open` throws a typed `RunStoreOpenError` (`corrupt`, `busy`, `permission`, `disk-full`, `unsupported-schema`, `legacy-writer`, `other`), a damaged file is left byte-for-byte alone, and `serve` answers 409 `{ error }` for that project's routes instead of treating it as no runs. Recovery steps live in [run history recovery](../run-history-recovery.md). Cold readers (`readRunIndexFromDisk`) open `runs.db` read-only and never build a context. Spec: `.ai/specs/2026-10-05-sqlite-run-store.md`. A **queued** run's prompt stays editable until the scheduler picks it up (open-mercato/cezar#472): `task` plus the optional `queuedMessages` stack are folded into `{{task}}` at dequeue, and that fold is read-only — never write it back to the record. The store is also the in-process event bus for SSE.

## Published report cache

Schema 10 adds `artifacts`, an HTML-only cache of owned snapshot metadata. Files remain the
source of truth. The server starts backfill after listening; lazy project contexts start it
behind the running listener. `reports-backfill-complete` in `meta` records a completed pass;
an indeterminate scan leaves it absent for retry.
Run-row transactions mark `reports-dirty:<runId>` when a row is or was live. Reconciliation
clears a marker only when its numeric revision is no newer than the directory read. Shelf queries reconcile
live and dirty runs; legacy non-UUID task IDs cannot own artifacts, so reconciliation skips
them and removes their impossible retry markers; a transition from a live to a terminal status reconciles the settled run
and dirty runs. Read, pin and archive events on terminal runs do not start reconciliation.
Listing pages through joined summaries, checks content only for the selected page and fills
past missing files. Backfill selects task IDs from the database, then uses the same bounded per-task scan as
reconciliation. The index has no filesystem imports or walks. Store-side helpers share
`entries`, `readEntry`, every artifact byte/count cap, and the artifact reader’s anchored
no-follow storage access. Any cap overflow retains the whole run cache and dirty marker. The shared artifact root helper canonicalizes only the trusted data
root, once per index after listen or on the first query. Failed resolution remains retryable.
Redirected storage retains cache rows and retry markers. Indeterminate page checks keep cached
rows in the page, so cursors never hide them; the reader handles open failures. A separate joined-summary pass counts all readable matching source summaries
without full-record or filesystem reads. That total is independent of the cursor; missing content
dropped during page filling can lower it on the next request. Indeterminate filesystem reads retain cached snapshots and a durable dirty
marker; unreadable summaries skip rows without deleting them, so repair restores their display.
History deletion removes cache rows and dirty markers with the run row.
Deleting `runs.db` removes task ownership too: artifact bytes survive, but orphan snapshots
stay outside the shelf until their source tasks are restored. Dropping the cache table alone
is unsupported; removing the completed-backfill marker lets the next pass rebuild cache rows.

Visible report shelves also demand a report-index watch. Local live events schedule
one run scan, at most once per second. A 5 s tick retries dirty runs and checks
quiet live runs. It does not scan clean settled history. The index's process-local
epoch and content/metadata counters support project-scoped shelf reconciliation;
no new durable state is required. `list()` retains its live/dirty reconciliation,
selected-page checks and retry/revision fences. Without shelf demand, startup
backfill and live-to-terminal reconciliation still run. A shelf closing before a
pending terminal scan does not cancel that reconciliation.
