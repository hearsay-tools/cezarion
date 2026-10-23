# Infer HTTP types from validated route families

The Node-free contract package defines request and response schemas and infers their types.
Hono route families chain registrations so the resulting AppType retains every route. Validate
bodies, params and queries as middleware; parsing inside a handler cannot describe the typed
client’s input.

## Consequences

Every public route is under `/api/v1`. Contracts must match emitted JSON, including omitted
keys and discriminated variants. Storage schemas may preserve unknown keys; public wire schemas
describe the fields the route actually sends. Bidirectional parity checks detect named-field drift.

The JSON middleware preserves the API’s JSON error shape and distinguishes absent from malformed
bodies according to route policy. Client helpers select all successful JSON branches, including
201, and make a text-only route a type error instead of silently returning `never`.

## Considered Options

- **Loose route registrations and handler-local parsing.** Rejected because they discard route or input inference.
- **Use the stock JSON validation boundary unchanged.** The custom wrapper preserves existing absent-body, malformed-body and content-type behavior.

Implementation: [app-type.ts](../../packages/cezar/src/server/app-type.ts), [validators.ts](../../packages/cezar/src/server/validators.ts), [client.ts](../../packages/api-client/src/client.ts), [projects.ts](../../packages/contract/src/projects.ts).

Coverage: [typed-bodies.test.ts](../../packages/cezar/src/server/typed-bodies.test.ts), [versioned-surface.test.ts](../../packages/cezar/src/server/versioned-surface.test.ts), [contract-parity.test.ts](../../packages/cezar/src/server/contract-parity.test.ts).
