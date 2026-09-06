# Mobile Task Reading Implementation Plan

> **For agentic workers:** Execute inline with superpowers:executing-plans; approval was delegated by the parent on 2026-09-06.

**Goal:** Reclaim phone transcript space while retaining fork controls and document attachments.
**Architecture:** Port upstream 2c5522a8 before 1a2b8882 onto 29db8cb8, adapting existing components. CSS owns responsive visibility; mounted composer state survives disclosure and resize. Metadata disclosure memory uses project/run identity.
**Tech Stack:** React 19, TypeScript, Tailwind v4, Vitest, agent-browser.
**Spec:** Issue https://github.com/wjarka/cezar/issues/92 and parent-approved design in this task's handoff.

## Constraints

Preserve composer labeling, effort/account/model/monitoring, PDF/TXT/MD attachments, desktop behavior. No new polling/subscriptions. Disclosure targets ≥44×44 on phones; native keyboard buttons with expanded state; reduced motion. Keep PR draft for parent merge.

## 1. Regression tests and upstream port

- [x] Run baseline component tests after npm ci.
- [x] Port upstream component/e2e tests first; add a real header rerender A→B→A and project A→B→A regression plus remount retention.
- [x] Add composer test: type multiline draft, select range, paste PDF/TXT/MD, expand/collapse; assert same textarea node/value/selection and attachments, Send and Attach remain reachable.
- [x] Run `npm test -- packages/web/src/components/composer/composer.test.tsx packages/web/src/routes/task-thread/run-header.test.tsx` and confirm missing disclosure failures.
- [x] Apply source hunks from 2c5522a8 then 1a2b8882 preserving fork edits. Change disclosure key to JSON.stringify([projectId, run.id]); read map on every render. Use md:block for metadata and md:hidden on toggle; monitoring schedule stays outside.
- [x] Add opt-in thread composer disclosure. Keep text input and footer controls mounted; collapse with responsive CSS, keep Attach/Send/disclosure visible. Restore full desktop layout through md styles without listeners. Clamp compact textarea to one row; expanded uses existing autosize.
- [x] Run focused component tests. Strengthen any upstream assertions that merely inspect class names with browser geometry checks.

## 2. Browser regression and QA

- [x] Extend packages/web/e2e/task-thread.e2e.ts with 360×640 visible transcript area, no horizontal overflow, collapsed/expanded metadata/composer, keyboard Enter/Space and target measurements.
- [x] Exercise Session/Changes/Commits/Files, plans/no plan, long metadata, same-instance run switching, phone→desktop→phone, multiline selection and document chips. Assert desktop controls visible without a toggle.
- [x] Build then run focused E2E through packages/web/e2e/vitest.config.ts; use agent-browser provider and isolated CEZ_HOME. Inspect screenshots at phone/desktop in light/dark and reduced motion. Record actual outcomes including loading/error access.
- [x] Confirm baseline source fails meaningful new regression assertions, retaining tests while temporarily restoring only changed source files.

## 3. Verification and delivery

- [x] Run npm run typecheck, npm test, npm run test:unit, npm run build, npm run test:package and the five affected browser suites; read results and fix failures. The wrapper doctor cannot pass its CDN probe in this container; use the verified cached provider directly. Broader thread-scroll failures were reproduced on baseline and are documented in the QA report.
- Delivery: Review final diff for preserved fork features and no added subscriptions. Commit Conventional Commit, push branch, open draft PR against main with Closes #92 and AC/QA evidence.
- Delivery: Move board to In review, invoke pr-checks, monitor CI and inline feedback, fix actionable issues and rerun affected checks. Keep draft; do not merge.

QA evidence: [.ai/qa/2026-09-06-mobile-task-reading.md](../../../.ai/qa/2026-09-06-mobile-task-reading.md).
