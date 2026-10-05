# SQLite run store (#779)

Status: implemented on the #779 branch, 2026-10-05. This is the short design record of what shipped. The long form is the [Plan handoff](https://github.com/hearsay-tools/cezarion/issues/779#issuecomment-5983809598) comment on #779, with its Amendment 1 and Amendment 2. The evidence that justified the move is the [benchmark comment](https://github.com/hearsay-tools/cezarion/issues/779#issuecomment-5992577996).

## Problem

`runs.json` was one file holding every run. Each save rewrote all of it and blocked the event loop for as long as that took. At 5,000 runs, one single-run save blocked for about 0.8 to 1.1 s on both fixture profiles, against about 9 ms at 100 runs. Open, the cold read behind ⌘K and a commit grew the same way. Heap after open roughly equalled the file size (115 MB at 5,000 legacy runs). Every cost tracked total history, not the size of the change.

## Decision

Store runs in one `node:sqlite` file per project, `.ai/cezar/runs.db`. Move only after the committed benchmark showed that a save is the largest block that a current client causes. #817 (slim run list) landed first, so the gate compares against `GET /run-summaries`, not `GET /runs`.

SQLite ships inside Node, so the zero-config rule holds: no server, no install, no setting. The price is a higher Node floor: `engines.node` is `>=24.15.0`, the first release where `node:sqlite` is a release candidate (stability 1.2), and CI runs the unit gate on exactly 24.15.0 (`node-floor` job).

## Design

- **Rows.** One row per run: the complete `RunRecord` JSON (`data`), its `toRunSummary()` JSON (`summary`) and a few columns copied from the record for queries (`created_at`, `finished_at`, `status`, `archived`, `live`, `parent_run_id`, `client_request_id`, `group_id`, `worktree_path`, `branch`, `base_branch`, `revision`). The zod `RunRecord` schema is unchanged. `runs/run-database.ts` is the only code that writes SQL and never parses `data`; `runs/run-row.ts` computes columns and the summary.
- **Transactions.** WAL, `synchronous = NORMAL`, 50 ms busy timeout. Every write goes through one `transaction()`: changed rows, deletions and the rows a debounced save still owes commit together or not at all. A failed commit changes neither memory, database nor events; memory installs and events fire only after COMMIT. Optimistic updates keep their immediate-memory, debounced-save semantics.
- **Only live runs in memory.** A run is live when it is queued, running or waiting, held by a `RunManager` (active, parked, monitoring), has a wake timer or `autoResumeAt` pending, or is a parent waiting on workers (`isLiveRecord`, `RunStore.pin`). Finished runs load from their row on demand as fresh copies (deep-frozen under vitest, so an in-place write throws instead of being lost). Open-time recovery, retention and the former whole-map scans are indexed queries.
- **Ownership claims.** `serve` and a headless `cez run` may open one project together. `run_claims` records a delegation family's owner (session UUID, pid, process start identity). A store holds, and writes, only families it claims. Claims are taken before any mutation, recovery, timer or cleanup, released when the family leaves memory or the store closes, and a dead owner's are taken over only once its death is proven (a live pid with another start identity counts as dead; an unverifiable pid does not). Every write is fenced inside its transaction against the row's revision and the claim. A mismatch writes the original, local and current values and the deletion intent to `run_conflicts`, quarantines that row for writes and publishes the corrected view. Foreign live runs stay readable; every control on them answers 409 `{ error }`, except that a run whose owner died is adopted first: its live runs are settled as interrupted, never resumed (only Continue resumes), and the control then applies. There is no `data_version` polling or revision scan: another process's writes reach this one on the next read.
- **Lists.** `GET /run-summaries`, `/workspace/runs-index` and the cold reader read the stored `summary` column and overlay the in-memory live records, because a debounced save keeps memory up to 300 ms ahead of its row.
- **Import.** The first open of a project without a completed import reads `runs.json`, saves its exact bytes to `runs.json.pre-sqlite.bak` (synced, never overwritten; a mismatching existing backup sends the bytes to a hash-named file), and commits every row with the completion marker in one transaction. Two checks run inside the write lock before COMMIT: no live older cockpit holds `cockpit.lock`, and `runs.json` has not changed since it was read. A crash or refusal commits nothing and the next open imports again. A completed import is authoritative; later `runs.json` changes are never imported. A `runs.json` that does not parse imports as an empty history, and its bytes stay in `runs.json` and the backup.
- **Unknown fields.** `runs/raw-record.ts` keeps what the runtime schema drops (a newer cezar's additions), restores it where the parent survives, merges keyed arrays by `id`, and lets known-field changes and deletions apply at any depth. Without extras a write is exactly `JSON.stringify(record)`.
- **Failure policy.** `RunStore.open` throws a typed `RunStoreOpenError` (`corrupt`, `busy`, `permission`, `disk-full`, `unsupported-schema`, `legacy-writer`, `other`) and never returns an empty store. A corrupt database, `-wal` and `-shm` stay in place; a guarded close stops SQLite from checkpointing into a damaged file. Boot retries a busy database for about 3.5 s. A lazily opened project tries once per request and recovers by itself. A boot project that failed to open skips pruning, scratch cleanup and recovery, answers 409 `{ error }` on its project routes, and needs a restart. Nothing treats an unopenable store as "no runs": that reading once deleted live task worktrees.
- **Cold reads.** `readRunIndexFromDisk` opens `runs.db` read-only (no database, directory or migration is created; SQLite may create its `-wal`/`-shm` coordination files), reads the newest rows, and never builds a project context. Before the import it reads `runs.json` as it always did. A database that cannot be read contributes nothing, never the stale `runs.json` beside it.

## Compatibility

Written in `BACKWARD_COMPATIBILITY.md` section 3 (owner sign-off) and summarised here.

- No dual-write. `runs.json` stays for older versions and is never rewritten or deleted. A downgrade sees history as of the import. A re-upgrade never imports divergent legacy writes automatically. Stopped-process backup, restore, export and merge steps are documented.
- Stop older cezar processes before upgrading. A lock-less older writer (`serve` up to 0.15.0, any older `cez run`) that saves nothing during the import window is not detected, and its later writes are never imported.
- HTTP shapes are unchanged. `409 { error }` is new on the controls of a foreign-owned run and on the project routes of a project whose store cannot open.
- New state files: `runs.db`, `runs.db-wal`, `runs.db-shm`, `runs.json.pre-sqlite.bak` and `runs.json.pre-sqlite.*`, all git-ignored by `ensureDataGitignore`. `run_claims` and `run_conflicts` are private.
- No new `CEZ_*` variable.

## Verification

- Import crashes and retries, rollback with dirty work pending, full-field preservation, corruption and each error kind, two-process writes, conflicts, deletions and ownership, cold read parity, connection cleanup.
- Runner recovery behaviour has an exhaustive `RUNNER_IDS` regression (R49 in `harness-parity.test.ts`) over each runner's native mock wire.
- Benchmark: `packages/cezar/scripts/benchmark-run-store.ts`. The acceptance bound for each size and profile is `x_N <= x_100 + max(0.25 * x_100, 1 ms)` for median and p95 single-run save, including checkpoint costs. Contention is reported separately. A final pass reports heap after open, `getRun()` for live and finished records, and `GET /run-summaries`.
- CI: the unit gate runs on exactly Node 24.15.0 beside the `lts/*` jobs.

## Not done

- Browser-visible degraded state for a failed boot store beyond the 409 (⌘K shows no rows for that project).
- Swapping a boot store in place after a transient failure: restart instead.
- Importing divergent legacy writes after a downgrade: manual merge only.
- Streaming another process's live events (as before: they appear on the next read).
