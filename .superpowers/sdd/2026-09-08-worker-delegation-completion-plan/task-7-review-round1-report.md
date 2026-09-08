# PR 151 automated review round 1

Base: `b042d957`. No push or PR replies; root owns review responses, broader integration/CI, and QA.

## Comment 3960566206 — absent-child collection

Accepted. The approved spec promises collection after **safe child-record deletion** and denies an absent child without that evidence. Task 3's permissive inspection fixture predated Task 5's durable completed-deletion receipt; retaining that behavior is unnecessary now that the verified deletion path exists. This supersedes the earlier Task 5 report's plain absent-child collection exception.

Absent-child collection now uses `RunStore.readDeletedWorkerResult`, requiring the completed deletion receipt and matching settled, completed-cleanup, owned result. Present-child pending deletion continues using its retained result path and exact pending deletion/private-proof checks, so interrupted history removal cannot erase the summary or diff.

The prior success fixture now removes child history through `store.deleteRun` rather than manually editing `runs.json`. New restart regressions cover absent, pending and malformed deletion receipts and assert denied collection does not publish a new index/snapshot pointer.

RED: `/tmp/task7-review1-collect-red.log` — **2 failures**, absent and pending receipts incorrectly allowed collection; malformed receipt remained an independent passing guard.

GREEN: `/tmp/task7-review1-collect-green.log` — `npm test -- packages/cezar/src/delegation/results.test.ts packages/cezar/src/delegation/destruction-results.test.ts packages/cezar/src/delegation/routes.test.ts` — **62 passed / 3 files**, 5.45s, including valid post-deletion collection and present-child interrupted deletion. `git diff --check` passed.

Combined verification, including full typecheck, follows the separate cancellation fix.

## Comment 3960566211 — cancellation authority across parent lifecycle states

Accepted. The approved wait spec explicitly scopes cancellation to the parent's current or retained settled wait and requires idempotent retries. Active-session validation was appropriate for registration but prevented cancellation while a wake continuation was queued, as well as receipt reads after the parent settled.

The service now calls cancellation-specific `authorizeCancelWait`: authenticated same-project root ownership and the existing `wait` grant remain required. Pending history deletion remains denied. Registration, spawn and worker-target authorization retain their active-parent rules. Mutation eligibility, Finish/deletion restrictions and stale-ID isolation remain in `RunManager.cancelWorkerWait`.

The manager already returned matching `lastWait` before lifecycle mutation checks. A second verified gap affected a **current** settled `wake-pending` receipt recovered on a terminal parent: it still passed through the mutating lifecycle gate. It now returns that immutable receipt directly as well, preserving outcome/timeout/cancellation reason, parent status and workers without enqueueing additional work. Only an unsettled current wait reaches the actual cancellation checkpoint; unknown IDs cannot cancel a newer wait.

New service tests cover queued cancellation without worker cancellation or new registration/spawn authority, all four terminal-status retained-receipt retries, and old/unknown ID isolation while a newer wait exists. HTTP restart tests cover current settled receipts on queued/done/review/failed/cancelled parents, preserve a prior timeout reason, and verify worker, foreign-project and missing-wait-grant callers stay denied.

RED: `/tmp/task7-review1-cancel-red.log` — **11 failures**, reproducing queued service cancellation/old receipt reads and terminal current/last receipt denial; 3 caller-isolation guards passed.

GREEN: `/tmp/task7-review1-cancel-green.log` — `npm test -- packages/cezar/src/delegation/service.test.ts packages/cezar/src/delegation/routes.test.ts packages/cezar/src/delegation/policy.test.ts` — **135 passed / 3 files**, 2.51s.

No request/response schema, route, permission grant, workflow scheduler or environment option changed. Full typecheck `/tmp/task7-review1-typecheck.log` passed after both code fixes. Combined lifecycle/collection verification is recorded below after completion.

Combined verification: `/tmp/task7-review1-combined.log` — `npm test -- packages/cezar/src/delegation/service.test.ts packages/cezar/src/delegation/routes.test.ts packages/cezar/src/delegation/policy.test.ts packages/cezar/src/delegation/results.test.ts packages/cezar/src/delegation/destruction-results.test.ts packages/cezar/src/delegation/wait.test.ts packages/cezar/src/workflows/worker-wait.test.ts packages/cezar/src/server/contract-parity.delegation.test.ts` — **295 passed / 8 files**, 170.00s, including the complete 105-test worker-wait suite.

A final compatibility check found that directly returning a current settled receipt bypassed the existing normalization for legacy receipts without `reason`/`wakeId`. `/tmp/task7-review1-legacy-red.log` reproduced the missing fields. The read-only settled branch now uses the existing `reconcileWorkerWait` normalization without committing metadata or waking the parent. This preserves inferred legacy settlement reasons and stable wake IDs while keeping terminal retries readable.

Final focused GREEN: `/tmp/task7-review1-final-focused.log` — service, HTTP routes, pure wait reducer, results, destruction-results and delegation contract parity — **112 passed / 6 files**, 6.75s, after legacy normalization. Final typecheck and real cancellation lifecycle results follow.

- `/tmp/task7-review1-final-cancellation.log`: real worker-wait cancellation/restart/checkpoint cases passed **4 tests**, 2.72s; 101 unrelated cases filtered after their complete combined-suite pass.
- `/tmp/task7-review1-final-typecheck.log`: final full `npm run typecheck` passed after legacy normalization, including server build/contract inlining and contract/client/server/web checks.
- Final `git diff --check` passed. First comment is committed as `7278e956`; the second fix is the separate `fix(delegation): allow scoped cancellation receipt retries` commit. No push, PR reply, plan or QA changes.
