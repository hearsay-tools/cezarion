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

- **Who claims.** `CockpitOwnership.fenceProject(dataDir, { liveTasks })`. An owning
  cockpit calls `fenceProjectContext(ownership, context)`. A CLI with no cockpit calls
  `fenceProject` directly: it claims the fence, then `cockpit.lock` in whichever
  project directory exists, so a resume after the move never recreates the old name.
  A competing CLI fails at once; a cockpit that won `cockpit.lock` first makes the
  migrator release the fence and fail.
- **Who drains.** The fence holder. It waits until no operation admitted in its
  process (`admitProject` leases) and no live task remain. Live tasks are the store's
  live rows (queued, running, waiting, open waits, auto-resume, pending worker destroy)
  plus every family another live store claims in `run_claims` (a headless `cez run`,
  another binary). It holds the fence until `release()`, after the last rewrite.
- **What admission checks.** `projectAdmissionRefusal(dataDir)`: two `lstat` calls when
  dormant, nothing written. It refuses a live fence (the process's own included), an
  unreadable lock (the message names the file and when it is safe to remove it) and an
  existing journal `.ai/squawk-migration.json`. A dead owner without a journal admits;
  the next fence claim reclaims the file. Admission points: `acquire` (before `mkdir`
  and after its claim), lazy builds and built contexts, maintenance, warm-up, the
  registered preview sweep, `projectRunSources` (runs index and search), the activity
  snapshot, the boot-project branch of archive-on-merge, every project route (409, a
  lease until the handler returns; workspace routes keep answering), `RunManager.startRun`
  and `continueRun`. CLI points are in [the CLI area](cli.md#project-migration-fence).
- **Journal.** The journal blocks admission whether its owner lives or not; only the
  fence holder passes. P4b2 removes it as its last step before `release()`. P4b3 adds
  early recovery in front of admission.
- **Residual window.** Leases are per process. A short CLI operation (`init`, a
  single-project `projects` listing, `run` before its store opens) admitted just before
  another process takes the fence can still read project files until it ends. Each CLI
  write path re-checks admission right before its first project write, and a headless
  run's claims keep the drain waiting. Long-lived event streams over an already open
  store end only when the owner closes that store (P4b2).

## Rules

One `{store, manager, dataDir, launchKey}` context per registered project, built on first touch or by the background warm-up after listen (`warmAll`, off with `CEZ_PROJECT_WARMUP=0`, hearsay-tools/cezarion#667), disposed on removal; a `missing` root is never instantiated (unknown id → 404, gone root → 409). Every project route is registered **once** in a chained family builder and mounted under both `/api/v1/<path>` (bound to the boot project) and `/api/v1/p/:projectId/<path>` — `route-parity.test.ts` walks the exported route manifest and asserts `/api/v1/x`, `/api/v1/p/<boot>/x` and `/api/v1/p/default/x` answer byte-identically, so a new scoped route without its alias fails the suite. `default` is the reserved boot alias and is never an allocated slug. Workspace-level routes (`/projects`, `/workspace/*`, `/fs/browse`) are single-mount and never scope-prefixed. The cockpit mirrors the split: every view lives under `/p/:projectId/`, flat legacy PAGE paths redirect to the boot project, and global settings sit outside the scope at `/settings/global`. Add each route to its family's chain ([the HTTP API](http-api.md)); `versioned-surface.test.ts` fails on any route outside `/api/v1`.

**Warm-up is an owner-approved exception to [zero config](../../AGENTS.md#zero-config):** project warm-up is default-on (hearsay-tools/cezarion#667). After the server listens it builds every other registered project's context one at a time, which runs recovery and so may resume interrupted runs and spend tokens in projects not yet opened; it skips projects another live cockpit owns and single-project mode, claims each warmed project's `cockpit.lock` for the process lifetime, and `CEZ_PROJECT_WARMUP=0` restores purely lazy builds.
