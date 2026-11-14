# Packages and repository layout

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`package.json` (workspaces), then each package's `package.json`

## Rules

Four pnpm workspaces (npm script metadata retained) under a `private` root that publishes nothing itself:

| Path | Package | What it is |
| --- | --- | --- |
| `packages/cezar` | `@wjarka/cezarion` | The service + CLI, and everything behind them (runs, workflows, agent runners, workspace state). Publishes as `@hearsay-tools/squawk`: `bin`, plus the built cockpit in `web/dist`. |
| `packages/contract` | `@open-mercato/cezar-contract` | The HTTP contract itself: every request and response as a zod schema with its TypeScript type inferred from it, so no shape is written twice. **Node-free on the same terms as the api-client** (`lib: ["ES2022"]`, `types: []` in its tsconfig make a `node:*` import a compile error). `private`, and that has a cost: the service imports a contract VALUE (`workspaceUiStateSchema`, in `workspace/migrations.ts`), so a published tarball naming a package npm has never seen would fail on install. `packages/cezar/scripts/inline-contract.mjs` runs as `postbuild` to fold the contract into `dist/contract/` — bundle AND declarations — and repoint the emitted references, module subpaths included. Each module is also a subpath, `@open-mercato/cezar-contract/<module>`, which is how code imports a contract value (see [the HTTP API](http-api.md)). Delete that script the day the contract is published, or the day nothing in the service imports a contract value. |
| `packages/api-client` | `@open-mercato/cezar-api-client` | The contract between the two: the typed client over `AppType`, the SSE/protocol types, and the scope helpers. Re-exports `packages/contract` so a consumer needs one import, for types. Values come through its subpaths: `/contract/<module>` (a one-line re-export of each contract module) and `/<path>` for its own modules. **Node-free by construction** — no `node:*`, no `@types/node` — because it is bundled into a browser AND imported by the Node service. `private` for now: versioned with the release but not on npm. The service may therefore only import it in TESTS — a runtime import would make the published CLI depend on something npm cannot resolve. |
| `packages/web` | `@open-mercato/cezar-web` | The cockpit SPA. Private; its output is an artifact of the service (`vite build` writes into `packages/cezar/web/dist`, which the CLI ships and serves). |

Rules that follow from that:

- npm release identities come from `home/identity.ts`. Publication projects the new scoped name into a disposable pack copy;
  source workspace names remain unchanged so builds and version-only bump PRs
  still work. See [publishing](../publishing.md#package-identity).

- **The CLI is not a separate package and should not become one.** It is the same program as the service — `packages/cezar/src/index.ts` boots `startServer`, but also `RunManager`, the workspace registry and the worktree machinery, and `hsq run` executes a workflow with no server at all.
- A dependency belongs to the workspace that imports it. The root carries only what spans all four (`typescript`, `vitest`, `tsx`). A build script counts as an importer: `scripts/inline-contract.mjs` reaches for `esbuild`, so `esbuild` is a devDependency of `packages/cezar` rather than something inherited from whatever vite happens to hoist.
- Cross-package imports go through the package name, never a relative path — the exceptions are test-only reaches for golden fixtures, and they are ugly on purpose.
- The repo root keeps only what spans workspaces: `scripts/dev.mjs` (boots both halves) and `scripts/release*.mjs` (a release spans every package). Everything else lives in the package that owns it.
