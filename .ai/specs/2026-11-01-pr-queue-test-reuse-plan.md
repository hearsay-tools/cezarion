# Reuse native PR tests in the serial merge queue

The owner requested implementation on 2026-11-01. Baseline / proof_base:
`e2362df7764e9d46e854dc60d45492b816cdd5b4`.

## Guarantee and design review

The current full queue run ensures the landed combined revision passed all checks.
Keep that guarantee: only the costly Vitest and browser suites may reuse verified
native PR results. Typecheck, citations, complexity, clones, build, Node tests,
packaged CLI tests, classifiers, final aggregate and review admission still run
on the queue commit. They can depend on commit identity, parents or event context.
This changes the workflow test's unconditional-suite expectation; that test pinned
combined-code verification. The replacement pins immutable source identity,
complete native suites, current serial membership, and full fallback.

Resolve PR test checkouts once to an immutable merge commit. For a same-repository
PR whose merge base equals the trusted workflow SHA, require the head to contain
that base and have the same tree as the merge commit. Pin both test matrices to
that head. A read-only workflow job records successful attestation in its name:
`Attest PR test inputs / <workflow SHA> / <PR head SHA>`. It succeeds only after
both full test matrices pass. Names are official Actions metadata, not an
agent-written artifact. Unknown optimization evidence leaves the immutable merge
checkout in use. Missing or moved merge input fails the PR input resolver.

At the queue head, require exactly one queue entry (including hasNextPage=false),
existing native CI/review admission, unchanged main/base/head, that attestation
for the queue base and PR head, all eight successful native suite jobs, and equal
PR-head/queue trees. Re-read membership, main, head and newest run/attempt before
accepting. Bound metadata reads; errors use full queue tests. Matrix jobs remain
real successful jobs, but their steps do only a short reuse receipt. This preserves
the existing exact-queue-SHA proof and main fallback without accepting PR runs as
main-push proof. Failed-job reruns retain historical proof; full reruns refresh it.
The early proof may accept an in-progress native run only after its required
aggregate, review, attestation and eight suites have completed successfully:
optional publication need not finish first. Final merge admission keeps its
existing strict completed-run requirement. An explicit internal admission option
permits the early read only; it changes no default or final merge policy.

## Cases at shipped defaults

| Case | Behavior |
| --- | --- |
| One entry, unchanged base/head, full native suites and matching attestation/tree | Reuse both suites; run fresh commit-dependent checks |
| Main changed, PR behind, different head or different queue tree | Full queue tests |
| More than one queued entry, unknown pagination, wrong or removed entry | Full queue tests |
| Old workflow without attestation, fork, partial/skip/failure/duplicate suite | Full queue tests |
| Newest native run/attempt queued or failed, even with older success | Full queue tests; existing final review admission still applies |
| Dispatch, unrelated workflow/repository, wrong PR association | Cannot supply proof |
| API error, deadline, incomplete metadata, movement during proof | Full queue tests |
| PR merge ref moves before input resolution | Validate the actual immutable parents; changed head fails closed |
| PR input has a newer base than the workflow | Test immutable merge commit; no attestation |
| PR-input optimization lookup fails | Test immutable merge commit; no attestation |
| Queue proof fails or is cancelled | Full queue tests, never a skip |
| Code/test failure in fresh queue checks | Required aggregate fails |
| Main exact queue SHA, successful reused-suite queue jobs | Existing queue-to-main proof remains valid |
| Missing queue proof on main | Existing full main fallback |

Reader sweep: ci.yml and its node workflow tests, merge-queue admission/proof
helpers and tests, review-first tests, CI docs, and this plan. Historical specs
keep their historical decisions. The original native PR full-suite roster and
queue-to-main exact-SHA tests remain guards. Validate source helpers with API
fixtures including races, workflow expressions and executed shell bodies, and a
real-Git equal-tree/different-commit fixture. Run the complete changed-function
quality check, pinned workflow lint, native PR CI, and final-definition bare
dispatch. A bare dispatch cannot prove live merge-group reuse; report that limit.
No queue settings change, queue entry, merge, manual model review, or live probe
is authorized by this implementation step.

## Admission refactor order

Extract only the existing bounded GraphQL closure. Preserve the admission order:
validate group; establish deadline; read rules; read queue; read PR; read workflow;
read newest native run and its required gates; read all review threads; re-read
native run and newest attempt; re-read rules; re-read queue; re-read PR; return.
The existing admission suite pins each refusal and the final rereads. New tests
pin the opt-in early in-progress read and preserve strict final admission.
The unit/browser reader sweep found git history references only in isolated Git
fixtures; source inputs and workflow-defined suite commands remain the same.
Build and citation checks retain fresh commit execution. No runtime product files
or browser specs change.

## Local validation

- Focused bundled node coverage: 241 tests passed; all 135 changed functions
  measured, maximum complexity and CRAP both 18.
- `proof_base` above, command
  `node --test --test-name-pattern='verified queue suites run only a reuse receipt' .github/scripts/pr-test-reuse.workflow.test.cjs`
  in an ignored scratch copy: original workflow fails (full setup/test steps
  remain selected); final workflow passes (only the reuse receipt is selected).
  Parent evidence: `.ai/qa/pr-queue-reuse/regression-proof.json`.
- Real-Git fixture proves separate PR-merge/head/queue-squash identities with the
  same tree and verifies that the resolver pins the attested immutable head.
- actionlint 1.7.12 and shellcheck 0.11.0, both matched CI's pinned SHA-256,
  passed on the workflow. Citations and whitespace checks passed.
- The native PR and final-definition bare dispatch remain the required hosted
  gate. Neither can prove a live merge-group reuse hit before this workflow lands.
