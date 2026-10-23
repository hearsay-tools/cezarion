# Share host capacity and retain root execution leases

Parallel and memory limits protect one host across projects. One workspace semaphore reads
cached resource settings and counts every manager. Managers retain their own slot accounting.
When capacity changes, pump managers in priority order and await each pump so a claimed slot
is counted before the next manager checks it.

## Consequences

Wake work has priority over unstarted work, with oldest eligible entries first. An ineligible
entry retains its place without blocking another project. Per-project ceilings also apply.
Configuration refresh updates the cache and pumps managers without restart.

Runs that execute in the repository root take a separate exclusive tree lease. A lease waiter
returns scheduling capacity without presenting a human wait. The holder keeps the tree across
idle turns because its next input can write immediately. Worktree runs can use other slots.

## Considered Options

- **Pump only the manager that released a slot.** Rejected because another project’s queue can remain idle.
- **Release the root lease between turns.** Rejected because a parked session can resume and edit while another run owns the same tree.

Implementation: [semaphore.ts](../../packages/cezar/src/workspace/semaphore.ts), [line-order.ts](../../packages/cezar/src/workflows/line-order.ts), [run.ts](../../packages/cezar/src/workflows/run.ts).

Coverage: [workspace-semaphore.test.ts](../../packages/cezar/src/workflows/workspace-semaphore.test.ts), [run-lease.test.ts](../../packages/cezar/src/workflows/run-lease.test.ts).
