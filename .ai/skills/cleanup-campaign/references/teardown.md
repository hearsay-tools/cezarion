# Teardown

A worker that cannot be destroyed holds one of the 32 worker slots and its
worktree. Tear each one down in this order:

1. Wait until `cez worker inspect <id>` shows it settled. Destroying a running
   worker records it `cancelled`.
2. Collect its latest settled revision (`cez worker collect <id>`). Copy any
   report, proof or friction draft out of its worktree first.
3. In its worktree: `git checkout cez/<id8>` when it switched branch (the
   identity check refuses any other branch), then
   `.ai/scripts/test-env-down.sh` when `.ai/qa/test-env.json` exists, then
   `squeal stop`, guarded with `test -d <worktree>`.
4. Delete the dead-pid rows in `<worktree>/.ai/qa/test-env-lease.sqlite`.
   Remove the file when it has 0 rows and no `test-env.json` sits beside it.
5. `cez worker destroy <id>`. On "worktree mutation lock is busy", retry after
   another worker's spawn or Git operation ends.
6. When destroy still reports that resource identity could not be verified,
   find what holds the worktree: a process with its cwd there (`ps`, `/proc`),
   an orphaned `packages/cezar/src/ci-wait/mcp.ts`, or a QA server. Stop only a
   process whose cwd and argv you confirmed belong to that worktree, then retry.
7. Delete the merged PR's local and remote branch.

Done when `cez worker list` shows the worker destroyed with no remaining
resources.
