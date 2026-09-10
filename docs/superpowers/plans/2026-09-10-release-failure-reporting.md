# Release Failure Reporting Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task in the existing isolated worktree.

**Goal:** File durable, deduplicated Release/Nightly failure issues.
**Architecture:** A trusted completion consumer serializes writes. Pure diagnostics helpers produce cause signatures; a GitHub API reporter persists issue and occurrence markers.
**Tech Stack:** Node CommonJS, node:test, GitHub Actions github-script, existing YAML parser for workflow contract tests.
**Spec:** .ai/specs/2026-09-10-release-failure-reporting.md

## Global Constraints

- No new dependencies or runtime CEZ_* flags; no changes to publishing workflows.
- Minimal contents:read, actions:read, issues:write permissions; trusted default-branch code only.
- 2 MiB downloaded logs, 4,000-character diagnostic excerpts; area-ci applied directly.
- Preserve cause identity across workflows only with identifiable evidence.

## Task 1: Diagnostics and fixtures

Files: .github/scripts/failure-diagnostics.cjs, .github/scripts/failure-diagnostics.test.cjs, .github/scripts/fixtures/release-failure.json.
Interface: causesForStep({run, job, step, log}) returns [{signature, title, excerpt, stage}]; sanitize(text) returns safe text.

- [x] Save selected API fields and bounded incident log as fixture; document provenance.
- [x] Write tests comparing signatures for the same test across workflows and different tests in one step; assert credentials and mentions cannot survive rendering.
- [x] Run `node --test .github/scripts/failure-diagnostics.test.cjs` and confirm red.
- [x] Implement pure parsing, SHA-256 signatures, stage classification and sanitization.
- [x] Re-run targeted tests and confirm green.

Example consumer assertion:
```js
assert.equal(causesForStep(release)[0].signature, causesForStep(nightly)[0].signature);
assert.notEqual(causesForStep(testA)[0].signature, causesForStep(testB)[0].signature);
```

## Task 2: Reporter persistence and trusted workflow

Files: .github/scripts/report-workflow-failure.cjs, .github/scripts/report-workflow-failure.test.cjs, .github/workflows/report-workflow-failure.yml.
Interface: reportFailure({github, owner, repo, event, log, fetchImpl}) returns {reported}; GitHub APIs and fetch are the only external boundaries.

- [x] Write stateful API fixture tests for create/update/closed matching, deduplication, exact attempts, partial writes and API failures.
- [x] Run `node --test .github/scripts/report-workflow-failure.test.cjs` and confirm red.
- [x] Implement event validation, paginated reads, bounded job log downloads, issue/comment markers and concise issue bodies.
- [x] Add the completion workflow with a global queue and trusted checkout. Execute its github-script in tests; assert failures call setFailed and write summary.
- [x] Re-run `.github/scripts/*.test.cjs`; verify concurrent deliveries under the workflow queue produce one occurrence.

Example recovery assertion:
```js
await reportFailure(options);
await reportFailure(options);
assert.equal(state.issues.length, 1);
assert.equal(state.comments.length, 1);
```

## Task 3: Documentation, full verification and draft PR

Files: docs/failure-reporting.md, docs/publishing.md (link).

- [x] Explain filters, matching examples, permissions, durable markers, closed matches, unavailable logs, queue limits, replay and #205 boundary.
- [x] Run the five repository verification commands in spec order; fix any failures and record evidence.
- [ ] Review the diff and test coverage; commit one logical feature using Conventional Commits.
- [ ] Fetch and merge origin/main, repeat checks if changed, push and open a draft PR closing #204 using the repository template.
- [ ] Move the issue to In review and execute pr-checks through CI/review verdict.
