# CI wait conflict outcomes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** End a registered CI wait when its same-head PR is explicitly conflicting.
**Architecture:** Extend existing metadata reads, preserve scheduling and durability, carry the result through the shared contract and existing delivery/UI.
**Tech Stack:** TypeScript, Zod, Vitest, native runner harnesses.
**Spec:** .ai/specs/2026-10-20-ci-wait-conflicts.md

## Global Constraints
- Keep 30-second probes, 1,800-second default/7,200-second max wait, 60-second discovery, ten-second query bounds, four watchers and 1/5/15-second retries.
- Head changes precede conflict; UNKNOWN/advisory statuses alone never produce conflict.
- No new authority/configuration; preserve atomic outcome/input and no-session recovery.
- Latest human instruction authorizes autonomous execution after design presentation; no more confirmation questions. Do not write anything to Squeal's repository.
- Work in the existing governed worktree/branch and update existing draft PR #1347. No merge of the PR.

## Review Focus
- Final-read metadata supersedes stale conflict; test before/after snapshot race.
- Native watch must abort/reap on conflict; test pending watch teardown and capacity.
- Null/future fields do not cause false conflict; test normalization and malformed types.
- Recovery has no active session; test committed result/input before continuation.
- New strict outcome prevents downgrade readability; release-note limitation and old-result parse test.

### Task 1: Metadata and supervisor
**Files:** packages/contract/src/ci-wait.ts; packages/cezar/src/ci-wait/{github.ts,supervisor.ts,scheduling.test.ts,supervisor.test.ts,contract.test.ts,fixtures/gh.mjs}.
**Interfaces:** GithubCiClient.metadata(pr, signal) returns validated {headSha,mergeable,mergeStateStatus}; resolve/head retain original identity-only return surfaces. Result gains optional mergeable/mergeStateStatus and conflicting outcome.
- [ ] Write failing tests for pending-watch conflict, snapshot races, metadata normalization/contract fields; observe expected red.
- [ ] Implement metadata reads replacing head probes; use final snapshot metadata, preserve abort checks, retain metadata on all later observations, conflict precedence and bounded diagnostics.
- [ ] Run focused suites via Squeal, validate known neighboring tests; commit.

### Task 2: Lifecycle and native-wire regressions (governed worker)
**Files:** packages/cezar/src/workflows/*ci*parity*, waits parity cells/guard, workflow CI/store tests, AGENT_PROTOCOL.md only if matrix registration requires.
**Interfaces:** Consume Task 1 outcome and fields. Native RUNNER_IDS/HARNESS_ADAPTERS matrix observes conflict result persisted and delivered fresh/continued/recovered, no active session, no automatic timer or repair authority.
- [ ] Add exhaustive registered parity cells with native mock wires; prove relevant test red without fix.
- [ ] Assert atomic committed row outcome/input on persistence boundary, duplicate/cancellation/restart behavior; no source lifecycle change unless proven necessary.
- [ ] Verify focused cells; commit and report evidence. Parent reviews/cherry-picks deliberately.

### Task 3: Presentation, release notes, integration
**Files:** packages/web/src/routes/task-thread/run-waits.tsx and run-waits.test.tsx; CHANGELOG.md; proposal status.
- [ ] Add failing UI label cell for conflicting, then map to plain conflict wording retaining no-approval caveat; no style changes.
- [ ] Document strict old-reader downgrade limitation and mark design accepted for implementation by latest autonomous instruction.
- [ ] Typecheck/build; read focused browser/unit Squeal results. Integrate worker, whole-branch governed review, fix findings and prove red/green.
- [ ] Refresh main, update draft PR/body and issue summary, monitor CI/review per pr-checks; keep draft, never merge.
