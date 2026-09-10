# Release and Nightly failure reports

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

Scheduled analysis of all CI workflows, evidence thresholds for possible flaky tests, and recurring infrastructure patterns belong to [#205](https://github.com/hearsay-tools/cezarion/issues/205). This reporter implements immediate Release/Nightly reporting from [#204](https://github.com/hearsay-tools/cezarion/issues/204).

## Verification and references

`npm run test:unit` includes the reporter's node:test suites. The API fixture records selected metadata and a bounded excerpt from the real Release incident. Synthetic Nightly cases cover verification and publishing. Tests cover cause separation, recurrence, duplicates, partial writes, unavailable logs, bounded downloads, trusted checkout/permissions, and the workflow's executable entrypoint. Concurrent-delivery tests model the declared Actions queue; they do not claim that the JavaScript writer locks independent processes.

GitHub documents [completion events and their trust boundary](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run), [queued concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency), and [workflow triggering with GITHUB_TOKEN](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
