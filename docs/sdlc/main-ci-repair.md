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

## One repair per run attempt

For main CI, the reporter first saves every eligible occurrence. It then creates
one summary issue for the repository, run ID and attempt. The summary links every
member report, including a closed report whose occurrence was already saved for
that attempt. Repeated signatures across jobs appear once in the list; their
individual occurrence comments retain the job evidence. The signature reports
remain diagnostic records shared with Release, Nightly and the daily sweep.

Only the summary receives `main-ci-failure`. The label is added after the complete
manifest is saved. A failure saving any occurrence or the summary routes nothing.
A label-write failure makes the reporter fail visibly. Rerunning the reporter
repairs partial writes, including a lost create response, using durable markers.
It does not create a second summary or duplicate occurrence comments. The label
must exist in the repository before this workflow is deployed.

The summary marker is `cez-main-ci-attempt:v1:<owner>/<repo>:<run-id>:<attempt>`.
The managed `cez-main-ci-reports` block records the source and member list. A saved
manifest that differs from the current evidence fails visibly instead of routing
a subset. The complete body has a 50,000-byte limit; exceeding it fails before
summary creation or routing. Do not remove members to fit the limit. User notes
outside the managed block survive reporter retries.

Replaying an attempt whose summary is closed leaves it closed and does not route
it. A different attempt gets a separate summary, even when it reuses signature
reports. The reporter never reopens a closed report. It changes no Cezar run state
and adds no database or required configuration.

## Local automation and repair ownership

The Cezar automation **Main CI — guarded repair** polls `issue.labeled` every five
minutes and requires the live `main-ci-failure` label. New installations are
created paused and must be enabled explicitly in the cockpit. It uses one
isolated task per match, allows human questions, and generates no follow-up tasks.
With historical matching off, enabling starts from that time; earlier reports
require deliberate manual handling. Reapplying a label is not recovery for an
existing task: continue that task instead.

Each task verifies source provenance through GitHub, checks current main and
later CI attempts, and checks assignments, claims, tasks and PRs for the summary
and every member before repair. A closed member remains diagnostic evidence.
The task checks whether its defect remains; a green retry alone does not establish
a fix. It records exact fixing evidence for members already repaired and identifies
aggregate job failures caused by another failed check.

One summary owns one combined repair PR. The task repairs all remaining verified
defects in its worktree, with regression evidence for each fix. If its PR is red
only on another listed member's test, it includes that member's verified remedy
in the same PR and verifies the combined changes. It does not open a sibling PR
or wait for one to merge. The PR links the summary and all member reports, with
closing references only for defects actually fixed. An unresolved member does not
close merely because another member passed. When no defects remain, the task
records fixing evidence for every member instead of opening an empty PR.

An active repair from an earlier attempt, a legacy task or an existing member PR
is competing work. Stop and ask the human in the same task. Do not take over,
close another PR or copy its commits without that decision. Continue recognizes
the task's own assignment and claim. Cross-attempt ownership transfer is outside
this change; routing one summary prevents competing repairs within one attempt.

Bounded repairs restore established behavior and end in a verified draft PR.
Unclear evidence, design conflicts or policy changes require a human decision in
the same task. Tasks never merge, weaken checks, quarantine tests, enable
automations or repeatedly rerun CI to obtain green. The summary groups evidence;
it does not approve every possible remedy. Human review still controls merging.

GitHub issues retain the diagnostic evidence and summary. Cezar retains matching
receipts and the task handoff. Each reported main CI attempt adds one summary
issue. A paused automation spends no runner tokens. When enabled, each newly
routed summary can start one repair task and consume tokens.

## Upgrade the repair prompt before reporter rollout

The previous automation prompt accepts only a signature report. Install the
compatible prompt **before** deploying summary routing. Otherwise a new summary
starts a task that rejects its evidence format. The compatible prompt accepts both
legacy reports and summaries; existing tasks keep their original instructions.
Do not cancel or relabel those tasks. Check their claims before starting repairs.

The checked-in prompt helper emits a partial update for the existing automation:

```sh
node .github/scripts/main-ci-repair-automation.cjs > /tmp/main-ci-repair-prompt.json
cez automation list
cez automation show <existing-id>
cez automation update <existing-id> --file /tmp/main-ci-repair-prompt.json
cez automation show <existing-id>
cez automation check <existing-id>
```

Use the ID of **Main CI — guarded repair**, not a new automation. Review its current
prompt before updating, so local policy is not lost. The patch contains only
`task.prompt`; the CLI merges task keys. Verify that enablement, runner settings,
filters, cursor and receipts remain intact. The final command previews matching
without launching tasks. Do not pass `--execute`, enable a paused automation or
create a duplicate. This implementation prepares the update; it does not change
a live automation. After the prompt update is verified, deploy the reporter.

## Verification

Reporter tests cover trusted event eligibility, cancelled-run failures,
evidence before routing, multiple causes and jobs, signature reuse, expired-log
replay, interrupted writes, lost responses, complete manifests and closed-summary
replay. The workflow test pins the trigger, permissions, trusted checkout and shared
lock. Release, Nightly and sweep reporting retain their existing coverage. The
prompt helper test validates that its CLI output updates only the prompt.
