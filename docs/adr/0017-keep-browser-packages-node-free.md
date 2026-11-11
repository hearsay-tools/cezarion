# Keep browser packages independent of the service graph

The contract and api-client are shared by browser and Node consumers. Their compiler
libraries exclude Node types. The client takes AppType through a type-only boundary rather
than loading the service. Contract values use module subpaths to avoid loading unrelated
schemas through a root barrel.

## Consequences

Protocol vocabulary still has a service copy and a client copy, in the two `ui-events.ts` files.
`api-types.test.ts` checks the run event type in both directions. No test compares the two
vocabulary files directly. A mirror is a maintenance cost, but importing the service’s NodeNext
graph into a browser package would break the boundary.

Tool-display logic no longer has a mirror. It lives once in the Node-free contract package, and
the api-client re-exports it. The former mirror test now runs its shared input table against
that one module.

The workspace packages are currently private source consumers. Extension rewrite settings do
not imply that the api-client is published or that a published dist artifact exists.

## Considered Options

- **Import the service implementation into the browser package.** Rejected to keep its runtime graph free of service and Node dependencies.
- **Trust hand-maintained mirrors.** Rejected; executable parity checks are required.

Implementation: [tsconfig.json](../../packages/api-client/tsconfig.json), [tsconfig.json](../../packages/contract/tsconfig.json), [tool-display.ts](../../packages/contract/src/tool-display.ts), [ui-events.ts](../../packages/api-client/src/protocol/ui-events.ts), [AGENTS.md](../../AGENTS.md).

Coverage: [api-types.test.ts](../../packages/cezar/src/server/api-types.test.ts), [tool-display-mirror.test.ts](../../packages/cezar/src/server/tool-display-mirror.test.ts), [contract-import-boundaries.test.ts](../../packages/cezar/src/contract-import-boundaries.test.ts) and the lint rule it pins, [contract-root-import.ts](../../packages/cezar/src/lint/contract-root-import.ts).
