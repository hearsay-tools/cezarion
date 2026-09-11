# Recurring CI failure sweeps (#205)

Status: approved by the task owner on 2026-09-10. Extends the reporter shipped by #204 / PR #207.

## Outcome and scope

A daily GitHub Actions sweep finds identifiable failures recurring across
unrelated changes. It inspects jobs and historical attempts even when the latest
run passed. It creates or updates actionable remediation issues with occurrence
counts, source links, affected workflows, and sanitized diagnostics.

The immediate Release/Nightly reporter keeps its existing eligibility rules and
metadata-only fallback. The sweep does not rerun jobs, change CI conclusions,
quarantine tests, execute source code, or fix the detected failures.

## Architecture and alternatives

Use deterministic analysis and the existing issue writer. Extract the writer's
marker lookup, reservation, recurrence handling, and formatting into a shared
CommonJS module under `.github/scripts`. Keep the immediate reporter as a caller
with its current behavior. Add separate sweep collection and classification
modules with injected GitHub APIs and clock for fixture tests.

This avoids two independent writers and preserves compatibility with reports
already created by #204. Both workflows use the existing repository-wide
`release-nightly-failure-reports` concurrency group, `queue: max`, and
`cancel-in-progress: false`; retaining its name preserves exclusion during rollout.

Alternatives considered:

- A persistent scan database/cursor would reduce API traffic but adds a state
  repair problem and a second authority for occurrence history. Prefer complete
  overlapping bounded windows and durable issue markers at this repository's size.
- Model-based log clustering could recognize more causes, but adds cost and an
  untrusted-input boundary. Prefer conservative deterministic matches and explicit
  maintainer reconciliation when identity is uncertain.

## Schedule, window, discovery, and attempts

Run daily at `23 4 * * *` UTC, away from the start of the hour. A scheduled run
freezes its end time at launch and looks back 14 days. The window selects workflow
runs by **original run creation time**, not last update time. Enumerate all
repository workflow runs without filtering by latest conclusion, branch, or event.
Their workflow IDs/paths provide discovery, including workflows later disabled or
deleted. Exclude only the immediate reporter and this sweep, by workflow path,
from recursive issue creation; report their observed failures in the summary.
Reporting machinery is skipped before the in-progress-attempt check: this sweep's
own attempt is always running while it collects, and a queued sibling reporter is
not a coverage gap either.

Paginate run lists and each attempt's jobs at 100 per page. Split run-creation
queries into smaller time intervals when a query reaches GitHub's 1,000-result
search limit. Deduplicate boundary run IDs. If even a one-second interval cannot
be fully enumerated within that limit, mark it incomplete and fail visibly.

For every selected run, inspect attempts 1 through its advertised `run_attempt`,
using attempt-specific jobs endpoints and historical attempt metadata. The run-list
row supplies the latest-attempt metadata snapshot, saving one request per run. Validate numeric
IDs, attempt identity, SHA and timestamps before admitting evidence. An incomplete
latest attempt does not hide failures in earlier completed attempts. Failed or
timed-out jobs contribute failed steps; a job without a failed step gets the
existing metadata fallback but cannot establish a recurring cause on its own.
Ignore cancelled/skipped jobs and attempts as failure occurrences. Passing jobs
are comparison evidence only. Never multiply an occurrence if the API repeats a
job in pagination or rerun responses.

The original-creation boundary is deliberate and must appear in documentation
and every scan summary: a new retry of a run created before the window is not
claimed as covered. Manual replay accepts explicit UTC `start` and `end`, with
at most 14 days per replay and an earliest start 90 days before invocation. This
also lets maintainers replay the creation window of an older rerun. Manual runs
execute trusted default-branch code; a job guard skips dispatches on other refs.

## Cause identity and thresholds

Reuse `failure-diagnostics.cjs` and its existing v1 signatures without changing
their inputs. Expose structured identity alongside sanitized display text so
classification does not guess from a truncated excerpt:

- A recognizable test uses its full test path and test name; the existing
  diagnostic distinguishes different symptoms of that test.
- Recognizable non-test errors retain the current stage, step, and normalized
  error matching. Cross-workflow matches require the same concrete diagnostic
  and compatible existing identity; a common job or step name alone never matches.
- Missing logs or generic exit-code messages do not qualify as recurring causes.

Track a source failure identity independently from the grouping signature: run,
attempt, job, step, and identifiable test/error within that step. Preserve the
v1 durable occurrence markers and the shared writer's existing fallback
reconciliation so changes in log availability cannot produce a second report
for the same occurrence. Tests pin behavior against already published v1 markers.

Independence is conservative. Two commits on the same PR or branch are one change
context. PR contexts use repository plus PR number; runs with no PR use repository
plus branch. A shared head SHA never establishes independence, even across
workflows or events. Ambiguous PR association cannot strengthen the evidence.
Patterns confined to one change context remain summary findings without issues.

Two issue thresholds:

1. **Possible test flakiness:** the same identifiable test and diagnostic failed
   on at least two distinct SHAs in at least two independent change contexts,
   and at least one failure has a later successful attempt of the same run and
   SHA where the corresponding job and test-running step succeeded. Matching
   comparison jobs/steps must be unambiguous. Skipped jobs, absent steps, generic
   run success, and incomplete comparisons do not count as pass evidence.
2. **Recurring failure:** the same identifiable cause has at least three failed
   run IDs, at least two distinct SHAs, and at least two independent change
   contexts. Multiple attempts of one run cannot meet this threshold alone.
   This covers persistent test, infrastructure, and build problems; it does not
   label them flaky.

Both classifications state observed evidence and uncertainty. Successful retry
can also reflect dependency, runner, or infrastructure changes; it does not prove
that the test itself is nondeterministic. Two different tests failing in one step
remain distinct, including the two symptoms described in #195.

## Reporting, reconciliation, and counts

Before mutations, read issues and needed comments through paginated list APIs.
Use the shared writer for open matches, first-occurrence reservations, missing
comment repair, and linked recurrences after closure. Read durable markers before
every replay; API search indexing is not an identity mechanism. A lost write
response stops the run; a later replay rereads markers rather than blindly retrying.

For existing remediation issues without a signature marker, require exact
recognizable test identity in their body or comments and corroboration by a
matching occurrence run/attempt or job link. A title, suite filename, or general
mention of CI is insufficient. Adopt only one unambiguous open match, preserving
its body and existing markers. Multiple plausible owners surface in the summary
for maintainer reconciliation; no new duplicate is created for that cause. This
allows evidence-backed reuse of issues such as #195 without hard-coding its number.

New issues follow the task template with concise human requirements. Agent
context comments carry bounded sanitized evidence through the shared formatter.
Add a separately identifiable sweep-summary comment per report; update it in
place only when its evidence set changes. Include observed-window counts,
distinct runs/SHAs/change contexts, affected workflows, pass comparison links,
classification and uncertainty. Existing occurrence comments are not duplicated
to add a classification. Counts describe the stated scan window, never an
unbounded lifetime total inferred from incomplete data. Passing comparisons do
not increase failure counts.

For new issues, map diagnosed test paths to existing labels: `packages/cezar`
to `area-cezar`, `packages/web` to `area-web`, `packages/contract` to
`area-contract`, and `packages/api-client` to `area-api-client`. Infrastructure,
build errors, ambiguous paths, or an unavailable expected label use `area-ci`.
Apply labels directly; preserve labels on existing remediation reports.

## Bounds, partial scans, and retention

Per invocation limits: 1,500 GitHub API requests, 20 attempts per run,
400 downloaded job logs, 2 MiB per log (the existing limit), 50 MiB cumulative
download, 4,000 characters per diagnostic excerpt, 10 newly created issues,
100 new occurrence comments, 12 minutes of application time, and a 15-minute
Actions job timeout. Reads and writes share the request budget; reserve enough
time to produce the final summary. Issue/comment enumeration is bounded by the
same request budget and must complete before a deduplication-dependent write.
Caps are safety bounds, not successful early-exit conditions. The log-download
budget is sized so the default 14-day window completes: a full window costs
roughly one jobs request per attempt plus one request per failed-job log, so
the request budget remains the binding global bound.

Missing (404), expired (410) and oversized source logs are unrecoverable
per-job evidence gaps: the coverage artifact lists their fixed code and job
IDs and the summary prints their count, but they never fail the scheduled job
on their own, because no replay can recover them and the next overlapping
sweep rechecks them anyway. Transport failures — network errors, timeouts,
non-OK signed-URL responses with any other status, invalid redirect URLs, and
failed metadata requests outside 404/410 — are recorded as `logs-fetch-failed`
and keep coverage visibly incomplete: a transient failure must never be
summarized as a complete sweep with silently omitted evidence. Exhausted
bounds, rate limits, pagination gaps, and
ambiguous matches still make the scan visibly incomplete. Continue independent
safe reads where possible, but stop issuing
requests on a rate limit or exhausted global budget. Known qualifying evidence
may still be reported when its issue lookup completed; incomplete evidence must
never be treated as an absence of earlier reports or successful retries.

Always write a safe JSON coverage manifest and Actions summary, including the
requested window, enumerated intervals, processed numeric run/attempt/job IDs,
fixed reason codes for omissions, evidence/report counts, and replay windows.
Fail the Actions job when coverage or reporting is incomplete. Never put raw
API errors, arbitrary metadata, log excerpts, signed URLs, or credentials in
these operational outputs. An outer workflow failure handler still produces a
fixed summary if the collector fails before it can return a manifest.

Upload the manifest with 90-day requested retention, subject to repository policy.
It is evidence, not required mutable state. Every sweep rebuilds from GitHub and
rechecks the full overlapping window; no cursor advances past failed work.
Missing artifacts do not stop the next run. Evidence committed to issues survives
source log expiry. Deleted issues/markers remove their deduplication history,
as documented for #204.

Normal partial scans are recovered by the next overlapping sweep. If a backlog
continually reaches a cap, replay smaller explicit windows, splitting until every
interval completes. Delays beyond the lookback and historical reruns require
manual creation-window replay; the scan never promises coverage outside its
printed bounds. Expired source logs are unrecoverable and remain visible as
recorded evidence gaps that do not fail the job on their own. Preserve previous
manifests when auditing coverage across windows.

Revised on 2026-09-11 (#225): the first scheduled sweep (run 34581855648) wrote
`complete: false` because its own in-progress attempt, the 100-log cap on a
14-day window, and four expired logs all marked coverage incomplete. Reporting
machinery is now skipped before the in-progress check, the log budget is 400,
and missing/expired/oversized logs are recorded gaps that do not fail the job.
Revised again on 2026-09-11 (review of #228): only missing/expired/oversized
logs stay non-fatal gaps; transient transport failures are recorded as
`logs-fetch-failed` and keep `complete: false` so a temporary outage can never
publish a complete-sweep artifact with evidence silently omitted.

## Permissions and trust

Use only `contents: read`, `actions: read`, and `issues: write` for the reporting
job. Checkout the default branch's trusted commit, persist no credentials, and
never checkout or execute scanned run code. Use the existing signed log downloader
without forwarding the reporting token. Never invoke an agent or interpret logs
as instructions. Reuse sanitization for metadata and excerpts; Actions logs and
summaries contain fixed messages and validated IDs only. No new CEZ environment
variable or cockpit UI is required.

## Verification

Add deterministic API fixtures covering all workflow discovery, successful latest
runs with failed historical attempts, paginated runs/jobs/issues/comments, the
1,000-result split, duplicate boundary items, cancelled and skipped jobs, isolated
development failures, independent changes, same-SHA retries, distinct causes in
one step, infrastructure errors, and persistent regressions.

Writer tests cover existing immediate reports, unmarked remediation issues,
ambiguous owners, closed recurrences, unchanged overlap, lost write responses,
partial create/comment updates, log availability changes, and serialized
concurrent sweeps/immediate reports. Pin the existing immediate reporter's
eligibility, metadata-only fallback, formatting, and marker behavior before
extracting its shared code.

Coverage/security fixtures exercise missing logs, total/per-log limits, request
and issue budgets, timeouts, partial scans, replay recovery, label fallback,
redaction, and fixed error output. Workflow tests execute the github-script entry
with fake APIs and pin schedule, manual defaults, trusted checkout, minimal
permissions, shared concurrency and failure-summary/artifact behavior.

Run the five binding commands before commits/PR: `npm run typecheck`, `npm test`,
`npm run test:unit`, `npm run build`, `npm run test:package`. Demonstrate new
regression checks fail against their unfixed source. No user-facing UI changes;
experience checks are not applicable. Open a draft PR for #205 and monitor CI
and review feedback with `pr-checks`.

## Sources

- [GitHub workflow run APIs](https://docs.github.com/en/rest/actions/workflow-runs):
  run creation filter, pagination and 1,000-result filtered-query cap.
- [GitHub job APIs](https://docs.github.com/en/rest/actions/workflow-jobs):
  attempt-specific job listing and signed job-log downloads.
- [GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency):
  serialization and queued-run limits.
- [GitHub workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows):
  scheduled events, dispatch, and trusted default-branch execution.
