# Worker delegation completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Ship #116 with explicit delegation inputs, durable usable results, reliable waits and a parent completion gate.

**Architecture:** Extend the existing delegation service, CLI, RunStore and RunManager. Keep durable authority and lifecycle decisions in their existing owners; extract focused pure helpers for wait reconciliation, result projection and readiness checks.

**Tech Stack:** Strict TypeScript, Node 20+, npm workspaces, Zod, Hono, Vitest, existing runner mocks and Git integration fixtures.

**Spec:** `.ai/specs/2026-09-08-worker-delegation-completion.md` (approved by owner).

## Global Constraints

- One generation of isolated workers; no new service, scheduler, dependency or required configuration.
- Preserve `CEZ_DELEGATION=1` opt-in and its default-off behavior.
- At most 32 accepted workers per parent; waits 1–1800 seconds, default 600.
- Combined task/context text 100,000 characters; at most 32 artifact references; copied inputs at most 8 MiB.
- Summary evidence at most 4,000 characters; bounded parent-owned diff snapshots use existing diff cap.
- All public shapes defined by Zod in contract; middleware validation and chained routes; Node-free contract/client.
- Preserve private accepted execution identity, process evidence, scoped authority, human asks and verified cleanup.
- Regression tests must fail before implementation; meaningful focused tests per task, full binding suite before publication.
- Already isolated on `feat/complete-worker-delegation`; no additional worktree needed.

## File responsibilities

`packages/contract/src/delegation.ts` owns the shared schemas. Focused new contract files may hold input/result schemas and must be re-exported by contract index. `delegation/wait.ts` reconciles observations; `workflows/run.ts` owns scheduling and recovery. New `delegation/results.ts` owns result construction and `delegation/context.ts` validates/materializes selected inputs. `runs/store.ts` owns durable metadata/result files and deletion. The existing service, routes and CLI expose operations. Backend adapters interpret per-run restriction intent through `core/agent-runner.ts`. Existing docs and integration tests prove the finished surface.

### Task 1: Wait modes, explicit cancellation, stable settlement

**Files:** Modify contract delegation.ts; delegation/wait.ts, service.ts, routes.ts, cli.ts; workflows/run.ts. Test delegation/wait.test.ts, routes.test.ts, cli.test.ts and workflows/worker-wait.test.ts; update server/contract-parity.delegation.test.ts and BACKWARD_COMPATIBILITY.md for routes.
**Interfaces:** Extend `WorkerWaitRequest` with optional mode one/any/all (omitted = any); persisted `WorkerWait` adds optional mode and reason outcome/timeout/cancelled; root metadata retains last wait receipt. Preserve existing `reconcileWorkerWait(wait, outcomes, now): WorkerWait`. Add `RunManager.cancelWorkerWait(parentId: string, waitId: string): WorkerWait`, `DelegationService.cancelWait(caller, {waitId})`, and CLI `cancel-wait <wait-id>`, authorized under existing wait permission.

- [x] Write failing reconciliation tests using two worker IDs. Assert one result leaves all-mode parked and records the partial outcome; both results wake; timeout preserves partial outcomes and reason; subsequent reconciliation preserves settled reason. Assert one-mode rejects multiple IDs and omitted mode accepts legacy requests.

```ts
const pending = { ...wait, mode: 'all' as const, workerIds: [first, second] };
const partial = reconcileWorkerWait(pending, [done(first)], now);
expect(partial.phase).toBe('registered');
expect(partial.outcomes.map(x => x.workerId)).toEqual([first]);
expect(reconcileWorkerWait(partial, [done(second)], now).reason).toBe('outcome');
expect(reconcileWorkerWait(partial, [], pending.deadline).reason).toBe('timeout');
```

- [x] Run `npm test -- packages/cezar/src/delegation/wait.test.ts` and confirm intended failures.
- [x] Implement accumulation without early-return loss for partial all-mode observations. Preserve stable wake ID and reason; for legacy already-wake-pending records infer reason once from their evidence, not later wall time.

```ts
const satisfied = (wait.mode ?? 'any') === 'all'
  ? wait.workerIds.every(id => collected.some(outcome => outcome.workerId === id))
  : collected.length > 0;
const reason = wait.reason ?? (satisfied ? 'outcome'
  : Date.parse(now) >= Date.parse(wait.deadline) ? 'timeout' : undefined);
```

- [x] Add manager tests for cancel-before-park, cancel-parked, stale ID, repeat after retirement, restart and parent cancellation; assert workers remain running and scheduler wakes exactly once. Persist receipt before cancellation wake. Existing event/registration reconciliation handles early outcomes; no interval polling.
- [x] Implement cancellation using the same wait wake path; use schemas for body/result and preserve legacy operation grants by mapping cancel-wait to wait policy. Store retirement receipt before removing current wait; update queueWorkerWake to use persisted reason.
- [x] Run focused wait/CLI/routes/contract tests and commit `feat(delegation): support lifecycle wait modes and cancellation`.

### Task 2: Explicit context and backend/model inputs

**Files:** Add delegation/context.ts and context.test.ts. Modify contract delegation.ts, delegation/service.ts, cli.ts, execution-identity.ts, provision.ts, workflows/run.ts and relevant tests.
**Interfaces:** `WorkerSpawnRequest` accepts optional context `{text?: string, artifacts?: WorkerContextReference[]}`, backend and model; define WorkerContextReference in contract as baseline-file path or parent-attachment ID. `prepareWorkerContext(...)` validates and resolves bounded materialization from trusted parent/workspace inputs. Existing accepted identity format stays authoritative.

- [x] Add service tests for explicit same/mixed backend, omitted defaults, incompatible model/account locks and idempotency conflicts. Add context tests for traversal, symlink escape, unrelated attachments, missing file, input-size bounds and worker-visible materialized paths.

```ts
const request = { task: 'inspect', baseline: 'parent-head', requestId,
  context: { text: 'Only inspect the parser' }, backend: 'codex' as const };
const accepted = await service.spawn(caller, request);
expect(store.getRun(accepted.workerId)?.runner).toBe('codex');
await expect(service.spawn(caller, { ...request, context: { text: 'changed' } }))
  .rejects.toMatchObject({ code: 'invalid_input' });
```

- [x] Run focused service/context tests red. Build boundary fixtures from existing service.testkit and real Git repo helpers, not implementation mocks.
- [x] Resolve same backend through parent effective identity; different backend through existing project profile/default model resolution and captureWorkerAccount. Freeze grants; retain old hash encoding for requests without added inputs. Include all provided normalized fields in new hashes.
- [x] Materialize parent attachments before worker starts with an atomic owned destination, bounded byte reads and canonical source checks; baseline-file paths resolve inside pinned worktree. Pass selected text and resolved input note as task content. Persist acceptance-time input recipe and verify/rebuild materialization safely on recovery.
- [x] Parse `--backend`, `--model`, `--context`, `--context-file` CLI flags; context-file bytes become text, never a remote path. Enforce mutually exclusive text sources. Update provisioning instructions with examples and defaults.
- [x] Run service/context/CLI/provision workflow tests including start/Continue/recovery; commit `feat(delegation): accept explicit context and execution selection`.

### Task 3: Parent-owned result collection and execution revisions

**Files:** Add delegation/results.ts and results.test.ts. Modify contract delegation.ts, runs/store.ts, runs/delegation-state.ts, delegation/service.ts, routes.ts, cli.ts; workflows/run.ts at accepted Continue and output persistence. Test store/result/route/CLI/parity surfaces.
**Interfaces:** Add contract `WorkerCollectedResult` with worker ID, revision, exact run status and projected outcome, observation time, typed summary/commit/diff/artifact availability. Add `DelegationService.collect(caller, {workerId}): Promise<WorkerCollectedResult>`. Authorize with inspect permission. Store adds atomic `commitWorkerResult(parentId, result, diffSnapshot?)` and `readWorkerResult(parentId, workerId)`; result references live in root metadata, payload files in parent-owned storage. Worker revision is optional on legacy records, normalized to 0, incremented durably only on authorized new execution.

- [x] Test summary from assistant output versus missing summary/error-only/partial output; commit and diff availability with a real worker worktree; redaction/truncation; parent read after reopen; stale collection finishing after Continue rejected.

```ts
const result = await service.collect(caller, { workerId });
expect(result.workerId).toBe(workerId);
expect(result.baselineSha).toBe(baselineSha);
expect(result.summary.state).toBe('available');
expect(reopened.readWorkerResult(parentId, workerId)).toEqual(result);
```

- [x] Run result tests red. Define discriminated availability objects with unavailable/deleted reason and retained historical identifiers; running output explicitly partial. Never infer successful assistant summary from tool text.
- [x] Persist latest result pointer and bounded snapshot before returning. Recheck worker revision/status after asynchronous Git reads; stable collected revision satisfies later readiness. Retain old evidence as historical on Continue; do not use old review observations for new revision waits. Extend wait selection/reconciliation with revision matching and tests.
- [x] Add collect CLI/route and parity checks; preserve root permissions by policy mapping. Query owned parent receipt and retained result if child was safely deleted, otherwise deny/unavailable.
- [x] Run focused results/store/Continue/wait/contract tests; commit `feat(delegation): retain collected worker results on parents`.

### Task 4: Gate parent completion and preserve review lifecycle

**Files:** Add delegation/readiness.ts and readiness.test.ts if useful. Modify workflows/run.ts, runs/store.ts for durable completion wait/attention state, related server Finish response handling only as needed. Test workflows/worker-wait.test.ts and worker-destroy.test.ts plus focused readiness integration cases.
**Interfaces:** Pure readiness projection takes parent, direct workers, collected revisions and proven execution termination. Produces ready or blocking workers/reasons. Manager successful settlement and Finish consume one shared predicate. Root metadata records bounded completion-attempt state through existing wait receipts.

- [x] Tests: parent automatic completion with live worker remains waiting; review gate off cannot publish done; human Finish does not close session; worker review-ready plus collection allows parent review; failure requires collection; cancelled but live process blocks; old review parent does not cancel child during recovery.

```ts
parentSession.finish();
await until(() => store.getRun(parentId)?.status === 'waiting');
expect(store.getRun(workerId)?.status).toBe('running');
expect(manager.finish(parentId)).toBe(false);
```

- [x] Run red on both streaming/non-streaming completion fixtures. Pin stop/cancel guards that must still pass.
- [x] Route successful settlement through the readiness predicate before diff/terminal commit. One automatic finite wait-all; after wake parent inspects/collects and retries completion. Timeout or second unresolved completion goes to attention without autonomous spin. Initialize all ActiveRun sites and share both turn-end hooks.
- [x] Distinguish review from terminal exit in reconcileWorkerWaits and recover; preserve failure/cancellation cascade and private termination evidence. Reject child Continue while parent remains reviewing. Reject premature human Finish visibly before accepted Finish intent/session close.
- [x] Run focused workflow/recovery tests and full typecheck; commit `fix(delegation): settle workers before parent completion`.

### Task 5: Safe destruction and child deletion with retained results

**Files:** Modify delegation/service.ts, workspace.ts, runs/store.ts, server cleanup paths; tests delegation/workspace.test.ts, service.test.ts, server/delegation-cleanup.test.ts, workflows/worker-destroy.test.ts.
**Interfaces:** Destruction invokes Task 3 collection/checkpoint before resource removal. Extend cleanup result with deleted descriptors using contract. Store deletion requires complete destroy + proven termination + durable parent ownership/result receipt and supports retryable deletion checkpoints.

- [x] Add tests that result checkpoint failure leaves resources untouched; complete cleanup removes branch/worktree but collected summary/diff remains; child deletion removes history/input bytes while parent result is readable after restart; parent deletion understands safely deleted child; malformed/absent parent evidence denies deletion.

```ts
await service.destroy(caller, { workerId });
expect(store.deleteRun(workerId)).toBe(true);
expect(store.readWorkerResult(parentId, workerId)?.workerId).toBe(workerId);
expect((await service.collect(caller, { workerId })).workspace.state).toBe('deleted');
```

- [x] Run failures first. Keep existing ownership/race/slow-termination guard suite unchanged.
- [x] Persist final partial-or-complete result before destructive work; reuse ownership locks/no-materialization proofs. Record deleted branch/path descriptors and distinguish historical SHA from reachable Git object. Parent diff snapshot remains outside deleted child directory.
- [x] Relax permanent tombstones only with durable replacement evidence; atomic metadata precedes file deletion, interrupted cleanup retries, no unsafe best-effort success. Keep retention behavior for ordinary runs.
- [x] Run focused cleanup/store/results tests; commit `feat(delegation): preserve results through verified worker cleanup`.

### Task 6: Backend guidance and native delegation controls

**Files:** core/agent-runner.ts and Claude/Codex/OpenCode/pi adapters, delegation/provision.ts, shared workflow provisioning; tests core/harness-parity.test.ts, per-backend args/wire tests and delegation/provision-workflows.test.ts. Docs AGENT_PROTOCOL.md and README.
**Interfaces:** Optional per-run native-delegation restriction intent in AgentRunSpec, interpreted only within adapters. Default absent preserves ordinary execution. No global config writes or new user env flag.

- [x] Inspect installed harness help/source/protocol fixtures; browse official primary documentation only if local evidence cannot settle supported per-run controls. Record exact supported mechanisms and explicit unsupported exemptions in parity docs.
- [x] Add wire-faithful tests showing restricted versus ordinary launch config for supported adapters and unchanged config plus guidance for unsupported ones. Test Continue/recovery provisioning and mixed-backend credentials.

```ts
expect(restrictedSpec.systemPrompt).toContain('cezar');
expect(childSpec.env?.CEZ_DELEGATION_TOKEN).not.toBe(parentSpec.env?.CEZ_DELEGATION_TOKEN);
```

- [x] Run red for newly supported restriction mapping. Implement adapter-level controls without broadening accepted tool grants; do not represent guidance as enforcement.
- [x] Update instructions for collect, wait modes/cancel, context, reviewed commits before cleanup, completion gate and native-tool limitations.
- [x] Run backend parity/provision tests; commit `feat(delegation): prefer governed workers across backends`.

### Task 7: Integrated verification, documentation and draft PR

**Files:** packages/cezar/test/e2e/delegation.test.ts and focused workflow integration tests; README, AGENT_PROTOCOL.md, BACKWARD_COMPATIBILITY.md; UI tests only for touched user-facing behaviors; adjacent QA report.
**Interfaces:** Exercise the public CLI/service and real manager/store/Git boundaries from Tasks 1–6.

- [x] Add parent/two-worker integration using wire-faithful runners: explicit context, mixed backend, steering, early completion before wait, wait-any then collect both, review-ready inspection, deliberate real Git cherry-pick, conflict abort, worker failure, permission denial, cancellation, restart, cleanup retries and child deletion.
- [x] Run the integration red for remaining gaps, fix within owning task boundaries, and re-run focused guards. Document exact artifact survival and exemptions; actual browser evidence if UI changed.
- [ ] Run required commands in order, retain logs and inspect failures: `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`. Debug failures; no PR on red.
- [ ] Independent whole-branch review of spec compliance, lifecycle races, public contracts and retained cleanup evidence; fix findings and reverify affected checks.
- [ ] Commit final QA/docs. Fetch origin and merge origin/main; resolve/reverify any merged changes; push feature branch.
- [ ] Use repository PR template with Closes #116, Summary, Design decision/spec, Experience, command-result Verification and Left undone. Create draft with base main, board In review; execute pr-checks through CI verdict without auto-merge/ready flip.
