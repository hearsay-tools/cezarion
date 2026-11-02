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
   events. Resolve exact heads to open main PRs, ignore forks in this mutator, require
   newest native run/attempt and successful preflight. Re-read before rerunning only
   the completed native review job when admission differs. Serialize per repository,
   never retry ambiguous writes. No-op once outcomes agree. Limit to GitHub's 30-day,
   50-attempt rerun window. Manual `pr_number` handles eventless thread resolution.
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
| Success with any open thread, including outdated | Block; review event or manual resolution dispatch reconciles |
| Skipped, neutral, provider failure | Block; no automatic model request |
| Spoofed App/name, stale head, older success behind newer failure | Block; exact trusted newest execution only |
| Head/provider changes during reads | Block; next genuine event retries reconciliation |
| API errors, malformed/truncated/changing pages, cursor loops | Block with bounded requests; manual retry after repair |
| Verified release stamp or upstream-ledger bot PR | Skip provider only; live complete file/content classifier and all threads still required, native and queue |
| Bot author/branch without verified files | Normal provider gate |
| Provider completes before CI, or CI before provider | Other completion reconciles once native job completes |
| Unchanged desired outcome | No rerun; prevents feedback loops |
| New pending review or reopened thread on same head | Revoke readiness and rerun green native review to red |
| Manual hand resolution with no event | Dispatch reconciliation with PR number; read only, then targeted rerun |
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
