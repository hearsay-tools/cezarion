# Cleanup delivery

**Behavior-neutral** means every existing test keeps its expected outcome and
no user sees a difference: API shapes, CLI output, UI and stored state stay the
same. Quote the deciding acceptance criterion before admission. A behavior
question becomes a linked issue; a cleanup PR preserves the existing behavior.
Changing that contract requires a feature plan before dispatch continues.

Measure the issue's named target on current main and after integration: lines,
bytes, complexity or the agreed test-quality metric. For complexity, use
`node .ai/skills/check-code-quality/scripts/metrics.mjs <file> --json`.

## Worker brief

The coordinator pastes this text after the per-issue facts, fills each `<…>`,
and keeps the section for the issue's kind. It replaces dev-flow for cleanup
workers: across 25 PRs of hearsay-tools/cezarion#2051, dev-flow's own steps
caught nothing, and the coordinator's gate does its checks.

```text
Work hearsay-tools/cezarion#<N> to a draft PR with green CI. This brief replaces
dev-flow: load none of dev-flow, plan-issue, implement-issue, run-preflight,
pr-checks or log-friction. This shortcut applies only to approved cleanup work.
The coordinator owns the board, the claim, labels, landing and the friction log.
Coordinator: <run id>. Merge authority: <owner's words, or "The owner merges">.
PR-opening gate: coordinator actual-overlap release check for every ready branch,
even without a predicted hot file. Report a complete committed head and readiness
evidence; request release and
open only after an explicit reply for that head. A changed head or base
invalidates release: request a fresh check under campaign/references/hot-file-release.md.

The change is behavior-neutral: every existing test keeps its expected outcome.
The issue and the facts above are the approved plan. Ask the coordinator, and
wait for the answer, before you change anything the issue does not name. A
behavior question goes to the coordinator; the PR keeps the old behavior.

Work in <2 or 3> committed steps: <step list>. After each commit, send the
coordinator a progress message with the SHA and what it moved or changed.

Before the PR, in this order:
1. Make the change. Grep tests, testkits and browser specs for every name you
   move, rename or remove (CODE_REVIEW.md § Changing working behavior).
2. Read the applicable AGENTS.md area rules. Run npm run typecheck -w @wjarka/cezarion:
   the three tsc configs tsconfig.json, tsconfig.test.json and
   tsconfig.scripts.json. It needs no build.
3. git fetch origin; node .github/scripts/check-clones.cjs --base origin/main
   --head HEAD; node .github/scripts/check-citations.cjs.
4. Read focused test results through Squeal as AGENTS.md says; use
   npm test -- <files> only when no daemon validates, the result is unknown,
   or the repo's own gate requires it. Run the Reader sweep's selected
   packaged checks too; browser specs run in CI.
5. Start check-code-quality's Squeal one-shot path beside the push, as its
   reference says. Require complete evidence for every changed, new or moved
   function, test files included. Bundled metrics are statistics only.
   CI's complexity gate counts a moved function as new when a same-named
   delegator stays behind; tell the coordinator about any function over 20.
6. <kind section below>
Read auto-merge before opening the PR. The campaign's owner-merge control
requires owner review; leave automatic merging off in that case. Workers
leave the merge action to the coordinator/owner under the recorded authority.
Run git fetch origin main, then npm run prepr before the push; it covers steps 2 and 3. Repeat the steps
after any later code change. Leave full suites to Squeal and CI. Missing or
incomplete one-shot evidence blocks the merge; there is no bundled fallback.

PR: git push, then gh pr create --draft --base main. Title in Conventional
Commits, for example refactor(<area>): <what moved>. Write the body in
.ai/qa/<N>/pr-body.md with: Closes hearsay-tools/cezarion#<N>; Summary (at most
3 sentences); Changed names (against the issue's list, and the reason for every
extra); Seams kept (each with the test that needs it); Orders preserved (for any
non-verbatim change); Verification (command and result lines); Left undone (or
"Nothing"); Merge authority (copy the authority above).

After the PR: send the coordinator a progress message (PR, head SHA, changed
names, length pins, out-of-scope findings) and register one PR wait. Fix a red
check that your change caused, repeat the checks and push. Report a red check
you did not cause and wait. Fix in-scope review threads; answer the others with
a reason. Rebase onto origin/main only when the coordinator says so, then push
with --force-with-lease. When the required checks are green and no thread is
open, send the same progress message and finish the worker with cezar_done.

The coordinator owns landing, board and label changes, issue comments and
friction posts. pr-readiness.yml alone changes draft state. Put each friction
finding in your final message as one line. Print config keys and paths only,
never their values.
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
   For a risky PR (one that splits or merges functions, changes call order,
   shares code between two paths, or changes tests), CI's Vitest shards give
   the parity results. Run npm run test:parity only to debug a parity failure.
   Say in Verification which case applies.
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

## Kind: mutation

```text
6. Start each measurement with the job start command that the cezar_wait
   tool description names, and wait for it with a process wait; never with
   &, nohup or a background tool.
   Start the baseline measurement with --out <baseline.json>. While it runs,
   write tests from the issue's FAIL lines; do not wait idle for the baseline.
   mutants-file.cjs measures the committed HEAD: commit the tests before the
   final measurement. Start the final run with --out <final.json> independently
   of the baseline. Once both finish, run:
   node .github/scripts/mutants-file.cjs --compare-results <baseline.json> <final.json>
   Cite the final result's PASS lines and the measured HEAD in the PR.
   Progress appears every 30 seconds; an unknown count means preparation or
   the initial test run has not produced a mutation plan yet.
   To recount saved outcomes with current counting, targets and equivalents:
   node .github/scripts/mutants-file.cjs --rescore <final.json> --out <rescored.json>
   Rescore requires scoring evidence from the current command; older stored
   results remain comparable but need a new measurement for exact rescoring.
   A rescore does not rerun tests or prove the current HEAD passes.
```
