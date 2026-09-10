# Parent and worker conversations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Ship #112's durable parent/worker request/reply conversations through the existing delegation transport, waits, and cockpit.

**Architecture:** Store one authoritative conversation ledger on the root and atomically insert accepted inputs into recipient queues. Extend the existing wait receipt with request selections for either role; lifecycle and request reconciliation use the same scheduler and wake acknowledgement.

**Tech Stack:** TypeScript ESM, Zod, Hono, React, Vitest, npm workspaces.

**Spec:** `.ai/specs/2026-09-08-parent-worker-conversations.md`

## Global Constraints

- Keep CEZ_DELEGATION opt-in unchanged; no new dependencies or environment flags.
- Every API/persisted shape originates in packages/contract; routes chain validation middleware.
- Cap text at 100,000 characters, undelivered input at 32, family messages at 1,024, pending requests at 32.
- Request deadlines 1–1,800 seconds, 600 default; one active wait per run.
- Agent messages never answer human questions or auto-continue terminal runs.
- Deduplicate obligations and wake receipts; acknowledge the existing provider/checkpoint crash ambiguity.

## Task 1: Durable conversation protocol and service

Files: new `packages/contract/src/conversations.ts`, export from `index.ts`; extend `delegation.ts`; new `packages/cezar/src/delegation/conversations.ts` and `.test.ts`; extend `service.ts`, `routes.ts`, `runs/store.ts`; new `conversation-service.test.ts`.

Interfaces: `ConversationMessage` (id, senderRunId, recipientRunId, kind, requestId?, text, createdAt, deadline?, requestHash, state); `RequestOutcome` (requestId, status, observedAt, replyId?); `ConversationState` (messages, outcomes). `ConversationSendRequest` carries id, recipientRunId, kind, requestId?, text, timeoutSeconds. `ConversationSendResult` carries message, delivery, outcome?. Root metadata gains conversation?. AgentInput gains conversation? containing structured attribution. Worker metadata gains wait?/lastWait?; WorkerWait gains requestIds?/requestOutcomes? and reason `message` for interruption; lifecycle request inputs stay compatible.

- [x] Write service tests with real RunStore and the existing held-scheduler fixture. Example: `const sent = await service.send(caller, request); await service.send(caller, request); expect(store.getRun(workerId)?.agentInputs).toHaveLength(1);` Then retry changed text and expect invalid_input.
- [x] Run `npm test -- packages/cezar/src/delegation/conversation-service.test.ts`; observe missing behavior.
- [x] Implement schema validation, pair authorization, stable payload hashing, atomic ledger+queue commit, request/progress/follow-up/reply rules, late replies, inspect/cancel, and capacity/secret rejection. New service methods use `manager.reconcileWorkerWaits()` and `manager.deliverConversationInput(runId)` after persistence. Reconciliation helper settles ledger outcomes from current durable run state and deadlines, preserving first settlement.
- [x] Expose validated private routes `/send`, `/follow-up`, `/reply`, `/conversation`, `/cancel-request`; keep every endpoint under the private `/api/v1/delegation` family. Add contract parity assertions alongside route tests.
- [x] Run the new tests and existing service/input/route tests; inspect disk after reopen, failed commit, terminal/review/destroyed states, and denied peer/caller forgery. Include the coherent service change in the final feature commit after integration verification.

## Task 2: Shared request waits and scheduler integration

Files: `packages/cezar/src/workflows/run.ts`, `delegation/wait.ts`, `runs/store.ts`, `workflows/worker-wait.test.ts`, conversation integration cases in `workflows/worker-wait.test.ts`.

Interfaces: `RunManager.registerRequestWait(runId, RequestWaitRequest): WorkerWait`; `RunManager.deliverConversationInput(runId): void`. `workerWait` and receipt withdrawal support both roles. `reconcileConversationState(root, runs, now, isSettled)` returns unchanged or updated ConversationState; service and manager share this helper. `RequestWaitRequest` has requestIds, mode?, timeoutSeconds. Wait outcomes are selected from the root ledger, including early replies.

- [x] Add real-manager tests: worker requests parent, registers wait, parks and releases capacity; parent reply wakes worker exactly once; early reply satisfies registration. Example assertion: `expect(semaphore.busy()).toBe(0)` while worker is parked, then `expect(inputs.filter(i => i.id === wait.id && i.deliveredAt)).toHaveLength(1)` after reply.
- [x] Observe red with focused Vitest command before changing lifecycle code.
- [x] Extend request selection reconciliation (one/any/all), role-independent wait retirement and recovery, and request deadlines using the existing workerWaitTimers. Reconcile ledger before waits on state and delivery changes.
- [x] Admit incoming conversation to parked participants through the existing wake queue. Persist `message` interruption without settling outstanding request obligations; never bypass capacity or pending asks. The resulting wake context must distinguish message interruption from request outcome and lifecycle completion.
- [x] Cover each construction/turn-end site, request timer disposal, root finish, normal completion, review, cancellation/destruction proof, timeout, restart after acceptance/ACK, and stale callbacks. Keep readiness and child control restricted to roots.
- [x] Run focused wait/delivery/recovery tests and existing regression guards. Include in the final feature commit after green.

## Task 3: CLI, guidance, cockpit, and protocol documentation

Files: `delegation/cli.ts`, `.test.ts`, `delegation/provision.ts`, cockpit `routes/task-thread/thread-state.ts` and transcript components/tests; `README.md`, `AGENT_PROTOCOL.md`, `BACKWARD_COMPATIBILITY.md`.

Interfaces: consume Task 1 schemas/routes; extend existing `wait` CLI with `--request` selection and keep worker-ID form. Exported JSON is validated against contract schemas. Conversation events carry message/outcome projections and stable identity; no event replays inject input.

- [x] Add CLI parser tests for request send, follow-up/reply correlation, cancellation, request wait, invalid combinations. Run red.
- [x] Add command forms to existing parser and guidance for both roles, preserving bundled invocation and credential secrecy. Document acceptance versus reply versus completion.
- [x] Add rendered transcript tests for sender/recipient attribution, request outcome, duplicate event replay, and unaffected human ask. Run red, then implement within existing thread surfaces with keyboard links and wrapping.
- [x] Run CLI/provision and thread tests; drive the cockpit at 360x640 and desktop in light/dark and save actual QA evidence.
- [x] Update protocol/API inventory/README with commands, caps, deadlines, terminal continuation, and checkpoint ambiguity. Include in the final feature commit.

## Task 4: Integration, review, required verification, and draft PR

Files: `workflows/worker-wait.test.ts`, `core/conversation-delivery.test.ts`, harness parity fixtures; spec QA evidence; repository PR template.

- [x] Extend the two-worker integration scenario with parent/worker requests, explicit replies, follow-ups, multiple obligations, and restart at delivery boundary. Assert the real received correlated messages and absence of extra turns on replay.
- [x] Exercise agent attribution and outstanding human questions through Claude, Codex, OpenCode, and Pi offline wires. Tests must cover production runner behavior, not invented provider APIs.
- [x] Review the complete change against every issue criterion and the accepted spec; fix identified defects with regression tests. Verify that new regression tests fail without the source fix.
- [x] Run `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package` and read each result. No PR on red.
- [ ] Commit, push feature branch, fetch and merge origin/main; rerun required verification if the merge changes the tree.
- [ ] Create draft PR based on main with repository template, Closes #112, design reference, Experience/QA, command results, and Left undone. Move board to In review. Run pr-checks and required SDLC docs check through CI/review verdict; never merge or mark ready.

## Review record

Spec coverage: protocol/persistence Task 1; lifecycle/waits/recovery Task 2; UI/CLI/docs Task 3; backend/integration/verification Task 4. Request waits share scheduler admission and do not broaden worker management authority. The existing worktree is linked and on feat/parent-worker-conversations.

Implementation review: request waits use the existing `/wait` route with a request-ID union; `wait-requests` is a CLI alias. Final review added regressions for redaction, retry reconciliation, withdrawn inputs, monitoring capacity, and a full 32-message wake delivered through retirement. UI screenshots and actual checks are recorded in `assets/parent-worker-conversations/QA.md`.
