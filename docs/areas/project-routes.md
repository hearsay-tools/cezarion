# Project-scoped routes and contexts

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/server/project-context.ts`, then `packages/cezar/src/server/server.ts`, `packages/web/src/routes.tsx`

## Rules

One `{store, manager, dataDir, launchKey}` context per registered project, built on first touch or by the background warm-up after listen (`warmAll`, off with `CEZ_PROJECT_WARMUP=0`, hearsay-tools/cezarion#667), disposed on removal; a `missing` root is never instantiated (unknown id → 404, gone root → 409). Every project route is registered **once** in a chained family builder and mounted under both `/api/v1/<path>` (bound to the boot project) and `/api/v1/p/:projectId/<path>` — `route-parity.test.ts` walks the exported route manifest and asserts `/api/v1/x`, `/api/v1/p/<boot>/x` and `/api/v1/p/default/x` answer byte-identically, so a new scoped route without its alias fails the suite. `default` is the reserved boot alias and is never an allocated slug. Workspace-level routes (`/projects`, `/workspace/*`, `/fs/browse`) are single-mount and never scope-prefixed. The cockpit mirrors the split: every view lives under `/p/:projectId/`, flat legacy PAGE paths redirect to the boot project, and global settings sit outside the scope at `/settings/global`. Add each route to its family's chain (AGENTS.md § The HTTP API); `versioned-surface.test.ts` fails on any route outside `/api/v1`, and `bc-route-inventory.test.ts` (which reads a built app's route table, not the source) requires it to be inventoried in BACKWARD_COMPATIBILITY.md §2.
