# Main CI failure reporting and repair

The completion reporter handles CI runs from pushes to `main`, alongside
Release and Nightly. Pull-request and manually dispatched CI runs do not enter
this immediate reporting path. The daily recurring-failure sweep remains in place.

A cancelled run can contain completed failed jobs. Those jobs are reported;
cancellation alone is not a defect. Cancelled jobs are reported only when their
check-run annotation establishes a time limit. A failed job that starts at or
after the first cancelled job without a time limit completes is not reported:
it failed because of the cancellation. The `always()` verification gate is the
example. It reads its cancelled needs and exits 1 (hearsay-tools/cezarion#1442).

The reporter uses the existing shared Actions concurrency group and durable
signature and occurrence markers. Matching open reports receive evidence rather
than duplicate issues. A recurrence after closure creates a linked report.
Diagnostic comments contain the source commit, run attempt and failed job links;
log downloads and excerpts remain bounded and credential-redacted. Reporting runs
trusted default-branch code and never executes failed-run artifacts.

For main CI, the reporter adds `main-ci-failure` only after saving the occurrence
comment. An issue-write or routing failure makes the reporter fail visibly.
Rerunning it repairs partial writes using the same markers. The label must exist
in the repository before this workflow is deployed.

## Local automation

The Cezar automation **Main CI — guarded repair** polls `issue.labeled` every five
minutes and requires the live `main-ci-failure` label. It is created paused and
must be enabled explicitly in the cockpit. It uses one isolated task per match,
allows human questions, and does not generate follow-up tasks. With historical
matching off, enabling starts from that time; earlier reports require deliberate
manual handling. Reapplying a label is not the recovery method for an existing
task: continue that task instead.

Each task verifies source provenance through GitHub, checks current main and
later CI attempts, and checks assignments, claims, tasks and PRs before repair.
A green retry alone does not establish a fix. Bounded repairs restore established
behavior and end in a verified draft PR. Unclear evidence, design conflicts or
policy changes require a human decision in the same task. Tasks never merge,
weaken checks, quarantine tests, enable automations or repeatedly rerun CI to
obtain green.

GitHub issues retain the diagnostic evidence. Cezar retains matching receipts and
the task handoff. No new runtime state or product configuration is required.
The paused automation spends no runner tokens; when enabled, each new matching
report can start a task and consume tokens. Related failure signatures can still
produce separate reports, so the task's duplicate-work check remains necessary.

## Verification

Reporter tests cover trusted event eligibility, failed jobs in cancelled runs,
failures that start after the cancellation, evidence before routing, and retry
recovery. The workflow test pins the trigger,
permissions, trusted checkout and shared lock. Preview the local automation before
enabling it; a preview does not launch tasks or advance its execution cursor.
