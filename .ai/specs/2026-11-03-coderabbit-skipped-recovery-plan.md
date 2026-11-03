# Admit the trusted CodeRabbit no-files decision

Proof base: `666efc213`. Parent owns integration, review, push, CI and landing.
No push or GitHub write belongs to this worker.

## Policy and replaced guarantee

The old gate required successful model execution on the exact live head, except
for verified release/upstream exceptions. It blocked every skipped execution.
The owner explicitly replaces that guarantee: the newest trusted provider check
may instead report completed/skipped with exact authenticated `output.title`
`No files to review`. That decision admits without prior successful execution.
It is a provider no-files decision; it does not prove that a model ran.

Trust remains App `347564`, slug `coderabbitai`, check name `CodeRabbit`, on the
exact live PR head. Success still admits. Every review thread, from any author,
including outdated threads, must be resolved. All other provider states block.
Keep complete bounded pagination, provider/head rereads, title fingerprint,
verified exceptions, native provenance, readiness, queue membership and rules.

Remove the unproven automatic full-review comment and claim mechanism entirely,
including its modules, tests, `recoveryEligible` field, sender token, optional
secret reads and checks-write permission. Restore targeted native-gate reruns
and read-only checks permission, with a new policy marker to reject old
success-only jobs. No model request or new
credential dependency remains. Classification and actionable blocker guidance stay.

## Incident evidence

In hearsay-tools/cezarion#2562, reviewed head
`05fc3da1436ec640ddac8ae38cffed64c342332f` had successful check `125872793369`.
Rebased head `5be277591c9f908ed44982d0115012e20e116091` had skipped check
`125896576467` with exact title `No files to review`. Both PR patches had
11 files, 207 insertions and 78 deletions, with SHA-256
`e62124dddc162cc6b6bc35adfc4176ce6be877c02f2bdab1c2e052807441d625`.
The parent supplied this investigation. Content equality explains the owner's
policy choice; patch equality and historical success are not runtime requirements.

## Admission cases at shipped defaults

| Case | Result | Next trigger / action |
| --- | --- | --- |
| Newest trusted completed/success, no open threads | Admit | Existing native rerun/readiness |
| Newest trusted completed/skipped, exact no-files title, no open threads | Admit without prior success | Existing native rerun/readiness |
| Either accepted provider decision with an open or outdated open thread | Block | Resolve threads; dispatch for manual thread changes |
| Missing, queued or in-progress provider | Block | Provider/CI event or provider repair |
| Other skip title, absent title, rate/draft skip, neutral, failure, cancelled, timed-out, action-required, stale or unknown | Block | Provider repair or explicit human request |
| Older accepted check with newer blocking trusted check | Block | Newest trusted decision must qualify |
| Wrong App ID, slug or name | Ignore untrusted evidence | Trusted provider must supply evidence |
| Stale provider head, changed live head/base/title/check, malformed/incomplete pages | Fail closed | Fresh validated evidence |
| Verified release/upstream exception | Existing admission with resolved threads | Existing exception flow |
| Fork, closed PR or non-main target | Existing eligibility restrictions | Maintainer action; no automated fork rerun |
| Duplicate events / same admission outcome | Existing targeted rerun/no-op | No comments, claims or model requests |

## Validation and reader sweep

Before changing test outcomes, record that strict success-only execution is the
replaced guarantee above. Prove the admission regression red against the proof
base in a disposable scratch tree, then green by copying only fixed source.
Run focused Squeal checks and complete bundled changed-function quality against
the pinned main baseline. Run lint, actionlint, citations and diff checks.
No package declarations change; full gates and hosted rollout evidence belong
to the parent and CI.

Sweep both old and new terms across scripts, tests, workflows, active CI docs,
SDLC, CODE_REVIEW and AGENTS. Remove recovery-only readers and update active
success-only promises. The earlier admission plan keeps historical evidence with
a pointer to this policy. Do not claim local fixtures prove hosted delivery or
GitHub rerun scheduling.

## Rollout boundary and marker sweep

Use only `Require fresh CodeRabbit admission and resolved threads` as the current
native gate marker. The old `Require fresh CodeRabbit execution and resolved threads`
marker is legacy. Installed CI runs check out immutable `github.sha`; rerunning an
old job retains its success-only reader. Accepting it as current would repeatedly
rerun a failed no-files gate until the attempt cap. Refuse it without a POST and
instruct a fresh native run after rollout. Never accept both markers as equivalent.

Update all marker readers: ci.yml, reconcile GATE_STEP, coderabbit.testkit and
workflow contract tests. Keep the old marker only in the explicit legacy refusal
regression and this explanation. The existing admission plan is historical.
CODE_REVIEW delegates policy to the CI guide and needs no copy change.

| Native gate / provider decision | Action | Exit |
| --- | --- | --- |
| Old execution marker / trusted no-files / native failure | Legacy refusal, no POST | Push new head or start fresh native run after rollout |
| New admission marker / trusted no-files / native failure | Exactly one targeted rerun | Native job completion |
| New admission marker / trusted no-files / native success | No-op | Future evidence change |
| No marker or former reusable model workflow | Existing legacy refusal | Fresh native run |

## Regression evidence

Disposable worktree at `proof_base=666efc21312a64ec39629546fe33082e1fdff779`,
with its own `pnpm install --frozen-lockfile`. Copy current tests and testkit;
keep product source at the proof base. Run:

```sh
node --import ./scripts/test-git-env.mjs --test --test-name-pattern='authenticated no-files skip' .github/scripts/coderabbit-admission.test.cjs
```

Baseline: **1 intended assertion failure**, `false !== true` at admission assertion,
0 pass, 0 skipped. Copy only fixed `coderabbit-admission.cjs`: **1 pass**, 0 fail,
0 skipped. This proves the policy change without needing prior success.

Keep that fixed reader and the same tests; leave baseline `coderabbit-reconcile.cjs`:

```sh
node --import ./scripts/test-git-env.mjs --test --test-name-pattern='old execution-only native gate|trusted no-files decision refreshes' .github/scripts/coderabbit-reconcile.test.cjs
```

Baseline reconciler: **2 intended assertion failures**, 0 pass, 0 skipped.
The old marker requests a rerun instead of returning `legacy-workflow`; the new
marker returns `legacy-workflow` instead of requesting the rerun. Copy only fixed
`coderabbit-reconcile.cjs`: **2 pass**, 0 fail, 0 skipped. Fixed assertions prove
old-marker no POST and new-marker one targeted native rerun. No setup, import,
timeout or empty-selection failure counts as proof. Scratch worktree removed.

## Final local validation

- Parent source review found no required code correction. The marker change fixes
  the parent's concrete historical-reader retry finding before integration.
- Complete bundled quality against the proof base: **39/39 changed functions**
  across eight JavaScript/test files pass. Maximum complexity **14**; maximum CRAP
  **14.006579168205162**. Coverage execution: **242 tests pass**, 0 fail, 0 skipped.
  Test callbacks are included; this is the bundled fallback because Squeal does
  not measure every changed test function. Reproduction:

```sh
node .ai/skills/check-code-quality/scripts/check.mjs --base 666efc213 --runner node --node-import scripts/test-git-env.mjs --test .github/scripts/coderabbit-admission.test.cjs --test .github/scripts/coderabbit-reconcile.test.cjs --test .github/scripts/coderabbit.workflow.test.cjs --test .github/scripts/pr-readiness.test.cjs --test .github/scripts/merge-queue-admission.test.cjs --output .ai/qa/coderabbit-no-files/code-quality.md
```

- Squeal revision **7**: the five selected test files have current results and no
  known failures. At capture, 151 of 1225 test files and 428 tests remained
  queued. This is focused validation, not a full-suite claim. Final global/slow
  accounting is reported to the parent separately.
- `npm run lint`: all 10 cez and 16 ast-grep rules pass.
- `node .github/scripts/check-citations.cjs` and `git diff --check`: pass.
- actionlint **1.7.12** passes `ci.yml` and `coderabbit-reconcile.yml` with
  `-shellcheck= -pyflakes=`; no shell blocks changed. Archive SHA-256 verified as
  `8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8`.
- No package source or declarations change, so typecheck is not required here.
  Full CI and hosted rollout validation belong to the parent. Local fixtures do
  not prove provider event delivery, hosted rerun scheduling or queue semantics.
- Reader sweep covers the two gate markers, recovery field/modules/token steps,
  native/workflow fixtures, readiness, queue, AGENTS, SDLC, CI guide and ADR 0038.
  The old execution marker remains only in the explicit legacy test and policy
  explanation. The prior admission plan is explicitly historical. CODE_REVIEW
  points to current policy and retains its distinct validation-suite meaning of
  a permitted skip. Squeal's queued final waits and pinned-version `lint.tools`
  warning are already tracked as hearsay-tools/squeal#139 and
  hearsay-tools/squeal#141, both open with the `friction` label. No duplicate
  issue or GitHub write was made. The live friction template was read.

Published task snapshots (task `df7c01eb-7d72-403d-a626-9654838c9925`):
quality Markdown `eac09ea5-1d6f-4520-8b71-a022825db056`, quality JSON with all
source hashes `8c759e45-b4aa-4278-a766-017bdbde7016`, and red/green proof
`3fced9e7-dbb1-4358-8380-38b1e77c0908`. All eight measured source hashes match
the final files. `origin/main` resolved to `64d58f93f851ce1be70fa5ba156dd69214cbc1e5`;
its merge-base with this branch is the pinned proof/quality base `666efc213`.
