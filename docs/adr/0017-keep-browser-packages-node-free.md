# Keep browser packages independent of the service graph

The contract and api-client are shared by browser and Node consumers. Their compiler
libraries exclude Node types. The client takes AppType through a type-only boundary rather
than loading the service. Contract values use module subpaths to avoid loading unrelated
schemas through a root barrel.

## Consequences

Protocol vocabulary and tool-display logic still have service/client mirrors. Type exactness
checks and shared input tables check those copies. A mirror is a maintenance cost, but importing
the service’s NodeNext graph into a browser package would break the boundary.

The workspace packages are currently private source consumers. Extension rewrite settings do
not imply that the api-client is published or that a published dist artifact exists.

## Considered Options

- **Import the service implementation into the browser package.** Rejected to keep its runtime graph free of service and Node dependencies.
- **Trust hand-maintained mirrors.** Rejected; executable parity checks are required.

Implementation: [tsconfig.json](../../packages/api-client/tsconfig.json), [tsconfig.json](../../packages/contract/tsconfig.json), [tool-display.ts](../../packages/api-client/src/protocol/tool-display.ts), [AGENTS.md](../../AGENTS.md).

Coverage: [api-types.test.ts](../../packages/cezar/src/server/api-types.test.ts), [tool-display-mirror.test.ts](../../packages/cezar/src/server/tool-display-mirror.test.ts), [contract-import-boundaries.test.ts](../../packages/cezar/src/contract-import-boundaries.test.ts) and the lint rule it pins, [contract-root-import.ts](../../packages/cezar/src/lint/contract-root-import.ts).
