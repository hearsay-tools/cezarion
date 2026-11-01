# Teardown

A worker that cannot be destroyed holds one of the 32 worker slots and its
worktree. Tear each one down in this order:

1. Wait until `cez worker inspect <id>` shows it settled. Destroying a running
   worker records it `cancelled`.
2. Collect its latest settled revision (`cez worker collect <id>`). Copy any
   report, proof or friction draft out of its worktree first.
3. For an unmerged worker, require an available collected `head.sha`. Before
   changing its worktree, save that SHA under a separate coordinator-owned
   Git ref and its patch/artifact snapshot outside the worker's worktree.
   Record the ref, collected head SHA, snapshot paths and repair owner or
   explicit disposition in campaign state. Verify the ref resolves to the
   collected SHA and the snapshots are readable; a failed checkpoint blocks
   checkout and destruction.
4. In its worktree: `git checkout cez/<id8>` when it switched branch (the
   identity check refuses any other branch), then
   `.ai/scripts/test-env-down.sh` when `.ai/qa/test-env.json` exists, then
   `squeal stop`, guarded with `test -d <worktree>`.
5. Leave `<worktree>/.ai/qa/test-env-lease.sqlite` to `cez worker destroy`. It
   reclaims a lease only when the holder's process and process group have both
   exited (hearsay-tools/cezarion#2161), and keeps the worktree otherwise.
6. `cez worker destroy <id>`. On "worktree mutation lock is busy", retry after
   another worker's spawn or Git operation ends.
7. When destroy still reports that resource identity could not be verified,
   or keeps a lease, find what holds the worktree: a process with its cwd there (`ps`, `/proc`),
   an orphaned `packages/cezar/src/ci-wait/mcp.ts`, or a QA server. Stop only a
   process whose cwd and argv you confirmed belong to that worktree, then retry.
8. Delete remaining local and remote branches only for merged PRs.

Done when `cez worker list` shows the worker destroyed with no remaining
resources.
