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
and read-only checks permission. The new policy marker prevents promotion
through old success-only jobs. No model request or new credential dependency remains. Classification and actionable blocker guidance stay.

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

The new `Require fresh CodeRabbit admission and resolved threads` marker is
required for promotion. The historical `Require fresh CodeRabbit execution and
resolved threads` marker supports revocation only. Installed CI runs check out
immutable `github.sha`; rerunning an old job retains its success-only reader.
Never promote a failed old job under the new no-files policy: it would fail again
and repeat until the attempt cap. A fresh admitted decision on an old green job
is a no-op. A validated rejection by both policies can revoke an old green job.
The older reusable `automated-code-review.yml` model workflow remains refused in
every direction; reconciliation never requests a model.

### Corrected guarantee before changing tests (finding 4458439516)

Proof base for this follow-up: `2244dd8e7`. The new-only marker previously stopped
retry loops, but also removed the old green gate's path to revoke admission after
threads reopened or provider evidence became pending/failed. Restore that existing
revocation guarantee with directional compatibility, keeping promotion exclusive
to the new marker. No setting or credential changes.

Read the live native run/job after the PR lock, classify its policy, and allow an
old execution-only job only while its native result is green. Read fresh validated
shared admission twice. Only false admission can request its targeted revocation.
A historical reader error cannot prove a shared policy rejection and makes no POST;
current-policy reader errors retain existing fail-closed green revocation. Recheck
native identity, policy, job and live head before the one POST, then observe the
accepted attempt under the existing 120-second budget and per-PR serialization.

| Native gate / live admission | Action | Exit |
| --- | --- | --- |
| Current admission marker / failed / admitted (including no-files) | One targeted rerun to green | Native completion |
| Current admission marker / green / rejected | One targeted revocation | Native completion |
| Historical execution marker / green / success or no-files admitted | No-op | Future provider/thread change |
| Historical execution marker / green / unresolved thread (outdated included) | One targeted revocation | Old job fails on the unresolved thread |
| Historical execution marker / green / pending, latest failure, generic skip or other validated shared rejection | One targeted revocation | Old success-only reader also rejects |
| Historical execution marker / failed / no-files or any other evidence | Legacy refusal with fresh-native-run guidance; no POST | Fresh native run after rollout |
| Historical execution marker / green / admission read fails or changes | No POST | Fresh validated evidence or native run |
| Historical green revoked, then provider reports no-files | Failed old gate remains legacy; no POST | Fresh native run; no retry loop |
| Former reusable model workflow, even if a native marker appears | Legacy refusal; no POST | Fresh native run |
| Marker, native run/attempt/job, provider/head or admission changes before POST | Existing changed/unavailable refusal | Fresh event/manual dispatch |

Marker readers are `ci.yml`, reconcile policy classification, `coderabbit.testkit`
and workflow contract tests. Keep the new marker in native fixtures. Keep the old
marker only in the compatibility classifier, dedicated directional tests and this
explanation. CODE_REVIEW delegates policy to the CI guide and needs no copy change.

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
The failed old-marker case requests a rerun instead of returning `legacy-workflow`; the new
marker returns `legacy-workflow` instead of requesting the rerun. Copy only fixed
`coderabbit-reconcile.cjs`: **2 pass**, 0 fail, 0 skipped. Fixed assertions prove
failed old-marker no POST and new-marker one targeted native rerun. No setup, import,
timeout or empty-selection failure counts as proof. Scratch worktree removed.

## Initial implementation validation (2244dd8e7)

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
  At that revision the old execution marker remains only in the explicit legacy test and policy
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

## Directional compatibility validation (finding 4458439516)

The parent and its native reviewer accepted the corrected source at SHA-256
`4d976a09a5883b8ba1744c940ecf2fb7eca3fed34c0ec49204313eaa2eaf0dec`.
No unrelated package tests or runtime files changed.

A disposable worktree at `2244dd8e75f89f0b8d5d6f2b78eb2788512e5157` had its own
`pnpm install --frozen-lockfile`. Copy only the current reconciliation test, then run:

```sh
node --import ./scripts/test-git-env.mjs --test --test-name-pattern='historical green is revoked for' .github/scripts/coderabbit-reconcile.test.cjs
```

Baseline: **7 intended assertion failures**, 0 pass, 0 skipped. Each records no
native rerun POST (`actual: []`) instead of the expected one job ID (`[30]`). The
cases are reopened threads, outdated reopened threads, pending provider, latest
provider failure, generic skip, missing provider and untrusted provider. Copy
only fixed `coderabbit-reconcile.cjs` and repeat: **7 pass**, 0 fail, 0 skipped.
Each now records exactly one targeted native rerun and four provider reads.

The fixed scratch also passes the three directional promotion/loop guards:

```sh
node --import ./scripts/test-git-env.mjs --test --test-name-pattern='failed old execution-only native gate|trusted no-files decision refreshes|historical revocation followed by no-files' .github/scripts/coderabbit-reconcile.test.cjs
```

**3 pass**, 0 fail, 0 skipped: failed historical/no-files makes no POST, failed
current/no-files makes one POST, and a revoked old job remains refused after a
later no-files decision. Scratch worktree removed after preserving output.

The complete main-base bundled check uses the same five-file command recorded
above, with output `.ai/qa/coderabbit-directional/code-quality.md`: **65/65 changed
functions** across eight files pass. Maximum complexity **18**; maximum CRAP
**18.0098876953125**. Its focused coverage run passes **262 tests**, 0 fail, 0
skipped, including historical/current read-error direction, native policy/run/
attempt/job/head races, model-workflow refusal and admitted historical no-ops.
All eight measured source hashes match the final files. Main's merge-base remains
`666efc21312a64ec39629546fe33082e1fdff779`.

`npm run lint` passes all 10 cez and 16 ast-grep rules. Citations and diff checks
pass. Verified actionlint 1.7.12 passes both review workflows with the same flags
recorded above; no workflow source changes in this follow-up. No declarations
change, so typecheck remains outside this patch. Full CI remains parent-owned.
Squeal's focused five-file results are current with no known failures; final
revision/global/slow accounting is reported to the parent at settlement. No
full-suite pass is inferred. Existing Squeal friction remains tracked in
hearsay-tools/squeal#139 and hearsay-tools/squeal#141; no duplicate or GitHub write.

Published follow-up snapshots, same task: quality Markdown
`34c0ccdf-d9dc-4d96-92ea-54569efba879`, full quality JSON
`f1edbbc0-edff-4037-b40c-d45ea3acc74a`, and regression proof
`5528826c-6888-494f-9164-76f79eec48b6`.
