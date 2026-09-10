# Recurring CI Failure Sweeps Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for bounded delegated tasks and inline integration. Steps use checkbox syntax for tracking.

**Goal:** Detect recurring CI failures across unrelated changes and report them without duplicating immediate reports.

**Architecture:** Collect attempt-specific evidence in bounded creation windows, classify deterministic patterns, and publish through the existing reporter's extracted writer. Durable issue markers are the only required report state; manifests describe coverage.

**Tech Stack:** Node CommonJS, node:test, GitHub REST through github-script, YAML Actions.

**Spec:** `.ai/specs/2026-09-10-recurring-ci-failure-sweeps.md` (approved).

## Global constraints

- Retain v1 signatures, occurrence markers, unknown-log reconciliation and immediate Release/Nightly behavior.
- Shared concurrency `release-nightly-failure-reports`, `queue: max`, `cancel-in-progress: false`.
- Daily 04:23 UTC, 14-day original-run-creation window; bounded manual UTC replay within 90 days.
- Limits: 1,500 requests, 20 attempts/run, 100 logs, 2 MiB/log, 50 MiB total logs, 10 new issues, 100 new occurrence comments, 12-minute application deadline, 15-minute job timeout.
- No raw diagnostics in operational output; no source code execution; contents:read/actions:read/issues:write only.
- Commit only after all five repository verification commands pass; keep intermediate work reviewable in the diff.

## Task 1: Shared reporter and structured diagnosis

Files: extract `.github/scripts/failure-issue-writer.cjs` from `report-workflow-failure.cjs`; modify `failure-diagnostics.cjs`; extend their existing node:test suites.

Interface: `createFailureWriter({github,owner,repo,log,maxIssues,maxOccurrences})` returns `{issues,commentsFor,reportStep}`. `reportStep({run,job,step,causes,labels,bodyFor})` returns an array of `{issue,cause,reported}`; defaults preserve immediate reporting. `bodyFor` is an optional factory receiving the existing formatter arguments. Limits apply only to new writes. The factory must enumerate issues completely before any write.

Diagnosis adds `kind` (test/error/unknown), full `testIdentity` and `testFile` for tests, and `failureIdentity` for independent source-occurrence identity. Existing signature inputs stay unchanged. Structured raw identity is internal only.

- [x] Add consumer tests for same occurrence through two writer instances, closed recurrence, write failure repair, and limits; extend parser tests to expose untruncated identities with unchanged signatures.

```js
assert.equal(causesForStep(input)[0].kind, 'test');
assert.equal(causesForStep(input)[0].testIdentity, 'src/a.test.ts > works');
```

- [x] Run `node --test .github/scripts/failure-diagnostics.test.cjs .github/scripts/report-workflow-failure.test.cjs .github/scripts/failure-issue-writer.test.cjs` and record expected failures for new behavior.
- [x] Extract the writer with no immediate behavior change, implement structured identity and bounded writes, rerun existing and new tests.

## Task 2: Bounded collection and coverage

Files: create `.github/scripts/ci-sweep-api.cjs`, `ci-sweep-collect.cjs`, their `.test.cjs` files and `.github/scripts/fixtures/sweep-harness.cjs`.

Interfaces: `createSweepApi({github,now,limits})` supplies bounded `request`, `paginate`, `downloadLog`, `manifest`, and `problem(code,ids)`. `collectSweep({api,owner,repo,start,end})` returns `{occurrences,attempts}`. Occurrence shape is `{run,job,step,cause}`. Attempts retain all job/step conclusions for comparison; only completed failure/timed_out evidence becomes an occurrence.

- [x] Test real collection against API fixtures for successful reruns, all paths, second pages, repeated boundary rows, cancellations, malformed/absent metadata, request/log/deadline caps, partial reads and exhausted issue enumeration.

```js
assert.equal(result.occurrences.length, 1); // attempt 1 failed; latest attempt passed
assert.equal(result.occurrences[0].run.run_attempt, 1);
assert.equal(result.attempts.length, 2);
```

- [x] Observe failures before creating collector implementations.
- [x] Implement fixed-window validation, recursive run query splitting at 1,000 results, explicit attempt/job paging, numeric coverage entries, safe partial errors and streaming log budget enforcement.
- [x] Rerun fixtures; incomplete scans retain a false completeness flag and explicit replay intervals.

## Task 3: Classification and report integration

Files: create `.github/scripts/ci-sweep-patterns.cjs`, `ci-sweep-report.cjs`, `sweep-ci-failures.cjs`, their `.test.cjs` files.

Interfaces: `classifyPatterns({occurrences,attempts,owner,repo})` returns `{cause,occurrences,comparisons,classification,counts}` patterns. `reportPatterns({api,owner,repo,patterns,start,end})` returns issue/occurrence totals. `sweepCiFailures({github,owner,repo,start,end,now,limits})` orchestrates collection and reporting and returns the safe manifest.

- [x] Write fixtures for two independent test failures plus same-run/SHA successful job+step comparison; three distinct failed runs across unrelated contexts; isolated branch/SHA cases; distinct test diagnostics; unknown causes.

```js
assert.equal(patterns[0].classification, 'possible-test-flakiness');
assert.equal(patterns[0].counts.failures, 2); // passing retry is not a failure
```

- [x] Observe red, implement conservative classification and source-identity deduplication.
- [x] Add reporting fixtures for existing immediate issues, exact-identity corroborated remediation adoption, ambiguous owners, bounded summary updates, labels, closed recurrences and lost write responses. Observe red, then implement through the shared writer.
- [x] Verify overlap produces no new occurrence comments or unchanged summary updates; failed reads produce no deduplication-dependent writes.

## Task 4: Trusted workflow, operator docs and full verification

Files: create `.github/workflows/sweep-ci-failures.yml`, `.github/scripts/ci-sweep-workflow.test.cjs`; update `docs/failure-reporting.md`, `docs/sdlc/ci.md` and approved spec/plan status.

- [x] Write YAML boundary and executable entrypoint tests with fake GitHub/core/fs. Pin trusted default checkout, shared concurrency, permission scope, validated manual inputs, always-written safe manifest and artifact upload.

```js
assert.deepEqual(workflow.jobs.sweep.permissions, {actions:'read',contents:'read',issues:'write'});
assert.equal(result.failed, true); // incomplete fixture must fail visibly
```

- [x] Observe red, add workflow and entrypoint; rerun all reporter/sweep tests.
- [x] Document positive/negative thresholds, original creation boundary, replay commands, retention, limits, incomplete recovery, false-match refinement and immediate reporter compatibility.
- [x] Review the integrated diff and prove regression tests fail against unfixed source; resolve findings.
- [x] Run in order: `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`.
- [ ] Commit, push, merge latest origin/main if necessary and rerun checks on changes, open draft PR closing #205, sync board In review, run pr-checks through CI verdict.
