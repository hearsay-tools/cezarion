# Unified composer actions implementation plan

> Execute the approved issue #201 design in this worktree using test-driven development; use subagent-driven-development for the engine task and review while the controller owns composer integration.

**Goal:** Continue, Send and Stop share the task composer and preserve work and drafts.
**Spec:** https://github.com/hearsay-tools/cezarion/issues/201 (body and Agent context), approved in this session.
**Architecture:** Keep POST /continue and POST /cancel. Continue supports cancelled, never-started original executions via the existing persisted queue. The shared composer renders action state, while task-thread owns mutations and follow-up-engine owns identity selections.
**Tech stack:** TypeScript, Zod, Hono, React, Vitest.

## Global constraints
- No dependencies or configuration. Preserve existing continuation semantics and backend/account affinity; model-only changes resume.
- Preserve parent/worker ownership, pending questions and provider guards. Stop must remain reachable during monitoring and worker wait.
- Keep 44×44 action targets, mobile 360×640, both themes and reduced motion. No art per issue.
- Preserve drafts through stopping, failed/offline/conflicting requests; pending actions prevent double requests.
- Contract changes use optional Zod fields, middleware/chained routes and parity tests.

## Task 1: Engine requeue and stopping lifecycle
Files: packages/cezar/src/workflows/run.ts and focused engine tests; packages/contract/src/runs.ts and store schema if required.
- [x] Write tests for stopped unstarted requeue, original inputs/attachments and selected identity, capacity/restart, duplicate attempts, Stop during startup/termination.
- [x] Confirm new tests fail on existing implementation.
- [x] Extend continueRun only for provably never-started cancelled records, preserving guards; use durable original inputs and normal scheduler. Reject replay of completed steps.
- [x] Surface optional stopping boolean on run while Stop awaits termination; clear on confirmed terminal/recovery transitions. Coordinate exact contract with composer owner.
- [x] Run focused tests and report evidence. Defer commits until full required verification.

## Task 2: Composer actions and integration
Files: packages/web/src/components/composer/composer.tsx, routes/task-thread/{task-thread,run-header,follow-up-engine,run-actions}.tsx/ts and adjacent tests.
- [x] Add literal state tests: queued/working empty Stop, content Send + Stop; waiting empty disabled Send; resumable empty Continue, content Send; stopping disabled actions.
- [x] Tests assert Enter/quick replies never stop, attachments count as content, clearing restores empty action, draft retention and synchronous duplicate lock.
- [x] Implement onStop/stopping controls in shared composer with separate empty Continue label and common send path. Thread owns Stop mutation and authoritative termination reconciliation.
- [x] Remove desktop/mobile header Continue/Cancel and associated mutations/confirmation. Keep other actions.
- [x] Show identity-switch hint before continuation and preserve provider/account picks for both Continue and Send.
- [x] State matrix: pending control aria-busy, empty table action, error/offline/conflict recovery with retained draft, successful submission clears draft once. No full-screen loading.
- [x] Reuse layout and motion tokens, reserve action area, no new imagery. Verify targets/overflow/themes/reduced motion.

## Task 3: Verification and delivery
- [x] Review engine and whole diff for spec compliance and quality; fix findings.
- [x] Run ordered npm run typecheck, npm test, npm run test:unit, npm run build, npm run test:package.
- [x] Drive real UI for desktop/mobile, themes, keyboard, attachments, pending/failure recovery; save evidence and AC mapping.
- [ ] Commit, push, fetch/merge origin/main, rerun required verification if merged changes arrive, create draft PR using repo template, move board In review.
- [ ] Run pr-checks through CI verdict; keep PR draft and never merge.
