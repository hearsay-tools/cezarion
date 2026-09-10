# CI failure reporting

`Report Release and Nightly Failures` creates `area-ci` issues after failed Release or Nightly attempts. It starts working when `.github/workflows/report-workflow-failure.yml` reaches the default branch. It does not retry publishing or change the original run's conclusion.

Release runs on `main` and `release/*` qualify; Nightly runs on `main` qualify. Both workflow name and file path must match, and the source repository must match. Success, cancellation, intentional skips, and other workflows produce no reports. The reporter fetches the event's exact attempt, including when a later attempt has already started. Failed or timed-out jobs within a failed run contribute reports; skipped dependent jobs do not. A failed job with no recorded failing step still produces a metadata report.

## What an issue contains

The human body follows `.github/ISSUE_TEMPLATE/task.yml`: context, work to do, acceptance criteria, links, and scope. Each **Agent context** comment records workflow, stage, failed job and step, commit, branch, run attempt, timestamps, run/job links, and a bounded diagnostic excerpt. A stage distinguishes verification, publishing, finalization, and setup. For example, Release run [34473233122, attempt 1](https://github.com/hearsay-tools/cezarion/actions/runs/34473233122/attempts/1) failed in `Run server and cockpit unit suites`; its dependent publishing job was skipped.

The workflow applies `area-ci` itself. It does not rely on issue-intake: events caused by `GITHUB_TOKEN` ordinarily do not trigger another workflow. The generated issue asks for diagnosis and a verified fix. Repetition alone does not establish that a test is flaky.

## Matching and duplicate handling

The versioned matching rule lives in `.github/scripts/failure-diagnostics.cjs`:

- Recognizable Vitest `FAIL` records use test file, test name, and the error diagnostic when present. The same identifiable test can collect occurrences from Release and Nightly despite their different job names
- Other recognizable errors use stage, failed step name, and normalized diagnostic text. Generic exit-code messages alone cannot identify a cause
- Timestamps, durations, and memory addresses do not identify causes. Different test names remain separate, even in the same failed step
- Missing or unrecognizable logs use run, attempt, job, and step identity. Uncertain failures remain separate across runs; available unrecognized diagnostics still appear as a bounded excerpt

A SHA-256 signature marker in the issue body identifies a cause. An occurrence marker in the comment identifies run, attempt, job, step, and signature. The issue body reserves its first occurrence before its comment is written. A retry can repair that comment without creating another issue. Changed log availability preserves existing occurrence identities; a later successful download does not turn a previously reported unknown failure into a duplicate issue.

The writer lists issues and comments with pagination rather than relying on search indexing. Open matches receive new occurrence comments. A genuine recurrence after closure creates an issue linking the latest closed match. A duplicate delivery of an already reported occurrence does not create a recurrence after closure. Partial writes and lost responses fail visibly; rerunning the reporter rereads markers before writing.

All reporter jobs share the `release-nightly-failure-reports` Actions concurrency group, with `cancel-in-progress: false` and `queue: max`. This is the cross-process lock; the JavaScript function alone does not provide distributed locking. Any future writer sharing these markers must use the same group. Up to 100 runs can wait; GitHub cancels additional arrivals when that queue fills. A cancelled reporter requires a manual rerun. Avoid changing the group during a rollout while an older reporter is still active.

## Logs, permissions, and failures

The workflow checks out the default-branch event SHA with persisted credentials disabled. It uses only `contents: read`, `actions: read`, and `issues: write`. It never checks out source-run code, downloads executable artifacts, invokes an agent, or receives npm/publishing credentials. Signed log downloads carry no reporting token and stop above 2 MiB or after 30 seconds. Each excerpt retains at most 4,000 characters. Oversized or expired logs fall back to metadata rather than publishing an arbitrary truncated tail.

Sanitization removes recognizable credentials, sensitive assignment lines, private keys, URL credentials/query strings, and long token-like values. It neutralizes mentions, HTML, Markdown fences, control characters, and Actions command delimiters. Diagnostic text appears as indented, explicitly untrusted evidence. Sanitization is defense in depth, not permission to print secrets in CI: source jobs must continue masking credentials, and arbitrary short secrets without a recognizable form cannot be inferred from text. Only numeric run/job/issue references and fixed messages enter reporter logs and summaries.

Missing logs produce a visible summary note and a useful issue. Metadata or issue API failures fail the reporter with a fixed error message, without dumping API error objects or request headers. There is no issue about the reporter itself. Its Actions job and summary are the monitoring surface. The 10-minute timeout bounds an attempt; a large repository or API throttling can require a rerun.

To recover, open **Actions → Report Release and Nightly Failures**, select the failed or cancelled reporting run, and rerun the reporting job. This replays the original event and does not rerun Release or Nightly. Check repository Actions token policy if issue writes return permission failures. Preserve markers when editing reports; removing them removes the deduplication record. Deleting a report also deletes that record.

## Refining matches

A maintainer can add a cause's exact `cez-failure-signature:v1` marker to an existing remediation issue's body and remove that signature marker from an unwanted duplicate. Move the relevant occurrence markers/evidence too when preserving deduplication history. Keep one open owner for each signature. Transfer only the intended cause marker; never replace other markers already owned by the destination issue.

For systematic false matches, add positive and negative fixtures to `failure-diagnostics.test.cjs` and change the matching rule deliberately. Document marker compatibility when changing signature inputs. A test can fail for multiple reasons, and conservative error matching can split related incidents; inspect evidence before merging reports or declaring flakiness.

The immediate reporter implements [#204](https://github.com/hearsay-tools/cezarion/issues/204). The scheduled sweep below implements [#205](https://github.com/hearsay-tools/cezarion/issues/205), reusing the same writer and marker conventions.

## Verification and references

`npm run test:unit` includes the reporter's node:test suites. The API fixture records selected metadata and a bounded excerpt from the real Release incident. Synthetic Nightly cases cover verification and publishing. Tests cover cause separation, recurrence, duplicates, partial writes, unavailable logs, bounded downloads, trusted checkout/permissions, and the workflow's executable entrypoint. Concurrent-delivery tests model the declared Actions queue; they do not claim that the JavaScript writer locks independent processes.

GitHub documents [completion events and their trust boundary](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run), [queued concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency), and [workflow triggering with GITHUB_TOKEN](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).


## Daily sweep across CI workflows

`Sweep Recurring CI Failures` runs daily at **04:23 UTC**. It discovers runs from
all repository workflow paths, including disabled/deleted workflows and runs whose
latest conclusion is success. It reads every historical attempt and paginates each
attempt's jobs. Latest-attempt metadata comes from the run-list snapshot, avoiding
one redundant request per run. Earlier attempts use the attempt metadata endpoint.
Only failed/timed-out jobs contribute failures; passing jobs are comparison evidence.
Cancelled attempts/jobs and skipped jobs never contribute failure occurrences.
The reporting workflows contribute only a count of failed attempts in the summary,
including failed attempts followed by successful reruns; they never create issues.

The default window covers **runs originally created in the preceding 14 days**.
It is not an updated-time window. A new retry of an older run needs a manual replay
of that run's original creation window. Every summary and manifest names these
bounds. Run queries that reach GitHub's 1,000-result filtered-search limit split
into smaller intervals; an interval that cannot be completely enumerated fails
visibly. Duplicate rows never increase failure counts.

### Evidence thresholds

The sweep reuses the immediate reporter's conservative signatures. It does not
cluster by workflow/job name alone or infer a cause from a generic exit code.
Distinct tests and distinct diagnostic symptoms stay separate. Missing logs cannot
establish a recurring cause. Test paths choose the appropriate existing
`area-cezar`, `area-web`, `area-contract`, or `area-api-client` label; infrastructure,
build errors, ambiguous paths and unavailable labels use `area-ci`.

A change context is a PR (repository and PR number), or a repository/branch when
there is no associated PR. Multiple commits on one PR or branch remain one context.
Ambiguous PR association cannot strengthen independence. Sharing a SHA across
workflows cannot establish independence either.

| Classification | Required evidence |
| --- | --- |
| Possible test flakiness | At least two failed occurrences of the same identifiable test/diagnostic on distinct SHAs and independent contexts, plus a later successful attempt of the same run and SHA with an unambiguous matching successful job and test-running step |
| Recurring failure | At least three distinct failed run IDs, two distinct SHAs, and two independent change contexts for the same identifiable cause |

A passing run whose relevant job or step was skipped is not a passing comparison.
Incomplete job lists and rejected metadata cannot establish unambiguous pass
comparisons. Several retries of one failed run cannot satisfy the recurring-run
threshold. A successful unchanged-SHA retry signals **possible** flakiness only:
runner, dependency, and infrastructure changes can also explain it.

Examples:

- The same test/diagnostic fails on PRs A and B; an unchanged-SHA retry on A passes
  the matching job and step: possible test flakiness.
- The same recognizable package download error appears in three runs across two
  unrelated PRs: recurring failure, without a flakiness claim.
- A test fails three times while its author pushes fixes to one PR: no pattern issue.
- Two different tests fail in the same test step: separate causes, each needing
  its own threshold. The two symptoms described in #195 must not be merged merely
  because they share a suite.

### Reusing reports and reading counts

The sweep shares `failure-issue-writer.cjs`, v1 signatures/occurrences, reservation
repair, and the exact Actions concurrency group with the immediate reporter.
Open matches receive missing occurrence comments. Already recorded failures add
no duplicate comments, even after closure; new recurrences link a closed report.
Each affected issue also gets one marked sweep-summary comment per signature,
updated only when its evidence set changes. It records window counts, affected
workflows, failure links, successful comparison links, and uncertainty. Counts
refer to the printed creation window, not lifetime totals; partial scans provide
lower bounds. Lists retain at most 20 links of each kind, with full failure
metadata preserved in the individual bounded occurrence comments.

An unmarked open remediation issue can be adopted when its body/comments contain
both the exact test file and an exact quoted, standalone, or full `file > name`
test identity plus a corroborating run-attempt or failed-job link. Longer filenames
and longer test names do not match a shorter identity. The sweep preserves the issue body and appends the signature marker. A suite
filename or broad CI title alone is not a match. Multiple plausible owners make
coverage incomplete and produce no duplicate issue for that cause. Maintainers
can resolve ambiguity by transferring the exact signature and occurrence markers
as described under **Refining matches**. Keep one open owner per signature.

### Bounds, coverage, and recovery

Each invocation permits at most 1,500 GitHub requests, 20 attempts per run,
100 downloaded logs, 2 MiB per log, 50 MiB total downloaded logs, 10 newly created
issues, and 100 new failure-occurrence comments. Summary comments and updates also
consume the shared API budget. The application deadline is 12 minutes; the Actions
job timeout is 15 minutes. Requests and log fetches have bounded timeouts.

A missing/expired log, partial page, invalid source identity, in-progress attempt,
rate limit, exhausted cap, ambiguous owner or failed write marks coverage incomplete.
Known qualifying evidence may still be reported if lookup coverage and remaining
budgets permit. A partial issue/comment index never authorizes a new report.
The workflow fails visibly when incomplete and writes `ci-sweep-coverage.json`,
uploaded as `ci-sweep-coverage-<run>-<attempt>` with 90-day requested retention
(subject to repository policy). It contains only fixed codes, validated bounds,
numeric source IDs and counts. No raw logs, arbitrary metadata, signed URLs or
API errors enter Actions logs, summaries, or the coverage artifact.

The manifest records requested and enumerated intervals, processed runs/attempts/jobs,
problem codes and replay bounds. The artifacts are evidence, not required mutable
state. Each daily sweep rereads the whole overlapping window, and issue markers
remain the authority for duplicate prevention. Missing artifacts do not prevent
rebuilding. Reports retain evidence after source logs expire; expired logs themselves
cannot be reconstructed. Deleting reports or markers deletes their deduplication
history. No scan cursor advances over incomplete work.

For ordinary transient errors, the next daily sweep retries overlapping coverage.
For persistent caps, inspect the artifact and manually replay smaller windows until
all intervals complete. Delays beyond the 14-day window require explicit replay of
the missing creation intervals. Replays allow at most 14 days per invocation and
must start within 90 days of invocation; endpoints are inclusive UTC seconds.
There is no claim of coverage outside the printed bounds or of recovery after
GitHub has expired the underlying evidence.

Use **Actions → Sweep Recurring CI Failures → Run workflow** on the default branch.
Leave both inputs empty for the normal window, or supply both UTC endpoints. The
CLI equivalent for this repository is:

```bash
gh workflow run sweep-ci-failures.yml --repo hearsay-tools/cezarion --ref main \
  -f start=2026-09-01T00:00:00Z -f end=2026-09-08T00:00:00Z
```

Dispatch on a non-default branch is skipped by the job guard. The job checks out
the trusted default-branch event SHA with persisted credentials disabled. Permissions
are contents-read, Actions-read and issue-write; no source code, artifacts or log
instructions are executed. Replaying a sweep never reruns source CI or publishing.
The shared queue holds at most 100 pending reporter jobs; recover cancelled overflow
by manually replaying the corresponding window.

**Validation boundary:** local API fixtures execute collection, classification,
shared writing and the workflow entrypoint, including interrupted writes and
serialized immediate/sweep deliveries. The schedule itself activates only after
merge to the default branch. Observe the first scheduled scan's summary and
coverage artifact; do not deliberately fail production CI to exercise it.
