# Project-scoped routes and contexts

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/server/project-context.ts`, then `packages/cezar/src/server/server.ts`, `packages/web/src/routes.tsx`

## Two project directories before P5

Context `dataDir` remains the legacy write root from `projectPaths`. `RunStore`
and cold indexes merge the read roots internally. History, artifacts, handoffs,
attachments and cleanup checks use `store.sourceDataDir(runId)`. Inspect fallback
cockpit ownership before claiming legacy state; never reclaim a fallback claim.
Maintenance can read fallback history without recovery or a shadow legacy database.

## Project migration fence

One claim file, `<root>/.ai/squawk-migration.lock`, fences a project during a
migration (hearsay-tools/cezarion#3087). It sits beside both directory names, so a
directory move never carries it and never creates a second owner. It uses the
`CockpitOwnership` claim protocol: exclusive link-create, the `.reclaim` guard,
pid plus start-token liveness and token-checked release.

- **Who claims.** `CockpitOwnership.fenceProject(dataDir, { liveTasks })`. It first owns
  `cockpit.lock` (an owning cockpit already does; a CLI with no cockpit takes it in
  whichever project directory exists, so a resume after the move never recreates the old
  name), then claims the fence. Only the `cockpit.lock` holder ever holds the fence, so
  no other cockpit boots or serves the project meanwhile. A competing CLI meets the held
  fence and fails at once. An owning cockpit calls `fenceProjectContext(ownership, context)`.
- **Admission.** `projectAdmissionRefusal(dataDir)`: two `lstat` calls when dormant,
  nothing written. It refuses a live fence (the process's own included), an unreadable
  lock (the message names the file and when it is safe to remove it) and an existing
  journal `.ai/squawk-migration.json`. A dead owner without a journal admits; the next
  fence claim reclaims the file.
- **Leases.** New project work enters through `withProjectAdmission(dataDir, work, refused)`:
  refused when fenced, otherwise counted until `work` settles. The lease travels with the
  async call chain (`AsyncLocalStorage`): everything the admitted work calls, a task start
  or a context build included, passes this process's own fence while the lease is open,
  and that fence's drain waits for what it started. A lease never passes a fence another
  owner holds: that fence cannot count it, so admission always reads the fence file and
  refuses there, admitted work included. Work that admitted or live work set going (webhook
  deliveries, preview releases) runs through `holdProjectWork`: counted, admitted for its
  whole length, never refused. A detached job (a manual automation check) opens its own
  `withProjectAdmission` span before its request answers. Entry points: every project route (409), finite
  run-event reads, lazy context builds, maintenance (`withMaintenanceStore`),
  archive-on-merge and completion actions (`withStore`), automation timer fires, the
  preview leftover sweep. Point checks: `acquire` (before `mkdir` and after its claim),
  built contexts, warm-up, `AutomationCoordinator.store` and `refresh`, runs index and
  search, the activity snapshot, socket upgrades and live feeds, `RunManager.startRun`
  and `continueRun`, the artifact writer before each write. CLI points are in
  [the CLI area](cli.md#project-migration-fence).
- **Write backstop.** Under every store write, claim and save, `projectWriteRefused` refuses
  while a fence holds the project and the caller has no lease or hold, except in the
  holder's own process while its drain runs (the work being drained lands, and the holder
  flushes the store inside the drain). A refused save is skipped and its rows stay dirty
  until the fence ends; a refused claim leaves the family unclaimed, so a new task or a
  repair (a late repo-handle result) writes nothing; a durable commit writes nothing and
  throws, as on a closed store. The same check guards the automation store: definition
  and state writes throw before memory changes; receipts, logs and compaction skip; no
  lock directory is recreated and a held lock is left in place. It also guards the artifact writer (cleanup in `finally` included), the data
  `.gitignore` and the voice log (skipped), and config updates, project ui-state and the
  launch key (they throw, nothing written). Each fence logs its first skipped write once. The holder's
  own rewrites (P4b2) run inside `holdProjectWork`. Read-only paths skip while fenced:
  health answers the last config it read (`healthConfig`), the activity publisher stops
  its foreign-claim check.
- **Automatic jobs.** A refusal inside an automatic job is a skip that writes nothing into
  the fenced project: an automation fire becomes `AutomationProjectUnavailableError`
  (nothing reserved, advanced, logged or counted; the timer retries at its floor), and the
  coordinator arms no timer for a fenced project. The skip goes to the cockpit's process
  log once per fence. The occurrence stays in the persisted state and fires after the
  fence ends, once, through the scheduler's catch-up (24 h), also after a restart.
  Maintenance and sweeps return nothing. An automatic resume or wait wake continues a run
  that is already live, so `continueRun` never refuses it; it refuses only a run that is
  not live.
- **Live tasks (strict fence).** `projectLiveTasks(store)`: every non-terminal task
  (`isLiveRecord`: queued, running, waiting on a human, a usage-limit auto-resume, a
  timer, a PR or a worker), held by the store or persisted as live in either directory
  (a row another process left behind), plus the runs of families another live store
  claims in `run_claims` (a headless `cez run`, another binary), read from both physical
  claim tables so a stale legacy claim never hides a live fallback one. Right after the claim, with no
  wait in between, the fence refuses while any exists: it releases at once and throws
  `ProjectMigrationBusyError` with each task's id, title and state and the next step
  (finish or cancel each one). The preflight and the drain share this one notion of live.
  Chosen over letting controls of live tasks through during a drain: a strict fence never
  waits on a task that only a person can settle.
- **Bounded drain.** After a clean preflight the holder drains work in flight: leases and
  tracked work in its process, runs pinned by an active run, a Continue, retention,
  publish or branch cleanup, and the manager's tracked async work. The bound is
  `PROJECT_FENCE_DRAIN_MS`, 60 s: longer than one webhook delivery series (3 attempts of
  10 s with backoff), a context build with recovery and one bounded archive or
  automation tick; short enough that no migration hangs. At the bound the migration stops
  by itself: the fence is released and the same error lists what is still live. An abort
  signal releases it earlier. Inside the same bound and abort the owning cockpit settles,
  each step after the work it covers: it stops the project's dev servers and Chromium and
  waits until every one of their processes has exited, closed earlier included (a browser
  gets SIGKILL 5 s after its close; `PreviewHost.releaseProject`), then waits for history
  compression and queued report scans, then flushes the store (`settle`). A process that
  never exits ends as a drain timeout, never as success. The holder keeps the fence until
  `release()`, after the last rewrite.
- **Run-scoped writers.** These write only for a run that is live or held, so their check is
  that invariant: the preflight refuses while any run is live in either directory or held
  by a live foreign claim, the drain waits for held runs and tracked work, and a headless
  run is visible through its claim from its first write. `runs/agent-tmpdir.ts`,
  `runs/history-file.ts`, `runs/transcript-facts.ts`, `workflows/run/attachment-writer.ts`,
  `workflows/run/queued-input.ts`, `handoff.ts`, `autosave-cleanup.ts`,
  `delegation/context.ts`, `delegation/workspace.ts`, task worktrees in `git-worktree.ts`,
  `preview/dev-server.ts`, `preview/chromium.ts`, `preview/host.ts`,
  `preview/agent-marker.ts`, `artifacts/lifecycle.ts`.
- **Not owner-gated.** A cockpit that does not own a project still runs its automations;
  under a fence the write backstop drops their writes. Their failing launches are
  hearsay-tools/cezarion#3136.
- **Holder duty (P4b2).** After the drain and before the first move, the holder disposes
  the project's context and closes its store: `migrateProject`'s `closeProject` (an owning
  cockpit passes `contexts.dispose(id, { releasePreviews: false })`). `close()` saves once
  and leaves no save timer; later saves return without a database. It stops the
  transcript-facts queue and settles its jobs, so no sidecar is written later. A late
  repo-handle result finds no database and writes nothing (lazy contexts also abort it).
  The reports index and history compression are drained before (`settle`); after close the
  reports index starts no queued scan and checks `closed` before each write. While a fence
  is held the reports index queues no new scan, so the drained `idle()` covers every scan. Branch sweeps
  touch Git refs only.
- **Journal.** The journal blocks admission whether its owner lives or not; only the
  fence holder passes. The engine removes it as its last step; the caller then calls `release()`.
  Early recovery runs in front of admission ([below](#project-migration-command-and-early-recovery)).
- **Residual window.** Leases are per process. A short CLI operation (`init`, a
  single-project `projects` listing, `run` before its store opens) admitted just before
  another process takes the fence can still read project files until it ends. Each CLI
  write path re-checks admission right before its first project write, and a headless
  run's claims keep the drain waiting. Long-lived event streams over an already open
  store end when the holder closes that store.

## Project state migration engine

`packages/cezar/src/project-migration/` (P4b2, hearsay-tools/cezarion#3088) moves a
project's runtime state from `.ai/cezar/` to `.ai/squawk/`. P4b3 wires `migrateProject`
behind the P5 gate and `resumeProjectMigration` into every project entry
([below](#project-migration-command-and-early-recovery)); P5 enables the command.

- **Fence.** It runs only under a fence its own process holds (`holdsProjectFence`), and
  all its work runs inside `holdProjectWork`, so its writes pass the backstop only as the
  holder's.
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

  Steps 1 to 3 run inside one hold of the common directory's worktree mutation lock. The
  Git locks keep a `git worktree prune` from any checkout sharing the Git directory from
  deleting a registration whose old path is gone, also after a crash between the move and
  the repair. Each item is applied only while it holds its old value and skipped when it
  holds the new one, so a resume after a crash between an effect and its mark changes
  nothing twice. A value that is neither stops the step; the journal stays and admission
  stays blocked.
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
  legacy database. Until P5 changes the write root, the moved runs are fallback runs.
- **Limits.** Agent temp fallback directories outside the project are keyed by the data
  directory (hearsay-tools/cezarion#3146). Claude Code keys session history by working
  directory, so a moved worktree starts a new Claude session history.

## Project migration command and early recovery

P4b3 (hearsay-tools/cezarion#3089) connects the fence and the engine.

- **Gate.** `PROJECT_MIGRATION_SWITCH` (`project-migration/switch.ts`, false until P5) alone
  registers, advertises and dispatches `migrate-project` and opens the owner's route.
  `REBRAND_SWITCH` never does. Tests pass the gate as a parameter (`loadSubcommand`, `main`)
  or as `ServerDeps.projectMigration`; the constant never changes.
- **Owner route.** `POST /api/v1/projects/:projectId/migration` (`server/project-migration-route.ts`)
  is a workspace route on purpose: a project route holds an admission lease for its whole
  length, and the fence's drain would wait on its own caller. Gate off: the path is not served,
  so every request answers as an unknown route does, before its body is parsed. Hosted: 403. A project another cockpit owns, a busy project (the body lists `liveTasks`), a
  refused plan, a held fence or a failed recovery: 409. The owner builds the context, takes
  `fenceProjectContext`, runs `migrateProject` with `closeProject` disposing the context, and
  releases; the next request builds the context again over the moved state. A dry run takes no
  fence: it claims the project for this cockpit and plans inside an admission lease, so it is
  refused while a fence or a journal holds the project. The cockpit
  refuses its own boot project (409): the boot context is not rebuilt after its store closes,
  so the user stops that cockpit and runs the command with no owner.
- **CLI.** With a live owner the CLI finds the project id in the owner's `GET /projects` and
  posts to its route; it touches no project file. With no owner it takes `cockpit.lock` and
  the fence itself (`fenceProject`, live tasks read from a maintenance store), runs the
  engine, closes that store as the holder duty, and releases both claims. A dry run holds only
  `cockpit.lock` (in the directory that exists) and passes admission before it plans. When a
  cockpit takes the project between the owner check and the claim, the CLI asks that cockpit.
- **Early recovery.** `recoverProjectMigration(root, { ownership, keep })`
  (`project-migration/recovery.ts`) finishes an unfinished journal under the exclusive fence
  before anything reads the project. Without a journal it costs one `lstat`. It takes the
  fence with nothing live and nothing in flight: the journal has refused every admission since
  it was written, and a migration starts only with no live task. It leaves the journal to a
  live cockpit that owns the project or a process that holds its fence; admission refuses
  meanwhile. It uses the caller's claim when the caller owns the project or is about to (`keep`),
  otherwise a temporary claim it releases. Concurrent calls in one process share one recovery.
  A journal that cannot finish throws `ProjectMigrationRecoveryError` (409 on routes, exit 1
  in the CLI, a failed boot): the journal stays and admission keeps refusing. Recovery does
  not depend on the gate.
- **Recovery before the lease.** Every caller runs recovery before it opens an admission
  lease (`withProjectAdmission`, `holdProjectWork`): inside a lease, the recovery fence's drain
  would wait on its own caller.
- **Entry points.** Cockpit boot (`serveCommand`, before its ownership claim and the listener;
  boot keeps the claim), lazy context builds (`ProjectContexts.build`, before the lease), the
  warm-up (a journal alone no longer skips a project), the archive and completion ticks
  (`recoverBeforeTicks`: each tick's project list, before the tick's admission check and its
  maintenance store lease), the cold workspace
  runs index and search (`projectRunSources`; a failure leaves the project out with a
  warning), CLI `run`, `init` and the single-project `projects` listing (`cli-dispatch.ts`,
  module loaded only when a journal exists), `artifact publish`, `versions` checkout discovery
  (which lists the worktrees again after a recovery moved them), and `migrate-project` itself (CLI and route; `migrateProject` also resumes first). Other
  readers skip a refused project, as before.

## Rules

One `{store, manager, dataDir, launchKey}` context per registered project, built on first touch or by the background warm-up after listen (`warmAll`, off with `CEZ_PROJECT_WARMUP=0`, hearsay-tools/cezarion#667), disposed on removal; a `missing` root is never instantiated (unknown id → 404, gone root → 409). Every project route is registered **once** in a chained family builder and mounted under both `/api/v1/<path>` (bound to the boot project) and `/api/v1/p/:projectId/<path>` — `route-parity.test.ts` walks the exported route manifest and asserts `/api/v1/x`, `/api/v1/p/<boot>/x` and `/api/v1/p/default/x` answer byte-identically, so a new scoped route without its alias fails the suite. `default` is the reserved boot alias and is never an allocated slug. Workspace-level routes (`/projects`, `/workspace/*`, `/fs/browse`) are single-mount and never scope-prefixed. The cockpit mirrors the split: every view lives under `/p/:projectId/`, flat legacy PAGE paths redirect to the boot project, and global settings sit outside the scope at `/settings/global`. Add each route to its family's chain ([the HTTP API](http-api.md)); `versioned-surface.test.ts` fails on any route outside `/api/v1`.

**Warm-up is an owner-approved exception to [zero config](../../AGENTS.md#zero-config):** project warm-up is default-on (hearsay-tools/cezarion#667). After the server listens it builds every other registered project's context one at a time, which runs recovery and so may resume interrupted runs and spend tokens in projects not yet opened; it skips projects another live cockpit owns and single-project mode, claims each warmed project's `cockpit.lock` for the process lifetime, and `CEZ_PROJECT_WARMUP=0` restores purely lazy builds.
