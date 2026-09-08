# Task 5 — Verified cleanup with retained parent results

Implemented the approved Task 5 scope on `feat/complete-worker-delegation`, based on `d03bb8f6`. No push. The root-owned plan checkbox changes are excluded from this commit. Root owns the final five-command integration gate and independent review.

## Behavior and interfaces

- Destruction retains the existing per-worker serialization, stop escalation, exact private generation/termination proof, no-materialization verifier and Git ownership/CAS cleanup. After proven termination, it collects obtainable summary/diff/artifact evidence and commits the immutable parent snapshot before invoking any destructive workspace removal. A failed result checkpoint leaves the worktree/ref untouched. The worker's complete execution proof and last execution outcome survive destruction.
- Cleanup publishes explicit optional `WorkerDestroyResult.deleted` descriptors (`{ kind: 'worktree', path }`, `{ kind: 'branch', ref }`) and an error when resources remain. No-materialization no-op responses retain their old shape. `WorkerCollectedResult.workspace.state` optionally describes available/unavailable/deleted workspace bytes. Removed HEADs retain only their historical SHA; that does not promise a reachable Git object. Partial branch-only cleanup/retries retain the parent diff and report the removed workspace accurately.
- Final result publication after removal preserves the already-durable captured bytes. If that checkpoint fails, the old parent snapshot remains readable and deletion stays denied; repeating destruction restores completed availability without replacing the diff with unavailable Git evidence.
- `RunStore.canDeleteRun(workerId)` now requires complete destruction with no remaining resources, settled public status, current complete private proof, exact ownership/workspace/revision/status, and a valid parent-owned collected result. Missing/malformed parent authority or result bytes cannot authorize deletion.
- Child deletion records `receipt.deletion = { phase: 'pending' | 'complete', revision, resourceId, generation }` on the parent before removing bytes. The child remains indexed until owned history, handoff, images/copied attachment inputs, private identity and private execution files are removed, the result's artifact availability is refreshed, and the parent receipt plus child removal commit atomically. Failures return false (HTTP 409), preserve retry metadata and resume after restart. Once private files have been removed, only the exact previously checkpointed deletion receipt can substitute for them.
- Pending deletion collection reads the retained snapshot, so partially removed transcripts/private proof cannot overwrite a settled summary with unavailable/unsettled output. Repeating destruction while history deletion is pending is refused with an actionable retry-history-deletion error.
- Parents retain their result directory and deletion authority until child histories are explicitly deleted. Parent deletion requires completed child deletion receipts and valid retained results, checkpoints `historyDeletion: 'pending'`, then removes parent-owned bytes and snapshots. A final-index failure remains retryable even after the snapshot directory was removed. A stale terminal Finish intent no longer prevents safe parent deletion; queued/running/waiting Finish intent and HTTP active-session guards remain blocking.
- `RunStore.readDeletedWorkerResult(parentId, workerId)` composes the existing owned-result file validation with absent child, completed deletion receipt, settled terminal status, completed cleanup and matching revision/resource identity. Parent deletion, absent-child readiness and wait reconciliation share it. An all-wait retains a safely deleted worker's outcome/revision while other workers run; corrupt or absent replacement evidence cannot manufacture an outcome. Already-settled wait receipts remain immutable. Plain inspect-authorized absent-child collection keeps Task 3's existing ownership-receipt-plus-valid-observation behavior; it does not grant readiness or deletion authority.
- Audited every `canDeleteRun` caller. Worker DELETE bypasses generic `removeWorktree`; worker remove-worktree remains refused in favor of verified cleanup; variant loser archival skips owned workers even when history is deletable. Real reused path/ref tests cover all three. Automatic history retention skips delegation records, preserving promised worker history and parent snapshots until explicit deletion; ordinary retention is unchanged.

## RED evidence

- `/tmp/task5-red.log`: 4 intended failures before implementation, 1 existing metadata-failure guard passed under the permanent tombstone. Missing pre-cleanup snapshot, descriptors/result retention and retryable child deletion.
- `/tmp/task5-routes-red.log`: all 3 reused-resource HTTP cases failed before route guards: DELETE and variant-pick erased the unrelated replacement; remove-worktree incorrectly returned success and removed it.
- `/tmp/task5-retry-red.log`: interrupted-history collection lost its assistant summary and changed settled true to false after private/history bytes were removed.
- `/tmp/task5-partial-red.log`: partial cleanup omitted its remaining-resource error; stale terminal Finish intent still blocked fully authorized parent deletion. Live Finish and missing deletion receipt cases remain independent guards.
- `/tmp/task5-mutation-red.log`: temporarily restored the six then-changed production files to base `d03bb8f6`, preserved tests, and restored Task 5 source bytes in `finally`. **14 failed / 5 guards passed**, 5.85s. Byte-for-byte restoration confirmed. The later all-wait integration regression has its separate RED below.
- `/tmp/task5-deleted-wait-red.log`: revision-1 review outcome disappeared from an all-wait after safe child deletion, leaving the other worker's eventual outcome unable to complete it.

## Verification

- `/tmp/task5-focused2.log`: **167 passed / 8 files**, 22.12s, including all 37 private termination/cleanup barriers and existing workspace ownership/race assertions.
- `/tmp/task5-final-focused.log`: `npm test -- packages/cezar/src/delegation packages/cezar/src/runs/store.test.ts packages/cezar/src/runs/delegation-state.test.ts packages/cezar/src/runs/retention.test.ts packages/cezar/src/runs/retention-enforce.test.ts packages/cezar/src/workflows/worker-destroy.test.ts packages/cezar/src/server/delegation-cleanup.test.ts packages/cezar/src/server/contract-parity.delegation.test.ts packages/cezar/src/server/contract-parity.runs.test.ts` — **613 passed / 21 files**, 26.20s, before the final deleted-child wait integration.
- `/tmp/task5-final-typecheck.log`: full `npm run typecheck` passed before the final deleted-child wait integration.
- `/tmp/task5-final-waits.log`: full `worker-wait.test.ts`, `worker-destroy.test.ts`, `destruction-results.test.ts`, `store.test.ts`, and `delegation-state.test.ts` — **336 passed / 5 files**, 171.27s, including all 105 wait tests and all 37 private termination barriers.
- `/tmp/task5-post-wait-typecheck.log`: full `npm run typecheck` passed after deleted-worker wait integration.
- The final malformed-owner adjustment and its focused verification are recorded below.
- `git diff --check` passed.

## Downstream notes

Task 6 should explain explicit ordering: collect/integrate as desired, destroy owned resources, explicitly delete child histories, then delete parent history. Branch/path strings and historical SHAs are descriptors, not retained live resources. General artifact bytes are not archived on the parent; summary and bounded diff snapshots are retained until parent deletion. Available `diff.path` still names the canonical JSON snapshot wrapper whose `diffSnapshot` field contains the patch. Small Git ownership/cleanup receipts remain in the existing common Git administrative receipt directory to preserve reused-resource/orphan safety; history deletion never routes through generic worktree cleanup.

No environment flag, dependency, backend mechanism, scheduler or UI surface was added. The additive workspace descriptor expectation in `workspace.test.ts` preserves every existing ownership/race/slow-termination assertion.


## Final ownership validation adjustment

A structurally valid snapshot can still name a workspace owner different from its worker ID. The new deleted-child consumer initially trusted that field after receipt/revision/resource matching. `/tmp/task5-owner-red.log` reproduced parent deletion/readiness accepting the mismatched owner. `/tmp/task5-collect-owner-red.log` then proved that validating only the deleted-child reader left plain collection accepting it. The owner-ID check now lives in `readWorkerResultFile`, shared by collection, deletion, readiness and waits. This is a cross-field ownership check, not a new permission or a new storage format.

The final suite includes **16 new destruction/result/deletion regressions** and **3 HTTP reused-resource regressions**. The final typed/focused results follow.

- `/tmp/task5-final-shared-green.log`: `npm test -- packages/cezar/src/delegation/destruction-results.test.ts packages/cezar/src/delegation/results.test.ts packages/cezar/src/server/delegation-cleanup.test.ts packages/cezar/src/runs/store.test.ts packages/cezar/src/runs/delegation-state.test.ts` — **211 passed / 5 files**, 17.54s, after the final shared ownership check.
- `/tmp/task5-final-shared-typecheck.log`: final full `npm run typecheck` passed, including server build/contract inlining and contract/client/server/web checks.
- Final `git diff --check` passed. No known unresolved Task 5 defect; root's independent review and full integration gate remain.

## Review fix round 1 — pending parent history deletion cannot execute again

Verified the reviewer’s P2 scenario: an interrupted parent history deletion preserves its run and `historyDeletion: 'pending'`, but Continue previously accepted that terminal record. If its public status became active, spawn also accepted a new child; the new child prevented parent deletion while the deleting parent could not authorize child deletion. The deletion marker is irreversible and must remain a launch prohibition until deletion retry succeeds.

`RunManager.historyDeletionPending` now feeds the existing execution-stop barriers, covering initial/continuation construction, pre-materialization/pre-launch checks, recovery and live message/monitoring paths. Continue refuses before any accepted-input, step or status mutation. Owned admission and queued revival refuse deleting parents; a legacy queued deletion can pass the old Finish-hold selector only to be cancelled by the stop barrier. Session provisioning, wait registration/reconciliation and lifecycle wake admission also refuse the marker. Both spawn authority (including replay and its post-await recheck) and `createOwnedRun` independently deny acceptance. No path clears `historyDeletion`; successful deletion retry remains available. Ordinary runs have no such marker and keep their existing behavior.

Seven regressions create a real interrupted deletion checkpoint and test Continue, spawn under an active public status, queued/running recovery after reopening, fresh/Continue constructors, and direct owned-store acceptance. Each proves that no run/session/worktree/history is created as applicable and the parent can still be deleted. The Continue constructor test checks the actual transcript against its pre-call history: merely checking for a `session` event initially passed against the bug, so that weak assertion was replaced before the fix.

RED evidence:

- `/tmp/task5-round1-red.log`: **5 intended failures**, 4 selected guards passed; Continue and spawn accepted work, queued/running recovery re-admitted the parent, and fresh construction recreated its worktree.
- `/tmp/task5-round1-construction-red.log`: direct Continue construction recreated transcript/execution history despite pending deletion.
- `/tmp/task5-round1-acceptance-red.log`: temporarily removed only the new store acceptance condition, observed owned creation succeed unexpectedly, and restored store bytes in `finally`.

GREEN evidence:

- `/tmp/task5-round1-green.log`: **22 cleanup tests passed**, 5.23s, before adding the seventh direct store-acceptance test.
- `/tmp/task5-round1-affected.log`: `npm test -- packages/cezar/src/delegation packages/cezar/src/runs/store.test.ts packages/cezar/src/runs/delegation-state.test.ts packages/cezar/src/workflows/worker-destroy.test.ts packages/cezar/src/server/delegation-cleanup.test.ts` — **610 passed / 17 files**, 26.19s, including all seven new regressions and all existing private termination barriers.
- `/tmp/task5-round1-typecheck.log`: full `npm run typecheck` passed after the final code change.
- Focused wait/recovery/monitoring integration results follow. `git diff --check` passed. No push or changes to the root-owned plan checkbox edit.

Final round-1 lifecycle verification: `/tmp/task5-round1-lifecycle.log` — `npm test -- packages/cezar/src/workflows/worker-wait.test.ts -t 'readiness|monitoring|all-mode|Finish|restart|recovery'` passed **60 tests**, 114.38s; 45 unrelated wait cases were intentionally filtered. Final diff whitespace checks passed. The original reviewer can now perform the scoped rereview.
