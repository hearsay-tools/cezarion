# Scope API paths and query keys together

One framework-neutral module builds versioned project paths and holds the active API scope.
The routed provider is its writer. Query keys read the same scope at access time, so requests
and cached results agree on project identity. All keys for a project share a hierarchy for
reconciliation and invalidation.

## Consequences

The provider writes scope during render before children derive keys, then manages lifetime
cleanup separately from project changes. A project switch must not reset scope between render
and the arriving subtree’s effects. Unmount restores the boot scope.

The server registers each project family once and mounts scoped and boot aliases over the
same handlers. Task file links use the run’s route owner rather than a possibly changing viewer
scope. A runtime API base setter supports embedding without coupling the client to Vite.

## Considered Options

- **Thread a React context through every plain client call.** The module-level scope keeps the client framework-neutral, at the cost of one active scope writer per app.
- **Set scope only in an effect.** Rejected because initial query keys and requests would already use the previous scope.

Implementation: [project-scope.ts](../../packages/api-client/src/utils/project-scope.ts), [project-scope-context.tsx](../../packages/web/src/api/project-scope-context.tsx), [queries.ts](../../packages/web/src/api/queries.ts), [task-file-scope.tsx](../../packages/web/src/routes/task-thread/task-file-scope.tsx), [client.ts](../../packages/web/src/api/client.ts).

Coverage: [project-scope-context.test.tsx](../../packages/web/src/api/project-scope-context.test.tsx), [task-file-scope.test.tsx](../../packages/web/src/routes/task-thread/task-file-scope.test.tsx).
