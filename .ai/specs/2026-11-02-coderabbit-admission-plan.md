# CodeRabbit admission replacement

2026-11-05: heavy verification no longer waits for review admission. It runs beside the
native review gate after preflight, and `verify` requires both (hearsay-tools/cezarion#2727).

2026-11-03: The strict success-only provider policy below is historical and is
superseded by [trusted no-files admission](2026-11-03-coderabbit-skipped-recovery-plan.md).
The current gate also accepts the exact trusted no-files skip without claiming
model execution. The native rerun path and resolved-thread requirement remain.

Approved owner brief, 2026-11-02. Baseline: `190a4d6d57f1d13dc957efa4c24d317543579b27`.

The old flow supplied reviewer execution, open-thread admission, current-head checks,
bounded recovery and capped spend. The installed external CodeRabbit App replaces
execution. A shared deterministic reader replaces admission and current-head checks.
A bounded trusted reconciler replaces manual rejudge/recount. The owner explicitly
removed the spend cap because CodeRabbit is free for this open-source repository.
Automatic review now starts on push, before preflight. Heavy verification waits
for preflight only and runs beside the native protected review job; `verify` requires both. No model commands or PAT fallback.

## Implementation

1. Extract bounded review-thread reads. Add a shared live CodeRabbit reader and verified
   release/upstream exceptions. Require App `347564`, slug `coderabbitai`, name
   `CodeRabbit`, newest execution on the exact head, completed/success and zero open
   threads of any author. Re-read provider and PR before admission. Empty vendor
   `pull_requests` is supported; formal reviews are never execution evidence.
2. Keep protected check names and native CI provenance. Replace the reusable model
   workflow with a read-only native `review-result`. Keep queue,
   push reuse, snapshot publication and verified bot skip guarantees.
3. Reconcile genuine provider creation/completion, native CI completion and review
   events. Select at most four validated event-associated PRs. Only an empty provider
   association uses a bounded inventory lookup for matching current heads. Manual
   `pr_number` dispatch recovers dropped or eventless changes. Create independent
   trusted PR jobs; ignore forks, require newest native run/attempt and successful
   preflight. Re-read before rerunning only
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
| Manual reopening or resolution with no event | Dispatch Reconcile CodeRabbit admission with PR number; read only, then targeted rerun and board sync (PR Readiness merged into it) |
| Fork PR | Reader/queue can verify it; reconciler ignores it; maintainer reruns native review job in Actions; readiness preserves author control |
| Disabled CI, old run or 50 attempts | Stop; report manual recovery, never whole-CI dispatch fallback |

A targeted review retry reruns only the review job and its dependents (`verify` and later); no heavy job depends on it.
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

## Confirmed review corrections (2026-11-02, historical)

The all-open discovery design below is superseded by **Bounded event targets**.
Its validation evidence remains a record of the earlier implementation.

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
manual change; the same Reconcile CodeRabbit admission run refreshes the board (PR Readiness merged into it). Preserve
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


## Readiness cross-event serialization (2026-11-03, historical)

The all-open discovery scope below is superseded by **Bounded event targets**.
The same-PR serialization and fresh-evidence guarantees remain active.

Confirmed finding `4448988392` on `hearsay-tools/cezarion#2501`.
Regression `proof_base`: `a5559af6217316b802aa83b7c7f7b77e4e1b9579`.
Preserve policy `4b104846c` and docs `8b2342b80`.

The old concurrency key serialized branch-based PR/CI wakes and SHA-based check
wakes separately. Its intended guarantee was one readiness/board writer per PR,
including a non-cancellable draft flip plus board sync. It did not provide that
guarantee across event kinds. Replace it with trusted read-only discovery before
job-level concurrency keyed only by discovered PR number. Automatic check/CI/
signal wakes reuse the reconciler's authenticated discovery and discover all
eligible open same-repository main PRs; lifecycle and manual events scope their
validated PR number. Every admitted PR receives an independent job/deadline,
max-parallel four, fail-fast false. No workflow-global or head-SHA lock.

The old new-head action forced draft without proof. That pinned the guarantee
that an unverified head never stays ready. Replace the unconditional event-time
write with current native/provider/required-check proof at the PR lock head:
missing/unverified live-head evidence forces draft, while a late synchronize wake
must not override already-successful current evidence. No old event head, draft
value or admission decision enters the queue. Every surviving job evaluates fresh
proof. Human ready/draft events request the same fresh reevaluation. The old human
path guaranteed board sync; it did not establish a durable manual override.
Replace that path with the workflow-owned readiness rule for every event:
`draft = !freshAdmitted`. A verified head may become ready automatically after a
human draft flip. No event-specific preserve flag enters the queue. This also
prevents a human wake from suppressing either a pending revocation or promotion.

| Event / boundary case | Draft behavior at the PR lock head | Board / isolation |
| --- | --- | --- |
| New unverified head, PR open/reopen/synchronize | Read live head; failed/missing proof => draft | Sync live result to In progress |
| Late synchronize after current CI/admission succeeds | Keep/mark ready from current proof | In review; never force draft from old event |
| CI held after reading green, pending provider wake queued | First writer settles; queued check job reads pending => draft | Final In progress after both jobs |
| Check, CI, signal, manual, lifecycle for same PR | One PR-number lock, no cancellation during mutation/sync | Same lock across all event kinds |
| Valid old head/run event after newer event | Wake only; prove live PR/head/newest native evidence | No historical proof or stale head filter |
| PR A/B automatic events coalesce | Discovery covers both; independent PR jobs/deadlines | One stalled/failed job cannot block another |
| Manual ready/draft event delayed behind another flip | Derive draft from fresh admission, like every other event | Sync computed state, not stale action |
| Pending revoker replaced by human wake | Fresh failed admission still forces draft | Final In progress; no board-only bypass |
| Pending promotion replaced by human wake behind old failed decision | Fresh passing admission makes ready | Final In review; no durable manual override |
| Provider/native/required check fails or is pending | Draft on next admitted trigger | Sync In progress; Done cards stay Done |
| All current checks, native proof and provider/thread admission pass | Ready | Sync In review |
| Fork, closed PR, different base, removed PR | No mutation | No board write |
| Head changes while proof is read | Refuse stale mutation | Later wake reads new head |
| No board token or board read/write failure | Draft gate still works | Quiet optional sync skip |
| Invalid/spoofed event | No discovery outputs or jobs | No writes |

Keep trusted default-branch checkout, optional project token, no PR checkout,
current native/provider proof and final live rereads. The workflow lock is a
GitHub scheduling guarantee tested statically plus deterministic queue fixtures;
fixtures cannot prove hosted scheduling or exactly-once delivery.


### Readiness validation evidence

Measured the final working source after `8b2342b80`; the readiness commit records
that exact source. No package source/declarations changed, so no local build,
package suite or root typecheck was needed. Parent owns final CI dispatch.

- Disposable scratch at `a5559af62`, own `pnpm install --frozen-lockfile`:
  six selected regressions **0 pass / 6 intended assertion failures**. The test
  reads the checked-in YAML key and models one running plus one replaceable
  pending job. It runs the old exported handler on the baseline and the new
  discovery/refresh exports on the fixed source. There is no import adapter or
  setup failure. Copy only the fixed readiness source, discovery export and
  workflow: the unchanged readiness tests **31/31 pass**. Both revocation and
  promotion are covered when a human wake replaces a pending job. The overlap
  test checks final draft plus PR/issue board state after both jobs settle.
- Mandatory bundled affected quality against `a5559af62`: **59/59 changed
  functions** across three files; **99 selected tests pass**; max complexity
  **18**, CRAP **18**. Full-PR measurement against merged main
  `9dbe93aa4b36593ec0f46af09338ae50083e36a7`: **289/289 functions** across 21
  files; **336 selected tests pass**; max complexity **20**, CRAP **20.231481**.
  Both use the bundled collector with `--runner node --node-import
  scripts/test-git-env.mjs`; every changed test and the PR-test-proof consumer
  are included in the full-PR selection.
- `npm run lint`, citations, `git diff --check` and pinned actionlint/shellcheck
  with CI warning severity pass. AGENTS shrinks; no byte-budget growth.
- Squeal revision **21** returned current passing results for readiness,
  reconciliation and auto-merge admission after 42.8 seconds. At that capture,
  no worktree failures were known and 220 other files / 4584 tests were pending.
  This does not claim a full-suite or slow-tier pass. Final global status is
  reported to the parent after committing; no duplicate issue is filed for
  friction already covered by `hearsay-tools/squeal#138`.
- Reader sweep covered removed readiness exports/old key, lifecycle tests,
  CODE_REVIEW, CI documentation and the AGENTS board binding. No external caller
  uses the removed handler exports. Fork state, Done cards and optional project
  token behavior remain covered. Hosted GitHub scheduling remains a rollout
  validation limit; these fixtures do not prove lossless delivery.

SHA-256 of measured source:

| File | SHA-256 |
| --- | --- |
| `.github/scripts/pr-readiness.cjs` | `3c80b02d08c44c6ac05f47b998dd4c2edc34765aa9f1bed78f1ca5bcb7690507` |
| `.github/scripts/pr-readiness.test.cjs` | `db385711f2cce37a6c07444fa62c307869012c9ceaf3a89d53466c5da31b34ac` |
| `.github/scripts/coderabbit-reconcile.cjs` | `f7c609edd6874a1c40208758f053749f02dd2ffc34284ec3b7668616ea6a28c2` |
| `.github/workflows/pr-readiness.yml` | `8673096da19a32d2fdbd1c930db09b6c486eabfd68710eb8d9edcce430ee838f` |

Published task snapshots: affected quality
`b71dcd3c-fe13-4344-9f1b-2a4026f392cd`, full-PR quality Markdown
`ec52a7d1-d8ce-4a54-949b-55e7a32bef5d`, full source-hash/coverage report JSON
`b79c0bb0-2db6-4e2b-822b-4af07292b6e5`, red/green proof
`29992b96-8406-46b1-91be-cdd8f8a18296`.


## Bounded event targets (2026-11-03)

Findings `4449194844` and `4449194858`, `hearsay-tools/cezarion#2501`.
Proof base: `95619b966d0170fe7f5d029dab0da30a3ed9f282`.
This section supersedes the earlier all-open automatic discovery design and its
cross-PR sweep tests. The earlier sections retain historical validation evidence.

The all-open scan compensated for a former repository-wide pending slot: A's
surviving event had to recover B's replaced event. Neither current workflow has a
shared discovery queue. Each event gets independent trusted discovery, then PR
number job locks isolate A and B. A same-PR pending replacement still reads fresh
proof at the lock head. Replace automatic proof of unrelated PRs with event-owned
targets; explicit `pr_number` dispatch recovers eventless or dropped events.
No repository-wide recovery sweep, queue storage, schedule or new setting is needed.

Native CI uses bounded PR numbers from the authoritative run's official
`pull_requests` association, never `workflow_run.head_sha` as a live PR filter.
Signals retain the validated `signalTarget.number`. Provider checks use their
verified official associations when nonempty; only an empty array permits a
bounded open-main listing and selects eligible current heads equal to the verified
check head. Malformed association data cannot trigger that fallback. Old associated
events wake their PR and prove its current head/run/attempt, not historical state.

Use a fixed four-target limit per event, including official association rows and
fallback head matches. Dedupe valid associations; reject malformed/oversized lists
and excess matches with manual `pr_number` recovery instead of truncating. Existing
open-inventory pagination stays two pages (at most 199 rows, otherwise fail closed).
Every target is re-read and checked for live eligibility before its matrix job and
again at the lock head. Discovery performs no native/provider proof on unrelated
PRs. Each selected job keeps its own 120-second deadline and existing bounded
readers. Each workflow independently applies this cap; readiness and reconciliation
can both handle the same event. CI/associated-check discovery uses at most five
REST reads, signal discovery three, and empty-check fallback seven, before the
selected matrix jobs. These counts exclude the selected jobs' bounded proof/read
work and optional board synchronization. Four-way parallelism bounds concurrency only; this design does not enforce
a repository-wide hourly GitHub API limit across unrelated events/workflows.

| Input / transition | Target selection | Guarantee / recovery |
| --- | --- | --- |
| Valid CI with 63+ unrelated open PRs | Official associated numbers only, live eligibility | No open inventory or unrelated proof |
| CI run SHA differs from live PR head | Same associated PR number | Prove newest live native/provider state at queue head |
| Valid signal with merge SHA | Validated signal PR number | Never use merge SHA as PR-head filter |
| Associated provider event, old or current head | Official associated numbers, live eligibility | Old event cannot select historical proof |
| Provider with empty association | Two-page open-main listing; exact current head matches only | No unrelated proof; several matches allowed up to four |
| Empty-association provider with stale head/no match | No targets | Current synchronize/CI/provider wake or manual dispatch recovers |
| Malformed/missing CI/check association or more than four rows/targets | Fail closed; no output jobs | Dispatch either workflow with `pr_number` |
| A and B receive independent automatic events | Independent discovery and PR-number jobs | Holding A cannot drop or block B; no global discovery lock |
| Same-PR mixed-kind pending replacement | One PR lock; surviving job reads live evidence | Existing promotion/revocation coalescing tests remain |
| Fork, closed or non-main live PR | Skip | Fork author retains draft state; no targeted rerun |
| Missing native proof or ambiguous targeted write | Existing per-PR failure / observation behavior | No blind POST retry; other independent PR jobs continue |
| Manual dispatch | Requested positive PR number only | Bounded recovery without repository sweep |

Record this replacement before changing old coalesced-all-PR test expectations.
The paired findings share one cause and one shared discovery fix consumed by both
readiness and reconciliation; keep that policy/runtime change in one logical commit.


### Bounded-target validation evidence

The parent merged source `95619b966` is the regression base. Final measured
JavaScript/tests are the working changes after that SHA. No package source or
public declarations changed; build/typecheck/package verification remains in CI.

- Disposable scratch, own frozen pnpm installation, unchanged regression tests:
  **29 selected tests fail** on `95619b966` by intended target-list assertions or
  missing expected rejection. There are no setup/import errors, cancellations,
  empty test selections or timeout failures. Copy only fixed
  `coderabbit-reconcile.cjs`: **122/122 affected tests pass** across reconciliation,
  readiness and workflow tests. This includes independent A/B discovery/queues
  linked to both production YAML files, old associated CI/provider events proving
  current heads, bounded/malformed associations, stale empty-association no-op,
  fallback pagination/target overflow and 63-unrelated-PR cases for both consumers.
  Prior same-PR pending replacement promotion/revocation tests still pass.
- Mandatory bundled affected quality against `95619b966`: **67/67 changed
  functions**, four files, **122 tests pass**, max complexity **16**, CRAP **16**.
  Current full-PR measurement pins fetched merged main
  `4068a24fd3d03f191e2999a69565dfbf60905a43`: **340/340 changed functions** across
  21 files, **366 selected tests pass**, max complexity **20**, CRAP **20.231481**.
  Both use bundled `check.mjs --runner node --node-import scripts/test-git-env.mjs`
  with affected tests; full-PR also selects every changed script test and the
  PR-test-proof consumer. All 21 measured source hashes match final files.
- Lint, pinned actionlint/shellcheck with CI warning severity, citations and
  `git diff --check` pass. The parent/native read-only safety review is clean.
  No workflow concurrency or mutation permissions change; only a comment changes
  in the reconcile workflow. Readiness runtime is unchanged and uses the shared
  bounded discovery fix. No unrelated UI/test cleanup is consumed or edited.
- Squeal returned current passing results for the three selected files at revision
  **27**, after 21.7 seconds. At that capture no worktree failures were known;
  474 other files / 7143 tests remained queued. Final global state is reported
  separately to the parent; no full/slow-suite result is inferred from this pass.
- Reader sweep corrected the CI guide and workflow all-open promises. Earlier
  all-open plan sections are explicitly historical and superseded. A/B recovery
  now comes from independent event discovery and PR queues, with manual bounded
  recovery for dropped/eventless events. No repository-hourly rate limit or
  lossless delivery claim is made. Fork, board, Done and targeted-write behavior
  remains unchanged. Existing Squeal friction is tracked in
  `hearsay-tools/squeal#138`; no distinct new friction was found.

Measured SHA-256:

| File | SHA-256 |
| --- | --- |
| `.github/scripts/coderabbit-reconcile.cjs` | `b375b211fa0226ebaadc1823b4dfa76b0d401b8b8b457df6b107e954367120f7` |
| `.github/scripts/coderabbit-reconcile.test.cjs` | `024dcb716678adbe0a2db51ee9c54b828c555b821215cdd1b042fec47715b836` |
| `.github/scripts/coderabbit.workflow.test.cjs` | `1cfecad88b655861893d1a35aaf40ab39fd269a07f0561875b1cd263605943ac` |
| `.github/scripts/pr-readiness.test.cjs` | `bf58c1abd02e4ca056ff33624e914d6aee5db8674c911fec1693b83603971b14` |

Published task snapshots: affected quality
`0ea10c91-e22c-41d2-ac2a-3b539c1c2d94`, full-PR Markdown
`ca36741b-db18-4090-9caa-acf76d292b28`, full source-hash/coverage JSON
`b4f15089-3c59-4914-bbf0-d6ce81a21fca`, red/green proof
`c939212b-0dae-4b60-b63d-9da5bc5a302a`.


## Poll history test clock repair (2026-11-03)

Before changing the test, preserve its guarantee: only previously unhandled
matching issues launch, no more than two per check, and reopening the store
continues discovery across the 100 handled receipts. Both history modes retain
the same launch and request-count assertions. Runtime lookback behavior remains
unchanged.

CI run `41550415578`, attempt 1, job `125637188923` fails at the history=true
launch assertion: `expected [] to deeply equal [ 101, 102, 103, 104, 105 ]`.
Native run `41550421039`, job `125637864602` reports the same failure. The test
uses fixture epoch `2026-10-27T00:00:00Z`; scheduler `pollWindow` derives the
seven-day history start from `Date.now()`. On November 3, the fixed events fall
outside that window. This is a calendar dependency in the test, not a production
window defect. Parent branch `844d2a222` is merged before this test-only change.

Use a Date-only fake clock at `2026-10-28T00:00:00Z` before each test and restore
real time after each test. Leave timers real and keep all assertions.
`proof_base=844d2a222`: in a disposable worktree with its own dependencies, run
the original file at the current November 3 host date, confirm the intended
assertion failure, then copy only the fixed test and run the same command.

| Case | Preserved behavior | Clock dependence |
| --- | --- | --- |
| History enabled | Launch 101 through 105 across reopened stores; bounded work | Fixture events stay within seven days |
| History disabled | Same unhandled/restart guarantees | Explicit activation baseline still applies |
| Other cases in file | Existing overlap, retry and receipt assertions remain | One explicit fixture clock |
| After each test, including assertion failure | Real Date restored; temp directories removed | No clock leakage |


### Poll clock validation evidence

- Proof base `844d2a2220ca1b8e0c0fc363209a48ac2714fb7f`; disposable worktree
  had its own frozen dependencies. At host date November 3, unchanged test:
  **12 pass, one intended history=true assertion failure**, expected 101–105,
  received empty array. Copy only fixed test: **13/13 pass** with the same
  `npm test -- --passWithNoTests=false` file selection. Scratch removed.
- Mandatory affected bundled quality against that base: **2/2 changed
  functions**, both hooks have complexity **1**, body line coverage **100%**,
  CRAP **1**. Coverage execution also passes all **13 tests**. This incremental
  report covers the test-only fix; earlier full-PR script measurements remain
  recorded separately. No runtime source or declaration changed.
- Test SHA-256: `31affa3a743c61aa6cb1f01cde145f0d93d6271ee8ba8b401715dc00c4c03841`.
  Parent read-only safety review found no blocker. No assertions were changed;
  production history window and scheduler behavior are unchanged.
- Published snapshots: regression proof `232855bc-607d-435b-b873-2442038d10b1`,
  quality Markdown `a6d5b48f-2dcb-438d-b581-67bf798e6911`, quality JSON
  `1dffdfc9-0960-45c3-be9b-8e40732e0a0d`.
- Final lint passes all 10 Cezar rules and 15 ast-grep rules; citations and
  diff checks pass. Squeal revision **33** reports the selected file current
  and passing after 28.1 seconds. At that capture zero failures were known;
  363 other files / 5898 tests remained pending. No full-suite or slow-suite
  pass is claimed. The first selected wait timed out; the second returned a
  current result. This adds no distinct friction beyond existing
  `hearsay-tools/squeal#138`.
