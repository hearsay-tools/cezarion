# `src/contract` — the API contract, as zod

Every request and response shape the HTTP API speaks, defined ONCE as a zod schema with its
TypeScript type inferred from it (`z.infer`), never written by hand.

Three consumers, one definition:

- **the server** (`src/server/server.ts`) validates requests with these schemas and types each
  handler's payload by the matching response schema, so the schema is the source of the route
  type rather than a second opinion about it;
- **`@open-mercato/cezar-api-client`** copies this directory in at `prebuild` (see
  `scripts/sync-contract.mjs`) and re-exports the schemas and the inferred types;
- **the cockpit** imports both from the api-client — the types to compile against, the schemas
  when it wants to validate before sending.

## Rules

1. **Node-free.** No `node:*`, no `fs`, no `process`. These files are compiled into the api-client,
   which is bundled into a browser. The api-client's tsconfig sets `types: []`, so a Node import
   here fails ITS build — the invariant is enforced, not documented.
2. **No imports outside this directory** except `zod`. A copied file has to compile in a package
   that has none of the server's module graph.
3. **Exactly what the server sends.** A response schema that is wider than the handler is a
   defect, not a convenience: the per-route guard in `src/server/contract-parity.test.ts` asserts
   `z.infer<schema>` and the route's own inferred type are MUTUALLY assignable, so a schema that
   drifts either way fails to compile.
4. **Values through module subpaths.** Each module is a package subpath:
   `@open-mercato/cezar-contract/<module>`, and `@open-mercato/cezar-api-client/contract/<module>`
   from the cockpit. Import a value from the module that defines it. The package root re-exports
   every module, delegation's schemas among them, so a value taken from the root loads them all
   (hearsay-tools/cezarion#1237). Types may still come from the root as `import type`;
   `packages/cezar/src/contract-import-boundaries.test.ts` refuses any other root import. A pure
   helper that has no schema to import goes in a module with no runtime import, as
   `run-labels.ts` and the `*-limits.ts` modules do, so its users load no schema.
5. **Test data through `src/test-factories.testkit.ts`.** It builds run records, waits and events
   typed from these schemas and exports a constant per enum value (`RUN_STATUS`, `WAIT_KIND`, …),
   so a renamed field or value stops compiling in every test that uses it. It imports no Node
   module, and both tsconfigs keep `*.testkit.ts` out of a build. The `test-enum-literal` rule in
   `.ai/ast-grep/rules` refuses a new enum literal in a test (hearsay-tools/cezarion#1812).
