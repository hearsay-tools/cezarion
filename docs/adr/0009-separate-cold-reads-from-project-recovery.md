# Separate cold history reads from project recovery

Listing tasks across projects must not start those projects’ agents. Cold readers use
read-only database summaries without creating directories, migrating stores, pruning worktrees
or calling recovery. They use legacy JSON only before a completed SQLite import; an unreadable
authoritative database must not expose stale legacy history.

## Consequences

A real project context owns its store, manager and recovery. Contexts build on demand, while
default-on post-listen warm-up also builds eligible registered projects one at a time. Warm-up
can resume work and spend tokens; it skips another live cockpit’s projects and is disabled in
single-project mode or with `CEZ_PROJECT_WARMUP=0`.

Read-only SQLite may still need WAL coordination files. Cezar accepts a permission failure
rather than bypassing them with an immutable connection that could miss live commits.

## Considered Options

- **Open every RunStore to build the index.** Rejected because a history read would gain recovery and mutation side effects.
- **Use SQLite immutable mode for unreadable coordination files.** Rejected because a stale snapshot would look current.

Implementation: [run-index.ts](../../packages/cezar/src/runs/run-index.ts), [project-context.ts](../../packages/cezar/src/server/project-context.ts), [run-database.ts](../../packages/cezar/src/runs/run-database.ts).

Coverage: [run-index.test.ts](../../packages/cezar/src/runs/run-index.test.ts), [project-context-warm.test.ts](../../packages/cezar/src/server/project-context-warm.test.ts).
