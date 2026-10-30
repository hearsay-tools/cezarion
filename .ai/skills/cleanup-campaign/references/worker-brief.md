# Worker brief

The coordinator pastes this text after the per-issue facts, fills each `<…>`,
and keeps the section for the issue's kind. It replaces dev-flow for campaign
workers: across 25 PRs of epic 2051, dev-flow's own steps caught nothing, and
the coordinator's gate does its checks.

```text
Work hearsay-tools/cezarion#<N> to a draft PR with green CI. This brief replaces
dev-flow: load none of dev-flow, plan-issue, implement-issue, run-preflight,
pr-checks or log-friction. The coordinator owns the board, the claim, labels,
merging and the friction log.

The change is behavior-neutral: every existing test keeps its expected outcome.
The issue and the facts above are the approved plan. Ask the coordinator, and
wait for the answer, before you change anything the issue does not name. A
behavior question goes to the coordinator; the PR keeps the old behavior.

Work in <2 or 3> committed steps: <step list>. After each commit, send the
coordinator a progress message with the SHA and what it moved or changed.

Before the PR, in this order:
1. Make the change. Grep tests, testkits and browser specs for every name you
   move, rename or remove (AGENTS.md § Reader sweep).
2. npm run build -w @wjarka/cezarion once, then from packages/cezar the three
   tsc configs: tsconfig.json, tsconfig.test.json, tsconfig.scripts.json.
3. git fetch origin; node .github/scripts/check-clones.cjs --base origin/main
   --head HEAD; node .github/scripts/check-citations.cjs.
4. Focused tests for the changed code: npm test -- <files>.
5. Measure every changed, new or moved function, test files included:
   node .ai/skills/check-code-quality/scripts/metrics.mjs <file> --json.
   CI's complexity gate counts a moved function as new when a same-named
   delegator stays behind; tell the coordinator about any function over 20
   before you push.
6. <kind section below>
Repeat steps 2 to 5 after any later code change, and step 3 before every push.
Leave the local code-quality check (check.mjs) and full suites to Squeal and CI.

PR: git push, then gh pr create --draft --base main. Title in Conventional
Commits, for example refactor(<area>): <what moved>. Write the body in
.ai/qa/<N>/pr-body.md with: Closes hearsay-tools/cezarion#<N>; Summary (at most
3 sentences); Changed names (against the issue's list, and the reason for every
extra); Seams kept (each with the test that needs it); Orders preserved (for any
non-verbatim change); Verification (command and result lines); Left undone (or
"Nothing"); "The coordinator merges this PR."

After the PR: send the coordinator a progress message (PR, head SHA, changed
names, length pins, out-of-scope findings) and register one PR wait. Fix a red
check that your change caused, repeat the checks and push. Report a red check
you did not cause and wait. Fix in-scope review threads; answer the others with
a reason. Rebase onto origin/main only when the coordinator says so, then push
with --force-with-lease. When the required checks are green and no thread is
open, send the same progress message and end your final message with a line
that says only CEZ:DONE.

The coordinator alone runs gh pr merge, gh pr ready, board and label changes,
issue comments and friction posts. Put each friction finding in your final
message as one line. Print config keys and paths only, never their values.
Keep your branch: stay on cez/<your 8-char id>, and keep your handoff current.
At the end: git checkout cez/<your 8-char id>; squeal stop in this worktree;
.ai/scripts/test-env-down.sh when .ai/qa/test-env.json exists.
```

## Kind: move or refactor

```text
6. Move code verbatim: same bodies, same comments, same order. Keep every
   delegator, getter and manager-routed call that the issue names, because tests
   spy on or wrap them. Reach module internals in tests through the existing
   internals testkit; a `as unknown as` cast to reach private members breaks
   silently on the next move.
   Run the parity suites locally only for a risky PR: one that splits or merges
   functions, changes call order, shares code between two paths, or changes
   tests. Use npm test -- packages/cezar/src/core/*-parity.test.ts
   packages/cezar/src/workflows/*-parity.test.ts (about 6 minutes). A verbatim
   move relies on CI's Vitest shards. Say which case applies in Verification.
   A changed or added test or guard needs the regression proof in
   docs/sdlc/regression-proof.md; record the command in the PR body.
```

## Kind: complexity split

```text
6. Bring each named function to complexity 20 or less and CRAP 30 or less, and
   keep the side-effect order of every branch. List each extracted helper with
   its measured complexity in the PR body. When a split changes call order, list
   the old and new order and run the parity suites as for a risky refactor.
```

## Kind: flaky test

```text
6. Start from evidence: the failure bundle under .ai/qa/failures/ or a local
   reproduction. Fix the test's wait or fixture, and keep every assertion and
   its timeout bound. Prove it: the reproduction fails on the pre-fix commit and
   passes on yours (docs/sdlc/regression-proof.md). Put the evidence in the PR
   body in the form of packages/web/e2e/README.md § The rules the ratchet
   enforces. Check the load average before any CPU burner and stop the burners
   after the run.
```
