# CodeRabbit admission replacement

Approved owner brief, 2026-11-02. Baseline: `190a4d6d57f1d13dc957efa4c24d317543579b27`.

The old flow supplied reviewer execution, open-thread admission, current-head checks,
bounded recovery and capped spend. The installed external CodeRabbit App replaces
execution. A shared deterministic reader replaces admission and current-head checks.
A bounded trusted reconciler replaces manual rejudge/recount. The owner explicitly
removed the spend cap because CodeRabbit is free for this open-source repository.
Automatic review now starts on push, before preflight. Heavy verification still waits
for preflight and the native protected review job. No model commands or PAT fallback.

## Implementation

1. Extract bounded review-thread reads. Add a shared live CodeRabbit reader and verified
   release/upstream exceptions. Require App `347564`, slug `coderabbitai`, name
   `CodeRabbit`, newest execution on the exact head, completed/success and zero open
   threads of any author. Re-read provider and PR before admission. Empty vendor
   `pull_requests` is supported; formal reviews are never execution evidence.
2. Keep protected check names and native CI provenance. Replace the reusable model
   workflow with a read-only native `review-result`. Keep heavy dependencies and queue,
   push reuse, snapshot publication and verified bot skip guarantees.
3. Reconcile genuine provider created/completed events, native CI completion and review
   events. Discover open main PRs and create independent trusted PR jobs; ignore forks, require
   newest native run/attempt and successful preflight. Re-read before rerunning only
   the completed native review job when admission differs. Serialize per discovered PR,
   never retry ambiguous writes. No-op once outcomes agree. Limit to GitHub's 30-day,
   50-attempt rerun window. Manual `pr_number` handles eventless thread reopening and resolution.
4. Readiness proves native protected checks and reads fresh admission, including revoking
   readiness. Queue reads the same admission in addition to its native proof; existing
   fork queue support remains. Add `checks: read` to every affected reader.
5. Enable automatic drafts/incremental review, clear label filtering, disable auto-pause
   with zero. Validate used keys against the live v2 schema. Delete obsolete model
   helpers, tests, prompt and schema after the reader sweep. Keep issue intake and
   `fetch-ci-results` (snapshot consumer).

## Admission cases at shipped defaults

| Case | Result / recovery |
| --- | --- |
| Missing or pending execution | Block; created/completed event or CI completion reconciles |
| Completed/success and every thread resolved | Pass after fresh head/provider read |
| Success with any open thread, including outdated | Block on the next read; review event or manual reopening/resolution dispatch reconciles |
| Skipped, neutral, provider failure | Block; no automatic model request |
| Spoofed App/name, stale head, older success behind newer failure | Block; exact trusted newest execution only |
| Head/provider changes during reads | Block; next genuine event retries reconciliation |
| API errors, malformed/truncated/changing pages, cursor loops | Block with bounded requests; manual retry after repair |
| Verified release stamp or upstream-ledger bot PR | Skip provider only; live complete file/content classifier and all threads still required, native and queue |
| Bot author/branch without verified files | Normal provider gate |
| Provider completes before CI, or CI before provider | Other completion reconciles once native job completes |
| Unchanged desired outcome | No rerun; prevents feedback loops |
| New pending review or reopened thread on same head | On the next trigger, revoke readiness and rerun green native review to red; dispatch after manual reopening |
| Manual reopening or resolution with no event | Dispatch reconciliation with PR number; read only, then targeted rerun; dispatch PR Readiness if needed |
| Fork PR | Reader/queue can verify it; reconciler ignores it; maintainer reruns native review job in Actions; readiness preserves author control |
| Disabled CI, old run or 50 attempts | Stop; report manual recovery, never whole-CI dispatch fallback |

GitHub may rerun blocked dependent heavy jobs when a targeted review retry passes.
Already-running review jobs are not retried. Successful and ambiguous rerun responses share a bounded observation barrier; unresolved acceptance requires inspection. There is no durable cross-execution reservation or exactly-once claim. Readiness independently
reads fresh admission, so a historical green check cannot hide a new pending review.

## Reader sweep and evidence

Search old/new workflow, helper, provider variable, round, patch-id and prompt/schema
names across active code, tests, docs and skills. Update active readers; historical
specs receive a dated superseded note. Keep unrelated provider code (issue intake).
Guard tests retain old ordering/cancellation/current-head guarantees and replace model
posting/cap assertions with App execution/admission tests. This is a replacement,
not a product bug fix; adversarial fixtures pin the new trust boundaries.

Use Squeal for affected node tests. Run workflow lint/actionlint/YAML, citation check,
and complete changed-function quality measurement. No full local suite. Parent must
push-button dispatch CI on the final workflow files before merge. Native PR CI uses
main's definition until rollout. Fixtures and diagnostic dispatch cannot prove live
postmerge provider events, GitHub rerun scheduling or queue semantics.

## Validation observations

The parent inspected completed successful native main-target runs `41536094724`,
`41532210563` and `41531703129` on 2026-11-02. Each has an official PR association
with PR number, exact head, main base and repository IDs. The cancelled/closed
pilot run `41529312439` has an empty association. Native proof therefore requires
a matching association and fails closed when absent. Vendor checks remain separate:
their empty association is expected and never required.

Local checks validate fixtures and static workflow structure. They do not prove
postmerge external event delivery or exact-once rerun execution. A bounded acceptance
observation reduces retry races but is not durable cross-execution deduplication.

## Confirmed review corrections (2026-11-02)

Proof base: `b71de1afc9dff86036634948b83a5ab2074def0d`. Preserve the original
implementation and the parent's docs policy correction. One commit per finding.

The original repository lock supplies write serialization and an acceptance
observation barrier. A single 120-second sweep can starve later PRs, so trusted
discovery now validates the event once and emits reliable PR numbers before
job-level concurrency is chosen. Automatic triggers discover all open
same-repository main PRs. Each matrix job has its own 120-second deadline and
PR-number lock; max-parallel is four and fail-fast is false. Manual dispatch
can scope the requested PR because it no longer shares a repository queue.

The old event-source equality and event-head filters guaranteed that an old event
could not authorize old native proof. The replacement preserves that guarantee
through `readNativeReview`: each job independently proves the newest native run
for the exact live head/main/PR, successful preflight and the completed review job,
then re-reads native identity and live PR before writing. There is no fallback to
historical proof. Discovery still validates the official triggering event and
run/attempt identity. An admitted event is only a wake hint, not authorization.
Only trusted discovered PR numbers enter the matrix; no source run/head/attempt
survives in the queued job. An old event replacing a newer pending event therefore
cannot suppress current work. Signal merge SHA never selects a lock.

The parent explicitly authorized dropping the source-equality freshness filter
on 2026-11-03 after confirming it added no authorization beyond newest native
proof and could suppress same-PR recovery. This supersedes the initial proposed
source-scoping correction in this task's first plan revision.

| Discovery / PR job case | Required behavior |
| --- | --- |
| B's pending event coalesces with A's check, CI or signal event | Surviving automatic discovery creates durable jobs for both PRs |
| Valid triggering CI source run/attempt differs from newest native run | Prove and reconcile newest live native run for each PR |
| Valid old signal association head differs from live PR | Re-read live head and newest native proof; never use merge SHA |
| Invalid/foreign/spoofed trigger | No discovery or writes |
| Unrelated PR has malformed identity or no valid native proof | Skip only that PR; other matrix jobs continue |
| One job consumes its deadline or ambiguous-write observation window | Other jobs have independent deadlines and fail-fast is false |
| Admission read fails for a proved green native gate | Preserve fail-closed revocation behavior |
| Rerun acceptance remains ambiguous | Fail that job and report inspection needed; never retry POST |
| Fork, closed or non-main PR | No mutation |
| Large or malformed listing, exhausted discovery deadline | Fail bounded before emitting a partial matrix; manual recovery |
| Multiple events for one PR | Same PR-number lock, fresh live proof; unchanged outcome is a no-op |
| Late old source event replaces newer pending event for same PR | Queue only PR number; reconcile newest live head/run/attempt, never old proof |

Retain two 100-row listing pages and a 120-second discovery deadline. A full second
page remains incomplete and fails closed. Per-PR deadlines are independent; each
request remains capped at 10 seconds with no retries. Validate listing structure
globally, then skip malformed individual rows. The workflow uses only trusted
base scripts and discovered PR numbers; no PR checkout, model request or whole-CI dispatch.
The locks and observation barriers do not claim exactly-once scheduling or durable
cross-execution deduplication. GitHub delivery and coalescing still need live proof.

Also protect `merge-queue-admission.cjs` in the auto-merge never-list, filter provider
listings by check name and App ID while retaining exact identity validation, and
scope draft automation documentation to same-repository PRs. Search active readers
of the old target-only/coalescing descriptions and update them with discovery.


## Correction validation (2026-11-03)

Final JavaScript/workflow source revision: `26a45e1dae922ae1505930dd0003d1a99b29bd36`.
The following commit changes only draft-policy documentation and this evidence.
Parent safety review of this revision found no blockers. Parent owns integration,
push, final bare CI dispatch and provider-thread replies; this worker did none.

- Baseline red proof: disposable detached worktree at `b71de1afc`, its own frozen
  pnpm dependencies, 13 selected tests fail for the reported defects. Only the
  test `run` helper adapts to the old whole-event reconciler API; fixture and
  assertion semantics are unchanged. No import/setup failure counts as proof.
- Red selection: `node --import ./scripts/test-git-env.mjs --test
  --test-name-pattern 'small queue|unrelated CI|coalesced B|valid old source|malformed PR listing|missing native CI|reconciler has|valid old signal association'`
  against `auto-merge-admission.test.cjs`, `coderabbit-admission.test.cjs`,
  `coderabbit-reconcile.test.cjs` and `coderabbit.workflow.test.cjs` under
  `.github/scripts/`. Fixed source with the full current tests: **101 pass**.
- Changed-function measurement against `b71de1afc`: **37/37 functions**, six files,
  101 tests pass; maximum complexity **15**, maximum CRAP **15**.
- Full-PR measurement against `190a4d6d57f1d13dc957efa4c24d317543579b27`:
  **235/235 functions**, 21 files, 316 tests pass; maximum complexity **20**,
  maximum CRAP **23.237885**. Limits are complexity >20 / CRAP >30. The initial
  207-function / 20-file / 292-test implementation report is superseded.
- Both measurements use the bundled `check.mjs --runner node --node-import
  scripts/test-git-env.mjs`, with their pinned `--base` and relevant `--test`
  files. The full-PR selection includes the unchanged `pr-test-proof.test.cjs`
  consumer; omitting it leaves that function without coverage. Exact commands,
  every function row and source hashes are in the published reports.
- `npm run lint`, pinned actionlint **1.7.12**, shellcheck **0.11.0** with CI's
  `SHELLCHECK_OPTS=--severity=warning`, citations and `git diff --check` pass.
  An initial actionlint call omitted that severity and reported inherited
  informational SC2016 in `ci.yml`; the exact CI invocation passes.
- Auto-merge decision against the full PR baseline: **DOES NOT QUALIFY**, as
  expected for review-gate/policy changes. No auto-merge action was taken.
- Reader sweep updated CODE_REVIEW, CI recovery, workflow concurrency assertions
  and this plan. Fork draft policy is separate from native-gate rerun guidance.
- Squeal reached revision 7 / current source HEAD after delayed revision
  application and database-lock messages. Current selected verdicts were pending
  in that capture; fresh bundled checks above verify the source. At the preceding
  revision 6 status, 87 of 90 slow files were pending; no full or slow-suite pass
  is claimed. Friction filed as `hearsay-tools/squeal#138` using its template.

Published task `fd575290-d087-452d-a025-9c17045cd90b` snapshots:
changed-function report `7daff09e-c52e-4cf3-bf07-5be695c98380`, full-PR report
`86989e45-c491-46e9-8e79-41a18f9b6c85`, red/green proof
`c7e923da-0aad-4299-ae61-6aea58077427`. Local fixtures do not prove GitHub's live
matrix scheduling, coalescing, provider delivery or exactly-once rerun execution.

| Source | SHA-256 |
| --- | --- |
| `.github/scripts/coderabbit-reconcile.cjs` | `cfa93266ac51c8b2e685c9ae45bef87cd4507b797ca063f7cf5c39953a760149` |
| `.github/scripts/coderabbit-admission.cjs` | `d0083f2c91775f607ffbdc7c4a115c69e5da0a4ce2ca65e95fcaf811774db411` |
| `.github/workflows/coderabbit-reconcile.yml` | `c429e408578148082e2ca1b74144105771b258dccf1230cb46ced6693fe59d16` |
| `.ai/skills/auto-merge/check.mjs` | `8c44e04e65b66e34ff6d768c71436fb76586f2e7a2cf3900a105efd38b5426a7` |


## Incremental findings (2026-11-03)

Merge base and regression `proof_base`:
`a5559af6217316b802aa83b7c7f7b77e4e1b9579`, merged into the worker without
rebasing (fast-forward; preserves main ancestry and all previous fixes).

The policy import sweep starts at native review proof, CodeRabbit admission,
reconciliation, queue admission and readiness. Their local transitive imports
are `queue-ci-proof`, `coderabbit-admission`, `native-review-proof`, `review-threads`,
`review-signal` and `release-bump-pr`. All but `queue-ci-proof` were already
protected. CI also directly consumes `pr-test-proof`, which can authorize reusing
PR tests, and `pr-test-input`, which supplies the exact input attestation and is
imported by that proof. Protect both along with `queue-ci-proof`. The removed
`review-ci-context.cjs` has no active file or import and needs no current entry.
Eleven table-driven policy cases check this whole admission/proof helper set.

The documentation correction records that GitHub Actions has no review-thread event for manual reopening or resolution. Admission and ready/draft state update on the next
reader/trigger; maintainers dispatch reconciliation with `pr_number` after either
manual change and dispatch PR Readiness if draft state needs refreshing. Preserve
the fork-author draft rule. No runtime or workflow redesign.


### Incremental validation

Policy source revision: `4b104846c522052fe5ae946c76387d691b5f8972`.
The following docs commit leaves JavaScript and workflows unchanged.

- Disposable scratch at `a5559af62`, with its own frozen pnpm install: copied
  current `auto-merge-admission.test.cjs` unchanged. Command:
  `node --import ./scripts/test-git-env.mjs --test .github/scripts/auto-merge-admission.test.cjs`.
  Baseline has **8 pass / 3 fail**: only `queue-ci-proof`, `pr-test-proof` and
  `pr-test-input` incorrectly qualify. Copying only the fixed policy source
  makes the same eleven tests **all pass**. No test/API adapter is needed.
- Mandatory bundled quality against `a5559af62`: **1/1 changed function**,
  eleven tests pass, maximum complexity **1** / CRAP **1**. The policy change is
  a module-level constant; only the updated test callback changes function body.
- Full-PR bundled quality pins merged main
  `9dbe93aa4b36593ec0f46af09338ae50083e36a7` (the original `190a4d6d5` baseline
  would now include unrelated main changes). **235/235 functions** across 21
  files, **326 tests pass**, maximum complexity **20**, CRAP **23.237885**.
  Function count stays stable; policy cases add ten executed tests. Both checks
  use the bundled `check.mjs --runner node --node-import scripts/test-git-env.mjs`
  with relevant `--test` selections; full-PR includes `pr-test-proof.test.cjs`.
- `npm run lint`, citations, `git diff --check`, pinned actionlint/shellcheck
  with CI warning severity pass. Auto-merge against `a5559af62` correctly says
  **DOES NOT QUALIFY** for the policy path. Workflow files are byte-identical
  to `a5559af62`; no new live dispatch was requested.
- Squeal returned a current policy-file pass at revision **11**, after 16.1 s;
  no known worktree failures, with 273 other test files pending at that capture.
  A later report had all 90 slow files pending; no full/slow-suite pass is claimed.
  Later docs-only edits do not change the tested policy source. No new friction
  distinct from the already filed `hearsay-tools/squeal#138` was observed.
- Reader sweep covers CODE_REVIEW, CI readiness/recovery, SDLC, the AGENTS review
  recovery binding, auto-merge follow guidance and this plan. AGENTS has no byte
  growth. Fork draft control and maintainer native-rerun guidance remain separate.

Current policy SHA-256:
`ec22a1f24b47c01225618dc865107d7aa702958b06569c056a191d8031e35f04`.
Current policy regression SHA-256:
`a313796acddd3248f96a524825883b3c73387cd3ed2a54c4906c8c61b2c4f508`.
The prior reconcile/admission/workflow hashes remain unchanged.

Published task snapshots: incremental quality
`1e78f321-d6d5-4d05-b817-bf9c4e88dc84`, updated full-PR quality
`8e5b6d57-2284-47d0-ac6d-1007ea6ff20a`, unchanged-test red/green proof
`1e55f546-ba31-4106-9f74-8df2a9dce71a`.
