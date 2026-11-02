# GitHub integration

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/server/github.ts`, `packages/cezar/src/server/pr.ts`

## Rules

Must degrade gracefully: no `gh`, no remote, offline all return `{ available: false, reason }` — never an error. `gh … --json` output is zod-validated at the boundary. `GITHUB_TOKEN` is the fallback when `gh` isn't authenticated. `createDraftPr` never throws; failures map to one-line human errors. `CEZ_DRY_RUN=1` fakes the PR URL.
