# Kill the surviving mutants in the 33 flagged files

Epic hearsay-tools/cezarion#2280. The owner approved the plan on 2026-10-30. Baseline: a
whole-file Stryker run on `main` at `dd4551617`.

The pull request job (`.github/workflows/mutation-report.yml`) mutates only changed lines, and it
skips the server package in most pull requests. From 26 to 30 October its reports flagged
mutants in 36 files. Stryker then mutated 33 of them in full. It left out
`server/server.ts`, `index.ts` and `routes/tasks-overview.tsx`: they are large and the reports
found few mutants in them. The run tested 9,851 mutants and found 2,994 undetected ones,
a score of 69.6%: 2,410 survived and 584 sit on lines that no test runs.

This spec says what each pull request of the arc must reach and how it proves it.

## Decisions

1. **Targets by risk.** Each file belongs to one tier.
   - **Guard functions**, named below, delete, approve, start or refuse work. Every mutant in
     them is killed or named as equivalent.
   - **Other logic** (every non-JSX file): no mutant on a line that no test runs, and a score of
     at least 85% for the file.
   - **Components** (`.tsx` files under `packages/web`): a score of at least 75%. Text and
     class-name mutants do not count, neither in the score nor in the list of survivors.
2. **Equivalent mutants.** An equivalent mutant changes the code but not the behavior, so no test
   can kill it. The worker first removes the redundant code that makes it equivalent, in its own
   behavior-neutral commit. A mutant that stays goes into `.github/mutants/equivalent.json`: file,
   function, mutator, original text, replacement and a one-line reason, without line numbers. The
   whole-file command and the pull request job read that list and leave its entries out of their
   reports. The command also reports entries that match no mutant any more, so they get removed.
   Product code gets no Stryker disable comments.
3. **Tests only.** An arc PR adds or changes tests, plus the redundant-code commits of decision 2.
   Every existing test keeps its expected outcome. A survivor that shows a bug gets its own
   issue, linked from the epic, and the PR keeps the old behavior.
4. **The coordinator merges.** Each phase coordinator merges a PR on the cleanup-campaign gate
   when the change is exactly what its issue asked for.

## Measuring a file

Phase 0 adds one command that measures one whole file. Until it merges, use the recipe in
[regression-proof.md](../../docs/sdlc/regression-proof.md) with `--mutate <file>` and no line range.
The command must:

- run in a disposable detached worktree of the committed `HEAD`, never in a worktree that Squeal
  validates, because Stryker edits files in place;
- run the tests of the file's own package that import it, as `mutants-related.mjs` counts them;
- for a `packages/contract` file, also run the server and web test files that import the file
  directly, plus test files the caller names. Other packages import contract sources as
  TypeScript, so their tests can kill contract mutants. At baseline, `tool-display.ts` scored
  54.6% with contract tests alone and 91.3% with five server test files;
- print the file's score, its survivors grouped by function, and each survivor's kind (below);
- leave out the mutants listed in `.github/mutants/equivalent.json`, and report each entry that
  matches no mutant;
- compare against an earlier result of the same command, so a PR shows before and after.

The pull request job (`mutants-report.cjs`) reads the same list and leaves its entries out of the
comment.

### Kinds

| Kind | Mutators | Counts toward the targets |
|---|---|---|
| Condition | `ConditionalExpression`, `LogicalOperator`, `EqualityOperator` other than `<`/`>` swaps, `BooleanLiteral` | Yes |
| Boundary | `EqualityOperator` that swaps `<`, `<=`, `>` or `>=` | Yes |
| Fallback | `OptionalChaining`, `??` swaps | Yes |
| Removed call | `BlockStatement`, `CallExpression`, `ArrowFunction`, `MethodExpression` | Yes |
| Value | Other `StringLiteral`, `ObjectLiteral`, `ArrayDeclaration`, `Regex` | Yes |
| Not covered | Any mutator on a line that no test runs | Yes |
| Text | `StringLiteral` whose original is prose (two or more words) | Only in guard functions |
| Class name | `StringLiteral` of Tailwind classes in a `.tsx` file | No |

## Guard functions

Every mutant in these functions is killed or named as equivalent, whatever the file's tier.

| File | Functions |
|---|---|
| `packages/cezar/src/server/repo-branches.ts` | `deleteBranches`, `deletionVerdicts`, `claimDeletionRuns`, `retainingRef`, `classifyBranches`, `mergedPrBranches`, `recordedPrs` |
| `packages/cezar/src/automations/scheduler.ts` | `ProjectAutomationScheduler.check`, `ProjectAutomationScheduler.launch`, `launchCandidates`, `candidateAcceptor`, `afterBaseline`, `pollWindow` |
| `packages/cezar/src/automations/github-poller.ts` | `matchesFilters`, `GithubPoller.matchesCurrentLabels`, `incompleteHistory` |
| `packages/contract/src/waits.ts` | `workerWaitView`, `computeWaitingOn`, `workerEntryOwed`, `oneModeTakesOneId` |
| `packages/contract/src/delegation.ts` | `parentFileRefusal` |
| `packages/cezar/src/preview/host.ts` | `PreviewHost.stopPreview`, `heldByAnotherTab`, `heldByOther`, `portOwner`, `ownsBrowser`, `sameOrigin` |
| `packages/cezar/src/task-cli/cli.ts` | `validateFlags`, `parseOperation`, `positiveInt`, `nonNegativeInt` |
| `packages/web/src/routes/repo-git/repo-not-landed.tsx` | `DeleteBranchDialog` |

At baseline these survived or were not covered, among others:

- `deleteBranches`: the refusals under the delete lock, for a branch that a delegated workspace
  owns or that a worktree has checked out. No test reaches them.
- `PreviewHost.stopPreview`: the restart approval check. Forcing it to true survives.
- `ProjectAutomationScheduler.check`: the backoff refusal. No test reaches it.
- `candidateAcceptor`: the filter on this automation's receipts that are not released.
- `workerWaitView`: the filter that keeps open and resolved waits. No contract test reaches it.
- `validateFlags`: the refusals of conflicting flags, such as `--until` without `--wait`.

## Rules for an arc PR

- One issue, one file or one function group. The issue names the functions and the tier.
- Before and after: the Phase 0 command on the same file, at the PR's base and at its head. The
  PR body gives both scores and the guard-function survivors before and after. Every equivalent
  mutant the PR accepts is an entry in `.github/mutants/equivalent.json` in the same PR.
- A new test asserts behavior a user or a caller can see: a return value, a stored row, an
  emitted event, a refusal message. It does not assert a private field because a mutant changed
  it.
- A test that reaches a guard under a race (the lock-time refusals of `deleteBranches`, the
  restart re-check of `stopPreview`) uses the product's own seam or a fake dependency, not a
  timing window.
- The usual gates hold: AGENTS.md § Validation, the file-length and ast-grep guards, and the
  clone and citation checks.

## Phases

| Phase | Issue | Files | Undetected at baseline |
|---|---|---|---|
| 0 Tools | Whole-file mutation command and the equivalent-mutant list | `.github/scripts/`, `.github/mutants/` | — |
| 1 Guards and server logic | Branch deletion | `repo-branches.ts`: the deletion functions | 297 (whole file) |
| | Branch classification | `repo-branches.ts`: classification and PR state | |
| | Scheduler | `automations/scheduler.ts` | 141 |
| | GitHub poller | `automations/github-poller.ts` | 104 |
| | Contract waits | `waits.ts`, `delegation.ts`, `conversations.ts`, `attention.ts`, `tool-display.ts` | 247 |
| 2 Preview server | Preview host | `preview/host.ts` | 348 |
| | Session and launch | `preview/session.ts`, `preview/browser-launch.ts` | 145 |
| 3 Task CLI | Flag table and checks | `task-cli/cli.ts`: flag table, `validateFlags`, parsers | 429 (whole file) |
| | Task commands | `task-cli/cli.ts`: `start`, `send`, `execute`, `readStdin` | |
| 4 Web logic | Preview transport | `preview/use-preview-pane-transport.ts` | 207 |
| | Other web logic | `preview-state.ts`, `preview-memory.ts`, `use-search-params-writer.ts`, `conversation-presentation.ts` | 139 |
| 5 Components | Branch list | `repo-not-landed.tsx`, `task-changes.tsx` | 207 |
| | Thread cards | `run-relationships.tsx`, `conversation-card.tsx`, `ask-card.tsx`, `run-waits.tsx` | 353 |
| | Preview views | `preview-pane.tsx`, `preview-toolbar.tsx`, `preview-states.tsx`, `preview-split.tsx`, `task-preview-layout.tsx`, `use-agent-page-live.ts` | 330 |
| | Small files | `application-update-control.tsx`, `counterpart-task.tsx`, `serve-boot.ts`, `open-in-targets.ts` | 47 |

Phase 1 starts after Phase 0 merges. Phases 2 and 3 follow Phase 1. Phase 4 needs only Phase 0 and
can run beside Phases 2 and 3. Phase 5 follows Phase 4. The two branch issues and the two CLI issues
each share one file; they run one after the other.

## Baseline

`main` at `dd4551617`, Stryker 10.1.1, concurrency 8. Survived and not-covered counts include
text and class-name mutants; the low-value column counts them. Contract files merge the
contract-only run with a run of five server test files for `tool-display.ts`,
`conversations.ts` and `delegation.ts`. `serve-boot.ts` changed after the baseline.

| File | Tested | Survived | Not covered | Text and class names | Score |
|---|---|---|---|---|---|
| `packages/cezar/src/task-cli/cli.ts` | 1095 | 361 | 68 | 97 | 60.8% |
| `packages/cezar/src/preview/host.ts` | 1123 | 280 | 68 | 4 | 69.0% |
| `packages/cezar/src/server/repo-branches.ts` | 1047 | 250 | 47 | 5 | 71.6% |
| `packages/web/src/routes/task-thread/preview/use-preview-pane-transport.ts` | 483 | 162 | 45 | 0 | 57.1% |
| `packages/web/src/routes/repo-git/repo-not-landed.tsx` | 346 | 108 | 51 | 14 | 54.0% |
| `packages/contract/src/waits.ts` | 548 | 117 | 29 | 8 | 73.4% |
| `packages/web/src/routes/task-thread/run-relationships.tsx` | 367 | 108 | 38 | 14 | 60.2% |
| `packages/cezar/src/automations/scheduler.ts` | 483 | 117 | 24 | 4 | 70.8% |
| `packages/cezar/src/preview/session.ts` | 368 | 96 | 19 | 0 | 68.8% |
| `packages/cezar/src/automations/github-poller.ts` | 476 | 86 | 18 | 0 | 78.2% |
| `packages/web/src/routes/task-thread/preview/preview-toolbar.tsx` | 229 | 76 | 24 | 1 | 56.3% |
| `packages/web/src/routes/task-thread/preview/preview-states.tsx` | 259 | 75 | 13 | 15 | 66.0% |
| `packages/web/src/routes/task-thread/preview/preview-pane.tsx` | 202 | 71 | 14 | 2 | 57.9% |
| `packages/web/src/routes/task-thread/conversation-card.tsx` | 210 | 68 | 11 | 5 | 62.4% |
| `packages/web/src/routes/task-thread/ask-card.tsx` | 316 | 69 | 8 | 14 | 75.6% |
| `packages/web/src/routes/task-thread/preview/preview-state.ts` | 224 | 65 | 3 | 0 | 69.6% |
| `packages/web/src/routes/task-thread/preview/preview-split.tsx` | 85 | 18 | 35 | 0 | 37.6% |
| `packages/web/src/routes/task-thread/run-waits.tsx` | 295 | 45 | 6 | 2 | 82.7% |
| `packages/web/src/routes/task-git/task-changes.tsx` | 114 | 22 | 26 | 1 | 57.9% |
| `packages/contract/src/delegation.ts` | 148 | 31 | 4 | 2 | 76.4% |
| `packages/web/src/components/application-update-control.tsx` | 176 | 29 | 2 | 4 | 82.4% |
| `packages/cezar/src/preview/browser-launch.ts` | 52 | 21 | 9 | 0 | 42.3% |
| `packages/web/src/routes/task-thread/conversation-presentation.ts` | 135 | 18 | 9 | 0 | 80.0% |
| `packages/contract/src/tool-display.ts` | 289 | 25 | 0 | 0 | 91.3% |
| `packages/web/src/routes/task-thread/preview/preview-memory.ts` | 121 | 25 | 0 | 0 | 79.3% |
| `packages/contract/src/attention.ts` | 258 | 18 | 3 | 0 | 91.9% |
| `packages/contract/src/conversations.ts` | 77 | 12 | 8 | 0 | 74.0% |
| `packages/web/src/lib/use-search-params-writer.ts` | 44 | 19 | 0 | 0 | 56.8% |
| `packages/cezar/src/serve-boot.ts` | 109 | 6 | 2 | 0 | 92.7% |
| `packages/cezar/src/server/open-in-targets.ts` | 111 | 7 | 0 | 1 | 93.7% |
| `packages/web/src/routes/task-thread/preview/task-preview-layout.tsx` | 15 | 2 | 0 | 0 | 86.7% |
| `packages/web/src/routes/task-thread/preview/use-agent-page-live.ts` | 17 | 2 | 0 | 0 | 88.2% |
| `packages/web/src/routes/task-thread/counterpart-task.tsx` | 29 | 1 | 0 | 0 | 96.6% |

The server run took 65 minutes for nine files on this host, 15 of them for the first test run. Plan
one measurement per issue at the base and one at the head.
