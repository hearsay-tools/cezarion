# Document Attachments Implementation Plan

> Execute inline with superpowers:executing-plans and test-driven-development.

**Goal:** Port #91 document attachments while retaining fork behavior.
**Architecture:** Shared contract vocabulary, engine-only pasted file inputs, persisted paths and existing image transport. All four routes remain chained and middleware-validated.
**Tech Stack:** TypeScript, Zod, Hono, React, Vitest, agent-browser.
**Spec:** .ai/specs/2026-09-05-document-attachments.md

## Global constraints

Preserve images keys/URLs, four mixed files per request, eight queued attachments, 5,242,880-byte composer files, 7,000,000-character API data. No runner ContentBlock addition, dependency, env knob or version change.

## 1. Contract, API and delivery

Files: packages/contract/src/runs.ts; packages/cezar/src/server/server.ts; packages/cezar/src/workflows/run.ts; adjacent attachments-api, pasted-attachments, continue-run, queued-messages and run tests.

- [x] Apply upstream API tests alone: `git show --format= ff9c44ed -- packages/cezar/src/server/attachments-api.test.ts | git apply`.
- [x] Run `npm test -- packages/cezar/src/server/attachments-api.test.ts`; confirm PDFs fail with 400 before the port.
- [x] Adapt ff9c44ed contract and engine diff, mapping every route through toPastedContent while retaining fork c.req.valid middleware and chained families.
- [x] Port upstream delivery regressions and run API/delivery tests; verify images still arrive as blocks and documents only as saved paths.

## 2. Attachment confinement and boundaries

Files: new packages/cezar/src/workflows/attachment-path.ts and test; serving and persisted-file readers; API and composer test files.

- [x] Write real filesystem tests: regular file resolves; traversal and encoded separators reject; symlink to an outside file or directory rejects. Assert the serving route never returns outside bytes and hydration never exposes an outside path.
- [x] Run focused tests to demonstrate red before adding the shared resolver.
- [x] Resolve validated names under the run attachment directory, check realpath containment and regular-file status, and use the helper for serving and hydration.
- [x] Assert API accepted data length 7_000_000 and rejected 7_000_001; accept four mixed entries and reject five in each attachment body. Assert composer accepts 5_242_880 bytes and rejects 5_242_881.
- [x] Exercise fresh, live, queued, deferred, continuation and restart delivery plus missing file notes; run focused suites.

## 3. Composer and persisted display

Files: composer-attachments.ts and tests, composer.tsx and tests, thread-items.tsx and tests, new-task and follow-up input types, handoff.ts, README.md, BACKWARD_COMPATIBILITY.md.

- [x] Port upstream composer tests and intake implementation; preserve the fork textarea label and submit behavior.
- [x] Add failure/draft, keyboard/removal and accessible persisted-link assertions; use 44px targets.
- [x] Run composer/thread tests; record document download headers and backward-readable image behavior in docs.

## 4. Verification and delivery

- [x] Run required commands in order: npm run typecheck; npm test; npm run test:unit; npm run build; npm run test:package.
- [x] Run npm run test:e2e and manual agent-browser attachment QA at 360x640 and desktop, light/dark and reduced motion; retain concrete evidence.
- [x] Review diff for fork preservation, obtain code review, fix findings and rerun relevant checks.
- [x] Commit, push, create draft PR closing #91 with AC outcomes and verification evidence; move board to In review.
- [ ] Use pr-checks to handle CI and inline reviews, retain draft and update rolling handoff.
