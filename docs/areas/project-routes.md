# Project-scoped routes and contexts

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/server/project-context.ts`, then `packages/cezar/src/server/server.ts`, `packages/web/src/routes.tsx`

## Two project directories

`projectPaths(root)` is the one rule for the write root; no caller picks a folder itself.
With `REBRAND_SWITCH` on, a moved project (a completed migration wrote
the marker `<git common dir>/cezar-moved-projects/<sha256 of the real root>.json` names the project's real root; `projectMovedMarker`) writes `.ai/squawk/` and reads `.ai/cezar/`
as its fallback (hearsay-tools/cezarion#3150). A fresh project with no `.ai/cezar` path
also writes `.ai/squawk/` from its first use; preparation records its Git marker. An
existing empty, tracked-only or unreadable legacy path keeps the normal P4 rules.
Every other project, and every project with
the switch off, writes `.ai/cezar/` and reads `.ai/squawk/` as its fallback. "Fallback"
below means `projectPaths(root).reads[1]`; `fallbackProjectWriteError` and
`isFallbackProjectPath` ask `projectPaths` too. Context `dataDir` is the write root.
With the switch on, a stored checkout under an absent old project root is not read-only fallback
state. Continue and restart recovery keep the missing-checkout fallback to the current
repository. A missing checkout under an existing project root still obeys the fallback
write guard, including after migration.
`RunStore` and cold indexes merge the read roots internally. History, artifacts, handoffs,
attachments and cleanup checks use `store.sourceDataDir(runId)`. Inspect fallback
cockpit ownership before claiming legacy state; never reclaim a fallback claim.
Maintenance can read fallback history without recovery or a shadow legacy database.

## Project migration fence

A project migration runs offline (hearsay-tools/cezarion#3089): it refuses while a cockpit it
can see serves the project or a task of it is live. The fence and the journal stop only a
binary that knows them; an older binary checks neither. One claim file, `<root>/.ai/squawk-migration.lock`,
fences the project during the move (hearsay-tools/cezarion#3087). It sits beside both
directory names, so a directory move never carries it and never creates a second owner. It
uses the `CockpitOwnership` claim protocol: exclusive link-create, the `.reclaim` guard, pid
plus start-token liveness and token-checked release.

- **Who claims.** `CockpitOwnership.fenceProject(dataDir, { liveTasks })`, called by the
  offline migration and by early recovery, never by a cockpit for a project it serves. It
  first owns `cockpit.lock` (taken in whichever project directory exists, so a resume after
  the move never recreates the old name), so no cockpit boots on or builds the project, then
  claims the fence, so no other process that checks admission is admitted. A competing CLI meets the held fence and
  fails at once. Right after the claim, `liveTasks` runs as the holder; every caller passes
  the tasks of families another live process claims (`projectForeignTasksOffline`). Any such
  task releases the fence and throws `ProjectMigrationBusyError` with each task's id, title and
  state and the next step (finish or cancel each one).
- **Anything live.** Before it claims, `migrateProjectOffline` refuses with
  `ProjectInUseError` while a cockpit serves the project (`project-migration/live.ts`): the
  `cockpit.lock` owner in either directory (any home, with its URL), and every live cockpit
  of the user's legacy and split homes whose registry lists the project (the presence leases of
  `home/leases.ts`: pid, port, instance), which covers a cockpit that does not own the project
  but runs its automations (hearsay-tools/cezarion#3136). That first refusal lists live
  tasks too, so the user can stop everything before retrying. Live tasks are
  `projectLiveTasks` over a read-only view (`readLiveTaskView`: each run store read quiescent,
  from a private copy when it has a WAL file, and a `runs.json` no store imported yet read as
  JSON), so a refusal writes nothing; a task marked live whose record cannot be read refuses too:
  every non-terminal task (`isLiveRecord`: queued, running,
  waiting on a human, a usage-limit auto-resume, a timer, a PR or a worker) persisted as live
  in either directory, plus the runs of families another live store claims in `run_claims` (a
  headless `cez run`, another binary), read from both physical claim tables so a stale legacy
  claim never hides a live fallback one. An agent process belongs to a live task. Only the
  claimed families and a cockpit refuse a move; every other task that is not archived keeps its
  own items in place (**Leftover tasks** below). Not seen: a
  cockpit of another home that lists the project but never opened it. The user stops it; during
  the move, admission and the write backstop refuse its project entries and its store and
  listed state writes.
- **Admission.** `projectAdmissionRefusal(dataDir)`: two `lstat` calls when dormant,
  nothing written. It refuses a live fence, an unreadable lock (the message names the file
  and when it is safe to remove it) and an existing journal `.ai/squawk-migration.json`. A
  dead owner without a journal admits; the next fence claim reclaims the file. Only the fence
  holder's own work, run inside `asFenceHolder`, passes its fence: the engine and the
  holder's live-task check. Everything else in that process is refused too, so a cockpit
  that recovers a journal still refuses its own other requests for the project meanwhile.
  `withProjectAdmission(dataDir, work, refused)` is the check at each entry: every project
  route (409), finite run-event reads, lazy context builds, maintenance
  (`withMaintenanceStore`), archive-on-merge and completion actions (`withStore`), the
  preview leftover sweep. Point checks: `acquire` (before `mkdir` and after its claim),
  built contexts, warm-up, `AutomationCoordinator.store` and `refresh`, runs index and
  search, the activity snapshot, socket upgrades and live feeds, `RunManager.startRun` and
  `continueRun`, the artifact writer before each write. CLI points are in
  [the CLI area](cli.md#project-migration-fence).
- **Write backstop.** Under every store write, claim and save, `projectWriteRefused` refuses
  while a fence or journal holds the project, outside the holder's own work. It stops the
  writes of a process the offline check cannot see (a cockpit of another home that lists the
  project, its automation store open). A refused save is skipped and its rows stay dirty
  until the fence ends; a refused claim leaves the family unclaimed; a durable commit writes
  nothing and throws, as on a closed store. The same check guards the automation store:
  definition and state writes throw before memory changes; receipts, logs and compaction
  skip; no lock directory is recreated. It also guards the artifact writer (cleanup in
  `finally` included), the data `.gitignore` and the voice log (skipped), and config
  updates, project ui-state and the launch key (they throw, nothing written). Each fence
  logs its first skipped write once. Read-only paths skip while fenced: health answers the
  last config it read (`healthConfig`), the activity publisher stops its foreign-claim
  check. An automation fire that meets a refused state write is a skip, not a failure.
- **Journal.** The journal blocks admission whether its owner lives or not; only the
  fence holder's work passes. The engine removes it as its last step; the caller then calls
  `release()`. Early recovery runs in front of admission
  ([below](#project-migration-command-and-early-recovery)).
- **No online move.** A cockpit never migrates a project it serves. P4b1 drained a serving
  cockpit's work in flight under the fence (admission leases, `holdProjectWork`, a 60 s
  bounded drain, preview and report settling, deferred automation starts); P4b3 removed all of
  it, with hearsay-tools/cezarion#3142, which only that machinery could reach.

## Project state migration engine

`packages/cezar/src/project-migration/` (P4b2, hearsay-tools/cezarion#3088) moves a
project's runtime state from `.ai/cezar/` to `.ai/squawk/`. P4b3 wires `migrateProject`
into the offline `migrate-project` (registered with the release switch on) and `resumeProjectMigration` into
every project entry ([below](#project-migration-command-and-early-recovery)).

- **Fence.** It runs only under a fence its own process holds (`holdsProjectFence`), and
  all its work runs inside `asFenceHolder`, so its writes pass admission and the backstop
  only as the holder's.
- **Plan and dry run.** `planProjectMigration(repoRoot)` writes nothing: the run store is
  read immutable when it has no WAL file, and from a private copy when it has one, so no
  SQLite sidecar appears or changes. It lists every
  move, tracked file with its quoted `git mv`, worktree repair, path rewrite, destination
  conflict and blocker, and the paths left alone on purpose (`NOT_REWRITTEN`).
  `describeProjectMigrationPlan` prints it. Any conflict or blocker refuses the migration
  before the journal exists.
- **Move units.** Each top-level entry of `.ai/cezar/` except the `cockpit.lock*` claims. A
  directory that holds tracked files is entered; tracked files never move. A directory
  that already exists under `.ai/squawk/` is merged item by item; any other existing
  destination is a conflict. A Git worktree is one unit. No move passes through a
  component that is not a real directory (a symlink, a file): the plan reports it as a
  conflict, and the move step checks every source and destination component again before
  each rename. Paths Git prints are read in the platform's form (`gitReportedPath`).
- **Journal.** `.ai/squawk-migration.json` holds the whole plan and the steps done. Steps:
  1. `lock-worktrees`: `git worktree lock` with the reason `cezar project migration <id>` on
     each worktree the move carries; a lock the user set stays.
  2. `move`: rename each item.
  3. `repair-worktrees`: `git worktree repair`, a check that Git lists each new path, then
     `git worktree unlock` of the worktrees this migration locked.
  4. `receipts`: `workspace.path` of each receipt and `.cleanup.json` under
     `gitCommonDir(root)/cezar-owned-workspaces` that names a moved worktree.
  5. `run-store`: one `RunDatabase.transaction` for every affected row (record fields, the
     summary's `worktreePath`, the `worktree_path` column).
  6. `run-files`: worker execution, autosave cleanup, worker results, artifact metadata and
     the seeded `**Worktree:**` line of each handoff.
  7. `mark-moved`: write the marker `<git common dir>/cezar-moved-projects/<sha256 of the real root>.json`, naming the root (private,
     settled before the journal goes). A commit, clone or pull cannot write inside the Git
     directory, so a repository cannot ship or forge it; a linked checkout registered as its own
     project has its own key. The plan refuses when `.git` does not lead to the directory Git
     reports, so the reader (no Git call) and the writer agree. From then on, with the switch on, the project writes `.ai/squawk/`.

  Steps 1 to 3 run inside one hold of the common directory's worktree mutation lock. The
  Git locks keep a `git worktree prune` from any checkout sharing the Git directory from
  deleting a registration whose old path is gone, also after a crash between the move and
  the repair. Each item is applied only while it holds its old value and skipped when it
  holds the new one, so a resume after a crash between an effect and its mark changes
  nothing twice. A value that is neither stops the step; the journal stays and admission
  stays blocked.
- **Untrusted journal.** A journal read back for a resume is untrusted input: a repository can
  commit one. Before any step, `assertJournalContained` (`project-migration/containment.ts`)
  refuses a journal whose `source` and `destination` are not exactly `<root>/.ai/cezar` and
  `<root>/.ai/squawk`; a file it rewrites in place (each rewritten JSON file, each receipt, the
  run store `runs.db` with its `-wal` and `-shm` in either directory) that is not a regular file,
  a symlink included; a move or worktree that does not go from inside `source` to the same place
  inside `destination`; a receipt or cleanup checkpoint outside `<git common dir>/cezar-owned-workspaces/`;
  another rewritten file outside `<destination>/runs/`; a rewritten value that does not move a path
  of this root's `.ai/cezar` to the same place under `.ai/squawk`; a tracked-file entry that is not a
  relative `.ai/cezar/...` path; any existing directory on the way that resolves elsewhere (a
  symlink out); and, before it is read, a journal file that is a symlink, not a regular file,
  larger than 64 MiB or tracked by Git, or whose Git check cannot finish (one `git ls-files` call
  at the journal's canonical path, only when a journal exists; the
  shared excludes keep a real journal out of every ordinary add). A fresh plan passes the same
  check before its journal is written. Each step checks its write target again right before it
  writes, and opens or rewrites in place only a regular file. A refused journal changes nothing and stays for inspection; recovery reports it as a
  recovery failure (boot ends, CLI exit 1, 409), and admission keeps refusing the project.
- **Durability invariant.** One rule, enforced by `settle` in `project-migration/durable.ts`
  and stated there: (a) after every effect on an entry (created, renamed in or out,
  rewritten or removed, by the engine or by Git or SQLite for it), the entry's data when it
  is a written file, then every directory from its root (`.ai`, the Git admin directory, the
  receipt directory, the worktree) down to its parent are fsynced, on the first run and on
  every resume, whether the effect happened now or before a crash; (b) each step settles an
  effect right after it and before anything that depends on it: the next item, a worktree
  unlock (the repaired links settle first), the step's done mark, the journal's removal.
  The journal itself is written and removed the same way. One ordering test walks every
  fault point, on the first run and on a resume from each, and checks (a) and (b).
- **Permissions and tracked state.** New destination parents take the permission bits of
  their source counterparts (private when none), and an existing destination directory
  broader than its source is a conflict, so no move exposes private data. Git-tracked run
  state (`runs.db*`, `runs.json`, `runs/`) blocks the plan.
- **After a migration** `.ai/cezar/` keeps only tracked files (until the user runs the
  printed `git mv`) and the `cockpit.lock*` claims. It holds no `runs.db`, so P4a's reads
  find every run, artifact and handoff under `.ai/squawk/`; opening the store creates no
  legacy database. With the switch on, the marker makes `.ai/squawk/` the write root: moved
  runs are ordinary writable runs, not fallback runs, and new tasks, worktrees, worker
  workspaces and previews write there. With the switch off they stay fallback runs. A
  second migration of a marked project plans nothing and writes no journal
  (`alreadyMoved`); it still prints the `git mv` commands for tracked files left in
  `.ai/cezar/`. A tracked `.ai/cezar/.gitignore` is not shadowed by a new file in
  `.ai/squawk/` until the user moves it; the shared Git excludes cover both directories.
- **Limits.** Agent temp fallback directories outside the project are keyed by the data
  directory (hearsay-tools/cezarion#3146). Claude Code keys session history by working
  directory, so a moved worktree starts a new Claude session history.

## Project migration command and early recovery

P4b3 (hearsay-tools/cezarion#3089) connects the fence and the engine, offline.

- **Command.** `migrate-project [--dry-run] [--repo <dir>]` (`project-migration/cli.ts`) is
  registered, advertised and dispatched exactly when `REBRAND_SWITCH` is true; with the
  switch off it is an unknown command. Only the user runs it, with the cockpit stopped: it covers CLI-only
  users and projects the automatic move left in place. Tests pass the switch as a parameter
  (`loadSubcommand`, `main`); the constant never changes.
- **Offline run.** `migrateProjectOffline` (`project-migration/offline.ts`): refuse while
  anything is live (above), finish an unfinished journal (and report it as the migration),
  take `cockpit.lock` and the fence with the read-only live-task check, run `migrateProject`,
  release both claims. A dry run holds only `cockpit.lock` (in the directory that exists),
  passes admission and plans; when it finished an unfinished journal first, it reports what that
  recovery moved and rewrote before the plan of what remains. A plan with blockers or
  conflicts still prints on stdout, but the command exits 1, including with no planned moves.
- **Automatic move.** With `REBRAND_SWITCH` true, the cockpit moves an idle legacy project
  itself (`moveProjectWhenIdle`, `project-migration/auto.ts`): at start for the boot project,
  before the listener; right after the listener starts for every other registered project (the
  post-listen preparation below), or earlier when a request, a lazy build or the warm-up reaches
  it first; and for a project registered later when it is added. Each move runs before any
  ordinary read or task start of that project, so a cockpit start moves every registered
  project, opened or not, that passes the checks below. Journal recovery runs first. A project
  that carries the moved marker reports `nothing` without planning; callers ask `projectPaths`
  for the write root only after the prepare step. When `.ai/cezar/` holds
  state to move and the plan has no blocker or conflict, the same live check as the command
  runs, without counting the cockpit's own process (its `cockpit.lock` claim and its presence
  lease): with no other writer, the offline move runs under the cockpit's own claim
  (`moveUnderFence`). A task from before the restart is no other writer: its own items stay
  (**Leftover tasks**). With another writer live (another cockpit, a family another process
  claims), nothing moves: the project is served from both folders as before, a log
  notice names what blocks the move, and the next start tries again (one attempt per project
  per cockpit run; a caller that comes while it runs waits for it). The notice of a finished
  move lists the `git mv` commands for tracked files and the tasks that keep their files
  in `.ai/cezar/` until they are archived. A marked project whose `.ai/cezar/` holds more than `cockpit.lock*` plans
  again at each start and moves what no kept task owns now. Any failure before the journal exists
  only delays the move; a failure after it leaves the journal, so admission refuses the
  project until recovery finishes it. Every cockpit
  path that touches a project before or without its context runs the same prepare step
  (`prepareProject`: journal recovery, then the automatic move): the context build, the
  post-listen preparation of every registered project (before the preview sweep, automation
  discovery, the scheduler and the archive and completion ticks start; it stops between projects,
  and those starts are skipped, once the cockpit is closing), the automation coordinator's
  project list and a project added later, the ticks' project lists and the cold run index. A
  project whose automation lease this cockpit holds is not moved (the move waits for the next
  start). With the switch false it is the journal recovery of before.
  CLI entries recover journals but never start a move. The switch must not turn on before the
  per-project write root follows moved state (hearsay-tools/cezarion#3150): until then moved
  runs are fallback runs.
- **Leftover tasks** (owner decision A, hearsay-tools/cezarion#2778). The plan takes the ids
  of the tasks that can still resume at planning (`keep`, read under the fence by
  `projectKeptRunIds`): every live task and every task not archived, since a human can Continue
  a done, review, failed or cancelled task from its stored worktree. Live-ness alone does not
  select items; an archived task's items move, and a deleted task's items move or are gone. A
  row that is not archived but whose record cannot be read refuses the move. Their own items stay in
  `.ai/cezar/`: `worktrees/<id>`, `tmp/<id>`, `preview/<id>`, `t/<first 8 of id>` and every
  `runs/<id>…` entry (`legacyItemOwner` in `legacy-runs.ts`). The directory around such an item
  merges item by item; no stored path into one is rewritten, so a session resumes at its old
  cwd; a kept task's `workflowDef` and `delegation.context` fields are never rewritten, because
  the worker identity file binds them by hash (`identityBoundField` in `plan.ts`); a stored path into a moved item is rewritten, in a kept file too (in place, under
  `<source>/runs/`). The `leftovers` step writes the ids to `.ai/squawk/legacy-runs.json`
  before the mark, then removes the directories the move emptied and `.ai/cezar/` itself when
  nothing is left in it. `runDataDir(dataDir, id)` resolves a listed task's data directory to
  `.ai/cezar/`; every path helper of a run's own items (handoff, history, artifacts,
  attachments, worker results, scratch and control directories, preview profile, autosave
  cleanup, history removal, `RunStore.sourceDataDir`, the reports index and the agent's granted
  `runs/` directory) calls it, the boot preview sweep also scans the listed tasks' real
  `preview/<id>` (never through a link), and `fallbackProjectWriteError` and
  `isFallbackProjectPath` exempt such items, so the task and its cleanup (a worker's destroy
  retry) work at the stored paths. A later move carries a task's items once it is archived or
  deleted and drops it from the list; no task left removes the file. The checks fail closed:
  only an absent `legacy-runs.json` means no kept task; a present one that cannot be read throws
  `LegacyRunsUnreadableError` from `runDataDir`, the write guards treat no item as kept, and the
  next move rewrites the file from the run store. A top-level directory the plan cannot list
  blocks the plan, since it may hold a kept item. Only a kept task's own
  `identity`/`execution`/`processes` files reserve it as a worker (`workerEvidenceRunIds`).
- **Early recovery.** `recoverProjectMigration(root, { ownership, keep })`
  (`project-migration/recovery.ts`) finishes an unfinished journal under the exclusive fence
  before the entry that finds it reads the project, in both switch states. Without a journal it costs one
  `lstat`. It takes the fence without a live-task check: the journal has refused every admission
  since it was written, and a migration starts only with no other writer it can see. It leaves the journal
  to a live cockpit that owns the project or a process that holds its fence; admission
  refuses meanwhile. It uses the caller's claim when the caller owns the project or is about
  to (`keep`), otherwise a temporary claim it releases. Concurrent calls in one process share
  one recovery. A journal that cannot finish, or is refused as untrusted, throws
  `ProjectMigrationRecoveryError` (409 on routes, exit 1 in the CLI, a failed boot): the
  journal stays and admission keeps refusing.
- **Entry points.** Cockpit boot (`serveCommand`, before its ownership claim and the listener;
  boot keeps the claim), lazy context builds (`ProjectContexts.build`), the warm-up (a journal
  alone no longer skips a project), the post-listen preparation of every registered project,
  the archive and completion ticks (`prepareBeforeTicks`: each tick's project list, before the
  tick's admission check), the cold workspace runs index and search (`prepareProjects` in
  `projectRunSources`; a failure leaves the project out with a warning), CLI `run`, `init` and the single-project `projects` listing (`cli-dispatch.ts`,
  module loaded only when a journal exists), `artifact publish` (which then refuses a task
  context that names a moved path), `versions` checkout discovery (which lists the worktrees
  again from the main checkout after a recovery moved them), and `migrate-project` itself
  (`migrateProject` also resumes first). Other readers skip a refused project, as before.

## Rules

One `{store, manager, dataDir, launchKey}` context per registered project, built on first touch or by the background warm-up after listen (`warmAll`, off with `HSQ_PROJECT_WARMUP=0` (`CEZ_PROJECT_WARMUP` fallback), hearsay-tools/cezarion#667), disposed on removal; a `missing` root is never instantiated (unknown id → 404, gone root → 409). Every project route is registered **once** in a chained family builder and mounted under both `/api/v1/<path>` (bound to the boot project) and `/api/v1/p/:projectId/<path>` — `route-parity.test.ts` walks the exported route manifest and asserts `/api/v1/x`, `/api/v1/p/<boot>/x` and `/api/v1/p/default/x` answer byte-identically, so a new scoped route without its alias fails the suite. `default` is the reserved boot alias and is never an allocated slug. Workspace-level routes (`/projects`, `/workspace/*`, `/fs/browse`) are single-mount and never scope-prefixed. The cockpit mirrors the split: every view lives under `/p/:projectId/`, flat legacy PAGE paths redirect to the boot project, and global settings sit outside the scope at `/settings/global`. Add each route to its family's chain ([the HTTP API](http-api.md)); `versioned-surface.test.ts` fails on any route outside `/api/v1`.

**Warm-up is an owner-approved exception to [zero config](../../AGENTS.md#zero-config):** project warm-up is default-on (hearsay-tools/cezarion#667). After the server listens it builds every other registered project's context one at a time, which runs recovery and so may resume interrupted runs and spend tokens in projects not yet opened; it skips projects another live cockpit owns and single-project mode, claims each warmed project's `cockpit.lock` for the process lifetime, and `HSQ_PROJECT_WARMUP=0` (`CEZ_PROJECT_WARMUP` fallback) restores purely lazy builds.

Fresh project writes also require an absent or real `.ai/squawk` directory. A
symlink or file keeps legacy writes and is never marked fresh. The destination
check is shared with migration planning. If a cockpit is known but its live tasks
cannot be read, migration still refuses and lists both the cockpit and the read
failure. It does not treat the failed read as an empty task list.
