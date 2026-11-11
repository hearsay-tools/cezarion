# Publish explicit owned file snapshots

Worker attachments and published artifacts are explicit file transfers. Worker parent-file
inputs must be regular bounded files inside the parent worktree, with symlink and descriptor
checks. Artifact publication can snapshot an explicitly selected file outside the project;
it validates the bounded regular source and owns the destination storage, rather than
requiring every source to live in a worktree.

## Consequences

A worker’s copied attachment becomes its own after first launch and must not be overwritten
by Continue. Require its baseline ignore rule before copying and recheck the whole batch;
a failed placement removes only copies made by that call.

Artifact URLs identify the project that owns the run’s storage. When the task has a cockpit
address, the task runner supplies that project’s id in `CEZ_PROJECT_ID` (`agentEnv`). Without
a cockpit address there is no id, and the link stays unscoped. Browser file links
retain the run’s route scope. Publishing produces a snapshot that survives worktree cleanup;
mentioning a source filename does not publish it. These checks do not imply a general sandbox.

Implementation: [cli.ts](../../packages/cezar/src/artifacts/cli.ts), [launch-context.ts](../../packages/cezar/src/workflows/run/launch-context.ts), [context.ts](../../packages/cezar/src/delegation/context.ts), [task-file-scope.tsx](../../packages/web/src/routes/task-thread/task-file-scope.tsx), [store.ts](../../packages/cezar/src/artifacts/store.ts).

Coverage: [cli.test.ts](../../packages/cezar/src/artifacts/cli.test.ts), [context.test.ts](../../packages/cezar/src/delegation/context.test.ts), [store.test.ts](../../packages/cezar/src/artifacts/store.test.ts).
