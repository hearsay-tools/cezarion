# Release and Nightly failure reporting (#204)

Approved in conversation on 2026-09-10. Broad scheduled CI pattern detection belongs to #205.

## Design

A new workflow_run completion consumer runs trusted default-branch code, checks workflow name and path and same-repository origin, and reports only failed Release/Nightly attempts. Release accepts main and release/*; Nightly accepts main. No publishing credentials, source checkout, source artifacts, model, or shell execution of diagnostics. Permissions: contents:read, actions:read, issues:write. Existing workflows are unchanged.

A CommonJS reporter under .github/scripts uses GitHub APIs to read the exact event attempt, paginate jobs and issues/comments, and collect failed steps. Job logs are bounded to 2 MiB; reports retain at most 4,000 characters per cause. Timestamps restrict logs to failed steps. Each recognizable Vitest FAIL record identifies a cause by full test path/name and error diagnostic when present, independent of workflow; error records use stage, step and normalized diagnostic. Volatile timestamps/addresses are normalized without dropping test identities. Unknown causes use run/attempt/job/step identity and remain separate. Missing logs always produce a useful metadata report. No claim of flakiness follows solely from repetition.

Issues follow task.yml and issue-authoring conventions, labeled area-ci directly. Human bodies describe investigation and a verified fix; Agent context comments retain workflow, job, step, commit, branch, attempt, timestamps, run/job links, and escaped/redacted excerpts. Metadata is untrusted too. Redact credentials, private keys, sensitive assignments, URL queries and recognizable tokens; neutralize mentions, HTML, workflow command syntax, and Markdown fences. No raw diagnostics enter Actions logs or summaries.

## Persistence and concurrency

A single repository-wide Actions concurrency group serializes all issue writes with queue:max and cancel-in-progress:false. GitHub permits 100 pending jobs; overflow is an explicit operational limit, recoverable by rerunning the reporter with the original payload. No mutable local state is required. Hidden versioned SHA-256 signature markers identify causes; occurrence markers include run, attempt, job, step, and signature. Paginated list APIs avoid search-index lag. Matching open issues receive one comment per occurrence. New issues link the latest closed match. Duplicate events after closure do not create a recurrence. A body marker reserves the original occurrence; retry repairs a missing first comment. An ambiguous API write error fails the reporter; rerunning reads persisted markers before retrying writes.

## Failure handling

Malformed event metadata fails visibly before writes. Unrelated events and non-failure conclusions are ignored. A job-log failure warns with a fixed message and still reports metadata. Issue/metadata API failures fail the reporter with a sanitized summary; the source workflow conclusion remains untouched. Reporter failures never recursively file issues. Conservative matching can split similar incidents; maintainers can transfer a signature marker to an existing remediation issue and remove it from a duplicate to refine matching.

## Verification

API fixtures: Release attempt 1 of run 34473233122 (job 102857807749 failed verification; release skipped), representative Nightly verification and publishing. Tests cover filters, exact historical attempts after rerun, failed-step extraction, cross-workflow tests, distinct causes, open/closed matching, partial writes, duplicate delivery, serialized concurrent jobs, missing/oversized logs, redaction and API failure surfacing. Workflow contract tests parse YAML and execute the github-script entrypoint with fake APIs. Full repository checks: npm run typecheck; npm test; npm run test:unit; npm run build; npm run test:package.
