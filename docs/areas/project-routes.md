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
  the project's context and closes its store. `close()` saves once
  and leaves no save timer; later saves return without a database. It stops the
  transcript-facts queue and settles its jobs, so no sidecar is written later. A late
  repo-handle result finds no database and writes nothing (lazy contexts also abort it).
  The reports index and history compression are drained before (`settle`); after close the
  reports index starts no queued scan and checks `closed` before each write. While a fence
  is held the reports index queues no new scan, so the drained `idle()` covers every scan. Branch sweeps
  touch Git refs only.
- **Journal.** The journal blocks admission whether its owner lives or not; only the
  fence holder passes. P4b2 removes it as its last step before `release()`. P4b3 adds
  early recovery in front of admission.
- **Residual window.** Leases are per process. A short CLI operation (`init`, a
  single-project `projects` listing, `run` before its store opens) admitted just before
  another process takes the fence can still read project files until it ends. Each CLI
  write path re-checks admission right before its first project write, and a headless
  run's claims keep the drain waiting. Long-lived event streams over an already open
  store end when the holder closes that store.

## Rules

One `{store, manager, dataDir, launchKey}` context per registered project, built on first touch or by the background warm-up after listen (`warmAll`, off with `HSQ_PROJECT_WARMUP=0` (`CEZ_PROJECT_WARMUP` fallback), hearsay-tools/cezarion#667), disposed on removal; a `missing` root is never instantiated (unknown id → 404, gone root → 409). Every project route is registered **once** in a chained family builder and mounted under both `/api/v1/<path>` (bound to the boot project) and `/api/v1/p/:projectId/<path>` — `route-parity.test.ts` walks the exported route manifest and asserts `/api/v1/x`, `/api/v1/p/<boot>/x` and `/api/v1/p/default/x` answer byte-identically, so a new scoped route without its alias fails the suite. `default` is the reserved boot alias and is never an allocated slug. Workspace-level routes (`/projects`, `/workspace/*`, `/fs/browse`) are single-mount and never scope-prefixed. The cockpit mirrors the split: every view lives under `/p/:projectId/`, flat legacy PAGE paths redirect to the boot project, and global settings sit outside the scope at `/settings/global`. Add each route to its family's chain ([the HTTP API](http-api.md)); `versioned-surface.test.ts` fails on any route outside `/api/v1`.

**Warm-up is an owner-approved exception to [zero config](../../AGENTS.md#zero-config):** project warm-up is default-on (hearsay-tools/cezarion#667). After the server listens it builds every other registered project's context one at a time, which runs recovery and so may resume interrupted runs and spend tokens in projects not yet opened; it skips projects another live cockpit owns and single-project mode, claims each warmed project's `cockpit.lock` for the process lifetime, and `HSQ_PROJECT_WARMUP=0` (`CEZ_PROJECT_WARMUP` fallback) restores purely lazy builds.
