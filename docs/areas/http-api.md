# The HTTP API

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/server/server.ts`, then `packages/contract/src/*.ts` and `packages/cezar/src/server/validators.ts`

## Server

Hono app, binds to `127.0.0.1` only. A global `/api/*` request-origin guard (open-mercato/cezar#426) runs before every route except `/api/v1/health`: it rejects non-loopback `Host` headers (DNS-rebinding) in local mode and cross-origin mutating requests (CSRF) in both modes — zero-config, no token, so the same-origin cockpit and the Vite dev proxy pass untouched. The loopback test is `isLoopbackHostHeader` (anchored 127.0.0.0/8, missing Host = untrusted); never match it with a `127.` string prefix. Routes, validation and shapes follow the invariants below. CORS is deliberately enabled for `/api/v1/health` only (cross-origin discovery); never widen it. SSE endpoints replay from NDJSON then stream live, deduped by `seq`.

## Request and response shapes

Add the schema in `packages/contract/src/*.ts` FIRST, then chain the route and validate through the trio. `contract-parity*.test.ts` proves the schema and the route agree in both directions, and `typed-bodies.test.ts` proves the route reached `AppType` at all.

## Invariants

Four invariants. A feature that breaks any of them compiles on its own branch and stops working
when it lands — open-mercato/cezar#694 arrived with eleven unreachable routes for exactly this reason.

- **Every request and response shape is a zod schema in `packages/contract`, with its TypeScript
  type inferred from it (`z.infer`).** Never hand-write an API type, and never declare one in
  `server.ts` or in the api-client. The api-client re-exports the contract; the cockpit imports
  the schema when it wants to validate and the type when it wants to compile.
- **Register routes by CHAINING them into a family builder**, the way the ~24 families in
  `server.ts` already do. Hono accumulates route types through the chain only: a loose
  `app.get(…)` statement returns a value nobody keeps, so the route vanishes from `AppType`
  (`packages/cezar/src/server/app-type.ts`) and the typed client cannot see it — silently, with
  the server still serving it.
- **Validate bodies, path params and the query string as route MIDDLEWARE**, through the trio in
  `src/server/validators.ts` (`jsonZodValidator`, `paramZodValidator`, `queryZodValidator`), and
  read the result with `c.req.valid(…)`. Parsing inside a handler is invisible to hono, which is
  what let `POST /runs` accept `{ totalNonsense: 12345 }` from a typed client without complaint.
  The rejection shape is `{ error }` with 400/404/409.
- **Everything answers under `/api/v1`** (project-scoped: `/api/v1/p/:projectId/…`). The
  unversioned surface is gone.

The contract must describe EXACTLY what the route sends — no wider, no narrower. When a schema and
its route disagree, fix the SOURCE, never widen the schema; `contract-parity*.test.ts` asserts both
directions and a one-way check passes on real drift. An object-literal `type: 'x'` can widen to
`string` during hono's inference, erasing a discriminant consumers narrow on (`as const`).

When a new variant lacks a field the other variants require, give it its own arm in
`z.discriminatedUnion` on the existing discriminant; never make the shared field optional
to admit it. See `openWaitSchema` in `packages/contract/src/waits.ts` as changed in
hearsay-tools/cezarion#1250: CI and timer waits require `deadline`, while the human arm
has none.

A request schema is just as exact about what the route TAKES: it refuses everything its handler
would refuse for a shape reason — a pattern, a length, a character set — so a body the middleware
admits never comes back a 400 from the handler, and `AppType` never promises an input the route
turns away. Export a shared rule ONCE from `packages/contract` and use that constant in the schema,
the handler and the cockpit; the handler never refuses, on shape alone, a value the schema let
through. What a schema cannot know — a name already taken, a run another process holds — stays the
handler's to refuse. In hearsay-tools/cezarion#1081 the create-project schema admitted names the
handler refused through `isValidCheckoutName`; one project-name pattern exported from the contract
now serves the schema, the handler and the New project dialog.

A route that touches a run's checkout names its checkout intent and asks the run checkout module
(`server/run-checkout.ts`) once for the directory, the run-state refusals and the claim; it never
checks the worktree or takes a claim itself ([ADR 0062](../adr/0062-one-module-decides-run-checkout-access.md)).
Each route follows this rule once a slice of hearsay-tools/cezarion#3158 has migrated it. Until then the route keeps its own handler checks, and a change to it follows its Table A row in the [run checkout spec](../../.ai/specs/2026-11-10-run-checkout-module.md#table-a-each-route-and-its-checks-in-todays-order).

Import a contract VALUE from the module that defines it, never through a package root. The
service writes `@open-mercato/cezar-contract/<module>`. The cockpit writes
`@open-mercato/cezar-api-client/contract/<module>`, or `@open-mercato/cezar-api-client/<path>` for
the api-client's own modules. Both roots re-export every contract module, delegation's schemas
among them, so one value imported through a root loads them all, and an edit to any shared schema
then reruns tests that never use it (hearsay-tools/cezarion#1237). Types still come from the
roots, as `import type`. The lint rule `cez/contract-root-import` refuses every other root
import and names the subpath for each value.

## Home recovery

The workspace-only `/api/v1/home/recovery` GET returns the `home-recovery` contract.
POST `/home/recovery/restore` and `/home/recovery/accept` accept `{file, detectedAt}` using the
same HomeStore allowlist as the CLI, never a free filesystem path. Their successful
response is the fresh snapshot; a recovery failure returns `{error}` with 409.
They use the normal origin guard and require `localHandoff`; hosted sessions receive 403. Remote-settings grant files are host-CLI-only and receive 403 even locally. GET uses the same read boundary as workspace config. No file content is returned.

Recovery actions apply only to the incident named by `detectedAt`. A newer incident returns 409; an already resolved incident returns the current snapshot without writing. Explicit CLI backup restore can still select retained backups when no incident is open.

A committed migrated home also reports `legacy-change` rows
with `canImport`. POST `/home/recovery/import` takes the same `{file, detectedAt}` and
uses the same local-only and host-CLI grant guards. Import performs a three-way merge
through HomeStore and requires its backup to succeed. `/accept` means Ignore for a
legacy row: it keeps the live file and records the observed legacy hash and next merge
base. Deleted legacy files are Ignore-only.
