# Review before expensive CI verification

Status: implemented; local proof complete; live GitHub proof remains with parent · Date: 2026-10-29

Implementation base and `proof_base`: `97335b3521fe485c80d40a7d76ceaaa56ec12119`
(fetched `origin/main`). Parent task: `8e233bfe-750b-4b5a-82a1-075d1a3bd19d`.
The owner authorized this timing change. Provider/model selection, severity policy,
merge queue activation, protections and file-length changes are outside scope.

## Guarantees and replacement

The old `review -> needs: verify` edge prevents model expense before failed tests
and gives the model successful full verification evidence. The owner explicitly
replaces that ordering: cheap deterministic checks protect model expense; a
passing eligible review protects heavy test expense. The old independent build/typecheck test expectations protected complete test
inventory and separate failure visibility; they did not require expensive jobs
to start before review. The inventory and final failure checks remain, while
starting heavy work early is deliberately removed. Full verification remains
mandatory before merge through the unchanged required check names. A review pass
is a code-review verdict, not a claim that pending tests passed.

The prior ordering also guaranteed that only test-green heads consumed automated
review rounds. The requested reviewer-before-tests order spends rounds on
preflight-green heads whose tests may later fail. The cap can therefore be
exhausted earlier, and subsequent changes on the final head may receive no new
model review. The owner accepted that tests may break after review; the parent
judges this earlier spending authorized by that explicit request. The cap,
provider and review policy are unchanged. Final-head model review was already
conditional on the cap; this change moves when the existing budget is spent.

Preserve trusted classification, round caps, patch-ID reuse, live-head checks,
provider-specific generation, immutable provider artifact IDs, trusted posting,
queue exact-SHA proof/fallback and publication only after verification. Candidate
code never receives model or publishing credentials. No polling job is added.

## Job graph

For PRs into main:

`classification + policy/complexity/clones + typecheck/static -> preflight -> review -> review-result -> heavy jobs -> verify`

- Add a bounded, credential-free `preflight` aggregate. It requires successful
  classification, the event's applicable ratchets, and typecheck/static checks.
- Move existing workflow lint (pinned actionlint/shellcheck) and citation checking
  from build/package to typecheck. Fetch the merge result and its first parent for citation checking.
- Call the existing reusable review after preflight, with explicit secrets and
  trusted caller preflight evidence. Keep its provider and cap policies.
- Make PR `review-result` independent of `verify` and queue admission. It retains
  the protected `Automated Code Review` name only for native PRs into main.
- Heavy build/package, Vitest and browser jobs require successful preflight and,
  for native PRs into main, successful `review-result`. Use explicit status
  functions so intentional skipped ancestors do not silently skip required jobs.
- `verify` requires preflight, the applicable PR review result, and all existing
  verification results. A blocked review, cancellation, or unexplained heavy skip
  fails the aggregate. Keep its protected name.
- Keep queue admission after `verify`. Give the queue its own result job with the
  protected review name only on `merge_group`; inactive jobs have distinct names.
  Thus queue admission cannot make a PR review wait for its own heavy jobs.
- Main exact queue proof may skip typecheck and heavy work as today; preflight
  accepts that skip only with the same successful proof. No new skip class.

## Preflight inventory and cost

| Check | Placement and permissions | Cost/coverage |
| --- | --- | --- |
| Surface and bot release classification | Existing trusted base jobs, read only | Git/API metadata; same fail-closed allowlists |
| Baseline growth | Existing classify-pr step, trusted code/head as data | No product suites |
| Complexity and clones | Existing jobs, trusted tooling, ignore install scripts | Bounded 10-minute jobs; scan source, no product suites |
| Workflow lint and citations | Move to existing typecheck job, read only | Pinned tools; candidate workflows are data for lint |
| Typecheck | Existing minimum-Node job, read only, no secrets | Existing docs report one 54-second hosted sample; not a latency guarantee |
| Preflight aggregate | New bounded shell gate, no permissions | Result checks only |

The current typecheck command's web pretypecheck builds server declarations and
runs server postbuild inlining. Preserve this existing preparation; it does not
run full application/Vite build, tests, tarball checking, or packaged E2E. No
full build or test command becomes a hidden review prerequisite. Full build,
Node tests, packing, three Vitest shards and four browser shards stay heavy.

## Review context and retry behavior

Native calls pass the trusted `needs.preflight.result` and caller run/attempt
identity into the reusable workflow. The context renderer validates this input,
names the head and provenance, and explicitly states that heavy verification is
pending behind review. It does not search for an earlier successful CI run or
wait for heavy tests. Model instructions read this as preflight evidence only.

Manual review dispatch still judges replies outside the cap. Its context reads
the newest native run for the requested current head and its latest attempt;
missing, pending, failed or cancelled verification stays exactly that. No legacy
or earlier-attempt success fallback may turn absence into success. API failure
remains failure. Keep `pickPullRequestRun` compatibility for its independent
snapshot-publishing caller unless a specific tested change is necessary.

An unchanged patch keeps the existing eligible review reuse and fresh thread
count. New content is reviewed before heavy tests, subject to the existing round
cap and approved skip policy. Test-only retries within one run retain successful
review and successful heavy jobs; Re-run failed jobs runs failed heavy jobs and
final aggregation. For blocked review findings, manual rejudgement (if needed)
then Review / review-round recounts; those blocked runs have no successful heavy
jobs to rerun. Document that choosing to rerun a successful upstream review job
can rerun dependent jobs: use the failed-job route for a test failure. No new
model call or repost is needed merely to retry tests.

## Cases at shipped defaults

| Event/case | Review and heavy behavior | Required outcome |
| --- | --- | --- |
| Main PR, preflight fails | No model; no heavy jobs | Both required checks fail |
| Main PR, new/open findings | Post findings, fail review; no heavy jobs | Both checks fail |
| Main PR, review passes | Start required heavy jobs | Review green; verify waits for all tests |
| Review passes, test fails | Retain review; retry failed jobs only | Verify fails until tests pass |
| Unchanged patch/new head | Existing patch-ID reuse; recount threads and check live head | Heavy only after eligible passing review |
| Manual resolution/rejudgement | Recount blocked native review; manual model remains separate | Native current-head review required before heavy |
| Round cap reached | No model/post; count open threads under existing policy | Open threads block; zero permits heavy |
| Model/permission/API/validation failure | Fail selected review path | No heavy; no green aggregate |
| Cancellation | Never release heavy or post new findings after cancellation | Required gates cannot succeed from cancelled work |
| Head changes before posting or release | Live-head checks reject stale result; concurrency cancels old run | New head needs its own current gates |
| Docs/infra main PR | Trusted skip of model, count open threads; typecheck/build/package still run | Vitest/browser skips only under existing allowlists |
| Verified release bump | Existing bot/file predicate; no model, required typecheck/build/package | Existing permitted Vitest/browser skips |
| App upstream scan | Existing author/file predicate skips model | Surface decides heavy inventory; mixed files use full path |
| Fork main PR | Same gates and read-only candidate execution | Missing provider capability fails closed, no credential widening |
| Release maintenance PR | No main-only review | Preflight then existing heavy inventory |
| Bare dispatch | No PR review, no publication | Full matrix and applicable ratchets |
| PR-aware release dispatch | Existing live API attribution and bot rules | Existing required inventory, no synthetic PR review |
| Main push, valid exact queue proof | Existing proof permits skips | Verify cites exact source; publishing still builds pushed SHA |
| Main push, absent/bad proof | Full verification fallback | No review deadlock; publishing requires verify |
| Merge group | Full verification; separate native review admission | Both existing required check names; no model or publication |
| Wrong/missing heavy result | Reject unless explicit existing skip class | Verify fails even when review passed |

No runtime run-state or cross-run relationship changes are introduced.

## Implementation and proof

Update workflow fixture tests to execute conditions and shell gates, not only
assert YAML text. Pin the DAG as acyclic and execute failed/passing preflight,
review, heavy, cancellation and every event route above. Test reuse/posting
provenance, live head, thread counts, exact native caller context, manual pending
context, failed/cancelled current attempt and API failure. Preserve queue,
snapshot and bot classifier regression suites as guard tests.

Use YAML's existing parser for workflow structure. No new hand-written shell or
Markdown reader. Record old guarantees before changing ordering expectations.
Run new behavioral regression against proof_base in a disposable scratch tree
and record expected red, then current fixed green. Do not use shared stash.

Read Squeal's current targeted results for covered node:test files. Run source
syntax checks, actionlint with shellcheck, citation and whitespace checks, and
changed-function quality measurement. The check-code-quality skill applies to
changed JS/test functions; full local product suites are not a substitute for
focused proof. Reader sweep covers ci.yml, reusable review, fetch-ci-results and
callers, prompt, workflow tests, SDLC.md, CODE_REVIEW.md, active CI docs and ADR0038.
Mark the 2026-10-15 spec's timing superseded; keep its historical evidence.

The parent owns live GitHub proof: final-head bare dispatch proves the changed
CI definition but skips review. A controlled native draft PR after rollout must
prove review blocks heavy jobs, passing review releases them, failed-test retry
retains review and successful heavy work, and manual reply rejudgement releases a
blocked run. Record run/attempt/job IDs. Local fixtures do not prove GitHub's
reusable-workflow scheduling/rerun semantics. No paid dispatch or PR from worker.

## Implementation evidence

Parent approved this plan on 2026-10-29 in reply
`a2652f00-d9e6-437a-b791-b00217fb394b` to request
`5fa249c7-cc73-4a13-9b9c-cddf955060de`.

- The graph, conditions and shell gates execute in
  `.github/scripts/review-first.workflow.test.cjs` (17 tests). The approved
  review-before-tests change fails 11 tests at proof_base; 6 unchanged guard
  cases pass. The current implementation passes all 17.
- Baseline proof used an ignored disposable scratch directory containing the
  base versions of both workflows and `automated-review.cjs`, with the new
  regression file and a dependency symlink. Command:
  `node --import <worktree>/scripts/test-git-env.mjs --test <scratch>/.github/scripts/review-first.workflow.test.cjs`.
  Exit 1 at proof_base; failures include heavy work starting on failed review,
  the reversed dependency edge, absent preflight and stale skipped-round head.
  No stash was used. Full output is `.ai/qa/review-first/proof-base.log`.
- The bundled quality command runs the eight changed Node test files with
  `--runner node --node-import scripts/test-git-env.mjs`; 175 tests passed.
  It measured 108/108 changed functions across nine files. Maximum complexity
  and CRAP are both 19; no findings. Reproduction argv and source hashes are in
  `.ai/qa/review-first/code-quality.md`. A durable snapshot is artifact
  `53bd9c6a-09ea-4b8f-ad95-2443c60f58ed` on task
  `2b21ccbb-148c-477f-9652-1bee5d0f0445`.
- Pinned actionlint 1.7.12 and shellcheck 0.11.0 pass over all workflows.
  The downloads used the workflow's SHA-256 checks. `node --check` passes for
  the new context script; citation and whitespace checks pass.
- Squeal's focused 14-file selection was current and had no failures at revision
  9. Final status is recorded in the parent handoff after final edits; the quality
  run above includes the final context source. Product build, typecheck and full
  suites were not duplicated locally for a workflow/helper-only change.

### Provenance detail found against GitHub

Read-only API inspection of native target run `40903818807`, attempt 1, returned
`path: .github/workflows/ci.yml`, branch `cez/2ab6c685`, head
`d6e163fb566808cddcfac1b5cc096e349f8dee62`, and `pull_requests: []`. The live
hearsay-tools/cezarion PR 2206 metadata confirmed that branch/head and main base.
Therefore the context guard uses the trusted caller event plus live PR identity,
and verifies the run's SHA, branch, repository, event, path and current attempt.
It does not require the association list. The fixture includes the empty list
and rejects forged branch/repository metadata.

A native provider retry may retain an already successful preflight prerequisite
from the same immutable run. The caller's `needs.preflight.result` remains its
scheduling authority, and the official latest-job view confirms that retained
success. This is explicit same-run dependency reuse, not fallback to an older
run or arbitrary prior attempt. Manual context reads only the latest attempt's
jobs; absent retained jobs stay pending. Both paths reread run metadata and the
live head around collection and fail on drift or API failure.

### Reader sweep and limits

Updated both workflow DAGs, caller/context checks, prompt CI wording, static-lint
and citation placement fixtures, typecheck fixtures, queue protected-name and
proof inventory fixtures, CODE_REVIEW.md, SDLC.md, docs/sdlc/ci.md and ADR0038.
The old review-inside-CI spec has an explicit supersession note. The standalone
`fetch-ci-results.cjs` API and its snapshot-publishing consumer keep their old
contract; its test commentary now identifies that legacy role. Native review
uses the separate `review-ci-context.cjs` so no prior-success fallback reaches
model work. Existing provider/model, caps, patch IDs, bot classifications,
artifact IDs and posting scopes are unchanged.

Queue proof now requires the new preflight job too; older queue records without
it fall back to full main verification. Queue admission code and all publishing
permissions remain unchanged. Read-only inspection also found its existing
association-list requirement, but queue activation and that separate mechanism
are outside this task.

No live workflow was dispatched and no PR was opened by this worker. The parent
must run the final-head bare dispatch and the controlled native cases described
above. Successful local fixture execution does not prove GitHub rerun selection,
reusable-workflow scheduling or provider authentication on the platform.

### Bounded independent-review fixes

The follow-up uses `proof_base: 610ca4474aa4866bfe8d1350bb1768e42bef37c2`.
Manual context reports `Heavy verification: not started: blocked by review` only
when the current attempt has successful preflight, failed review and aggregate,
and every heavy job is completed/skipped. A skipped matrix must have all expected
shards or its single unexpanded name. Missing jobs, partial matrices, actual heavy
failures, timeouts, cancellations, success and active work keep the existing
verification report. No provenance or workflow gating rule changed.

- Copied the current `review-ci-context.test.cjs` into an ignored temporary
  directory with `review-ci-context.cjs` and `fetch-ci-results.cjs` from proof_base.
  Ran `node --import <worktree>/scripts/test-git-env.mjs --test
  <scratch>/review-ci-context.test.cjs`. Both new blocked-context tests failed on
  the old source: 31 passed, 2 failed, exit 1. Replaced only the context source
  with the fix and repeated the command: 33 passed, 0 failed, exit 0. The genuine
  heavy-outcome guards pass both ways. Logs: `.ai/qa/review-first-fixes/proof-base.log`
  and `proof-fixed.log`; no stash or watched-source swap was used.
- Squeal supplied current passing results for the seven selected context, CI,
  review, typecheck, fetch-results and merge-queue fixture files at revision 4.
  Selection and verdict: `.ai/qa/review-first-fixes/squeal-targeted.log`.
- Squeal excludes test functions from code measurements, so the complete bundled
  quality check measured all 23/23 functions changed since proof_base across two
  files. It passed, with maximum complexity 10 and maximum CRAP 10. Reproduction
  command and hashes: `.ai/qa/review-first-fixes/code-quality.md`.
- Pinned actionlint 1.7.12 with shellcheck 0.11.0 passed over all workflows after
  the checkout edit; both download checksums matched. Source syntax, citation and
  whitespace checks passed.
- Build/package now uses checkout's default depth. Its build, test and pack steps
  do not read the checkout's first parent; Git-history tests use fixture repos.
  The first-parent citation reader and its depth-2 fixture remain in typecheck.
  The stale build/package citation comment was removed with its depth override.
- The plan, CI docs, CODE_REVIEW.md and SDLC.md now name the earlier review-budget
  spending and possible absence of a new model review on subsequent final changes.
  ADR0038 keeps its timing/separation decision and links this plan; it does not
  promise review-round availability, so its text stays unchanged.

Live retry `caller_attempt` and reusable dependent-job rerun behavior remain
rollout limitations for the parent to prove. No push, PR, dispatch, settings
change or full local suite was run for these fixes.
