# Run history recovery

Cezar imports `runs.json` once into `runs.db` and keeps the original bytes in
`runs.json.pre-sqlite.bak`. It does not dual-write: an older Cezar sees the
history at import, and newer Cezar ignores later writes to `runs.json`. Stop
all older Cezar processes for the project before upgrading.

If an import warning reports skipped or unreadable records, repair `runs.json`
using the saved backup. Stop every Cezar process, move `runs.db`, `runs.db-wal`
and `runs.db-shm` aside, and restart Cezar to import the repaired file. Do not
copy the unrepaired backup over the repaired file. This removes runs created
since the first import from the list; keep the moved database set to export
those runs and merge them back using the steps below. Cezar keeps the repaired
bytes in a separate hashed backup.

## Recovering run history

Every step needs every cezar process of the project stopped: `serve`, a headless `cez run`, and anything started with `npx cezarion`. Run the commands in the project root. Move files, never delete them, until you have checked the result.

1. **Back up `runs.db`.** Copy `.ai/cezar/runs.db`, `runs.db-wal` and `runs.db-shm` together (a file that does not exist is fine). After a clean stop the last two are usually gone and `runs.db` alone is complete. A copy of `runs.db` taken while cezar runs, without its `-wal`, is not a backup.
2. **Restore a backup.** Move the current `runs.db`, `runs.db-wal` and `runs.db-shm` aside, copy the backed-up set into `.ai/cezar/`, start cezar. Never mix a `runs.db` with another copy's `-wal`.
3. **Rebuild from `runs.json.pre-sqlite.bak`**. This returns the project to the history it had at the import and drops every run made since from the list. Their `runs/<id>.*` files stay on disk, and no run lists them.
   1. Move `runs.db`, `runs.db-wal` and `runs.db-shm` aside. If you want the newer runs back later, keep the set and use step 4 on it.
   2. Move `.ai/cezar/runs.json` aside, then copy `.ai/cezar/runs.json.pre-sqlite.bak` to `.ai/cezar/runs.json`. Moving only the database makes the next start import whatever `runs.json` holds, which may be a file an older cezar changed.
   3. Start cezar. It imports the file once and writes a fresh `runs.db`.
4. **Export `runs.db` as `runs.json`** (read the new history, or hand it to an older cezar). With Node 24.21.0 or newer:

   ```bash
   node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; import { writeFileSync } from 'node:fs'; const db = new DatabaseSync('.ai/cezar/runs.db', { readOnly: true }); const rows = db.prepare('SELECT data FROM runs ORDER BY created_at, id').all(); writeFileSync('runs.export.json', '[' + rows.map((row) => row.data).join(',') + ']'); console.log(rows.length + ' runs')"
   ```

   `runs.export.json` is the same array of `RunRecord` that `runs.json` always was. To downgrade with the new history, move the current `runs.json` aside and put the export in its place as `.ai/cezar/runs.json`, then start the older cezar. Leave `runs.db` where it is: the older cezar does not read it.
5. **Re-upgrade after a downgrade, keeping both histories.** Export as in step 4, then merge by run id. This example keeps the `runs.db` copy when both files hold the same id, so choose the order for your case:

   ```bash
   jq -s 'add | group_by(.id) | map(last)' .ai/cezar/runs.json runs.export.json > runs.merged.json
   ```

   Move `runs.db`, `runs.db-wal` and `runs.db-shm` aside, put `runs.merged.json` in place as `.ai/cezar/runs.json`, start cezar. It imports the merged file once. The first backup no longer matches those bytes, so they are saved as `runs.json.pre-sqlite.<hash>.bak` beside it.

## When the run store cannot open

`RunStore.open` never returns an empty store. The cockpit shows the message as the project's 409 `{ error }` and the CLI prints it on stderr (`cez run` exits 1 and writes nothing). Restarting cezar is always correct; a lazily opened project also retries on its next request, so a reload is enough once the cause is gone.

| Kind | Cause | What to do |
| --- | --- | --- |
| `corrupt` | `runs.db` is not a SQLite file, or SQLite reports a damaged page | cezar leaves the three files in place and never modifies the database or its `-wal`. Restore a backup (step 2) or rebuild from `runs.json.pre-sqlite.bak` (step 3), then restart. |
| `busy` | Another cezar process held the write lock beyond about 3.5 s at boot, or longer than one attempt on a lazy open | Wait for the other process to finish or stop it, then restart. |
| `permission` | The data directory, `runs.db` or the backup cannot be read or written | Give your user read and write access to `.ai/cezar/`, then restart. |
| `disk-full` | No space for `runs.db` or the backup | Free disk space, then restart. |
| `unsupported-schema` | `runs.db` was written by a newer cezar | Upgrade cezar. An older cezar must not write that file; step 4 exports it for a downgrade. |
| `legacy-writer` | A live older cezar serves the project, or `runs.json` changed during the import | Stop every older cezar process of the project, then restart. Nothing was imported, so the next start imports from the beginning. |
| `other` | Anything else, with SQLite's detail | Restart cezar to try again. |

A boot project that failed to open skips worktree pruning, scratch cleanup and run recovery for that start, so nothing is mistaken for an orphan; restart cezar after the fix. With `CEZ_AUTOMATIONS=1`, a project whose run store cannot open launches no automation: a due occurrence waits without counting towards the three-failure auto-pause, and fires once the store opens, within the usual one-day catch-up window. A headless `cez run` that cannot open exits 1.
