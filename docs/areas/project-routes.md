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
  or a context build included, passes admission while the lease is open, and the drain
  then waits for what it started. Work that admitted or live work set going (webhook
  deliveries, preview releases, a manual automation check) is counted with
  `trackProjectWork`, never refused. Entry points: every project route (409), finite
  run-event reads, lazy context builds, maintenance (`withMaintenanceStore`),
  archive-on-merge and completion actions (`withStore`), automation timer fires, the
  preview leftover sweep. Point checks: `acquire` (before `mkdir` and after its claim),
  built contexts, warm-up, `AutomationCoordinator.store` and `refresh`, runs index and
  search, the activity snapshot, socket upgrades and live feeds, `RunManager.startRun`
  and `continueRun`, the artifact writer before each write. CLI points are in
  [the CLI area](cli.md#project-migration-fence).
- **Automatic jobs.** A refusal inside an automatic job is a skip: an automation fire
  becomes `AutomationProjectUnavailableError` (nothing reserved, advanced, logged or
  counted; the timer retries at its floor), maintenance and sweeps return nothing.
- **Who drains.** The fence holder. It waits until no lease or tracked work remains for
  the project in its process, no run is held (live, or pinned by an active run, a
  Continue, retention, publish or branch cleanup), the manager has no tracked async work,
  and no other live store claims a family in `run_claims` (a headless `cez run`, another
  binary). The owning cockpit then waits for history compression. It holds the fence
  until `release()`, after the last rewrite.
- **Holder duty (P4b2).** After the drain and before the first move, the holder disposes
  the project's context with previews released and closes its store. That ends the
  store's own work (save debounce, transcript facts, the reports index, the repo-handle
  retry) and the manager's timers. Branch sweeps touch Git refs only.
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

One `{store, manager, dataDir, launchKey}` context per registered project, built on first touch or by the background warm-up after listen (`warmAll`, off with `CEZ_PROJECT_WARMUP=0`, hearsay-tools/cezarion#667), disposed on removal; a `missing` root is never instantiated (unknown id → 404, gone root → 409). Every project route is registered **once** in a chained family builder and mounted under both `/api/v1/<path>` (bound to the boot project) and `/api/v1/p/:projectId/<path>` — `route-parity.test.ts` walks the exported route manifest and asserts `/api/v1/x`, `/api/v1/p/<boot>/x` and `/api/v1/p/default/x` answer byte-identically, so a new scoped route without its alias fails the suite. `default` is the reserved boot alias and is never an allocated slug. Workspace-level routes (`/projects`, `/workspace/*`, `/fs/browse`) are single-mount and never scope-prefixed. The cockpit mirrors the split: every view lives under `/p/:projectId/`, flat legacy PAGE paths redirect to the boot project, and global settings sit outside the scope at `/settings/global`. Add each route to its family's chain ([the HTTP API](http-api.md)); `versioned-surface.test.ts` fails on any route outside `/api/v1`.

**Warm-up is an owner-approved exception to [zero config](../../AGENTS.md#zero-config):** project warm-up is default-on (hearsay-tools/cezarion#667). After the server listens it builds every other registered project's context one at a time, which runs recovery and so may resume interrupted runs and spend tokens in projects not yet opened; it skips projects another live cockpit owns and single-project mode, claims each warmed project's `cockpit.lock` for the process lifetime, and `CEZ_PROJECT_WARMUP=0` restores purely lazy builds.
