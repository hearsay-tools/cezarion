# Run history recovery

Squawk imports legacy `runs.json` once into `runs.db` and keeps the original
bytes in `runs.json.pre-sqlite.bak`. It does not dual-write. Pre-SQLite Cezarion
releases (builds before [the SQLite migration](https://github.com/hearsay-tools/cezarion/commit/87f50c3065abb85d894fe457570c1777254cbbf7))
read `runs.json` and see only the history at import. Squawk ignores their later
writes to that file. Stop all older Cezarion and Squawk processes for the project
before upgrading.

If an import warning reports skipped or unreadable records, repair `runs.json`
using the saved backup. Stop every Squawk process, move `runs.db`, `runs.db-wal`
and `runs.db-shm` aside, and restart Squawk to import the repaired file. Do not
copy the unrepaired backup over the repaired file. This removes runs created
since the first import from the list; keep the moved database set to export
those runs and merge them back using the steps below. Squawk keeps the repaired
bytes in a separate hashed backup.

## Recovering run history

Every step needs every Squawk process of the project stopped: `serve`, a headless `hsq run`, and anything started with `npx -p @hearsay-tools/squawk hsq`. Run the commands in the project root. Move files, never delete them, until you have checked the result.

The steps below name the project's data folder as `<dir>`. It is `.ai/squawk/` when the project has moved (the cockpit logged the move, or `hsq migrate-project` reported it) or started fresh with no `.ai/cezar` path. It is `.ai/cezar/` before the move. Pre-SQLite Cezarion releases, and any older binary you downgrade to on purpose, read only `.ai/cezar/`. The shell examples set the folder once:

```bash
DIR=.ai/squawk   # or .ai/cezar before the move
```

1. **Back up `runs.db`.** Copy `<dir>/runs.db`, `runs.db-wal` and `runs.db-shm` together (a file that does not exist is fine). After a clean stop the last two are usually gone and `runs.db` alone is complete. A copy of `runs.db` taken while Squawk runs, without its `-wal`, is not a backup.
2. **Restore a backup.** Move the current `runs.db`, `runs.db-wal` and `runs.db-shm` aside, copy the backed-up set into `<dir>`, start Squawk. Never mix a `runs.db` with another copy's `-wal`.
3. **Rebuild from `runs.json.pre-sqlite.bak`**. This returns the project to the history it had at the import and drops every run made since from the list. Their `runs/<id>.*` files stay on disk, and no run lists them.
   1. Move `runs.db`, `runs.db-wal` and `runs.db-shm` aside. If you want the newer runs back later, keep the set and use step 4 on it.
   2. Move `<dir>/runs.json` aside, then copy `<dir>/runs.json.pre-sqlite.bak` to `<dir>/runs.json`. Moving only the database makes the next start import whatever `runs.json` holds, which may be a file a pre-SQLite Cezarion release changed.
   3. Start Squawk. It imports the file once and writes a fresh `runs.db`.
4. **Export `runs.db` as `runs.json`** (read the new history, or hand it to a pre-SQLite Cezarion release). With Node 24.21.0 or newer:

   ```bash
   node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; import { writeFileSync } from 'node:fs'; const db = new DatabaseSync('$DIR/runs.db', { readOnly: true }); const rows = db.prepare('SELECT data FROM runs ORDER BY created_at, id').all(); writeFileSync('runs.export.json', '[' + rows.map((row) => row.data).join(',') + ']'); console.log(rows.length + ' runs')"
   ```

   `runs.export.json` is the same array of `RunRecord` that `runs.json` always was. To downgrade to a pre-SQLite Cezarion release with the new history, move the current `.ai/cezar/runs.json` aside and put the export in its place as `.ai/cezar/runs.json`, then start that release: it reads only `.ai/cezar/`. Leave `runs.db` where it is: pre-SQLite releases do not read it. SQLite-backed Squawk and Squawk releases still read `runs.db`; replacing `runs.json` does not downgrade their database.
5. **Re-upgrade after a downgrade, keeping both histories.** Export as in step 4, then merge by run id. This example keeps the `runs.db` copy when both files hold the same id, so choose the order for your case:

   ```bash
   jq -s 'add | group_by(.id) | map(last)' .ai/cezar/runs.json runs.export.json > runs.merged.json   # .ai/cezar/runs.json: the older release's history
   ```

   Move `<dir>/runs.db`, `runs.db-wal` and `runs.db-shm` aside, put `runs.merged.json` in place as `<dir>/runs.json`, start Squawk. It imports the merged file once. The first backup no longer matches those bytes, so they are saved as `runs.json.pre-sqlite.<hash>.bak` beside it.

## When the run store cannot open

`RunStore.open` never returns an empty store. The cockpit shows the message as the project's 409 `{ error }` and the CLI prints it on stderr (`hsq run` exits 1 and writes nothing). Restarting Squawk is always correct; a lazily opened project also retries on its next request, so a reload is enough once the cause is gone.

| Kind | Cause | What to do |
| --- | --- | --- |
| `corrupt` | `runs.db` is not a SQLite file, or SQLite reports a damaged page | Squawk leaves the three files in place and never modifies the database or its `-wal`. Restore a backup (step 2) or rebuild from `runs.json.pre-sqlite.bak` (step 3), then restart. |
| `busy` | Another Squawk process held the write lock beyond about 3.5 s at boot, or longer than one attempt on a lazy open | Wait for the other process to finish or stop it, then restart. |
| `permission` | The data directory, `runs.db` or the backup cannot be read or written | Give your user read and write access to the project's data folder (`.ai/squawk/` or `.ai/cezar/`), then restart. |
| `disk-full` | No space for `runs.db` or the backup | Free disk space, then restart. |
| `unsupported-schema` | `runs.db` was written by a newer Cezarion or Squawk build | Run a build that supports that schema. An older SQLite-backed build must not write it; export in step 4 does not change its schema. To use an older SQLite-backed build, restore a compatible database backup (step 2), or keep the newer build. Step 4 applies only to pre-SQLite Cezarion downgrades. |
| `legacy-writer` | A live pre-SQLite Cezarion process serves the project, or `runs.json` changed during the import | Stop every pre-SQLite Cezarion process of the project, then restart. Nothing was imported, so the next start imports from the beginning. |
| `other` | Anything else, with SQLite's detail | Restart Squawk to try again. |

A boot project that failed to open skips worktree pruning, scratch cleanup and run recovery for that start, so nothing is mistaken for an orphan; restart Squawk after the fix. When automations are enabled, a project whose run store cannot open launches no automation: a due occurrence waits without counting towards the three-failure auto-pause, and fires once the store opens, within the usual one-day catch-up window. With `HSQ_AUTOMATIONS=0` (`CEZ_AUTOMATIONS` fallback), the scheduler does not start. A headless `hsq run` that cannot open exits 1.
