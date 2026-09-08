# Task 7 — Delegation integration and focused QA

Base: `2b0b5e4c`. Scope: integration tests and their evidence only. Root owns the complete five-command gate, documentation audit, independent whole-branch review, merge/fetch, draft PR and CI. No production code, configuration, dependencies, UI, or root plan checkboxes changed here.

## Added integration coverage

`packages/cezar/src/workflows/delegation-integration.test.ts` runs the real source CLI in a Node subprocess with the checkout's absolute tsx loader and an empty PATH. Commands use the actual private HTTP transport, authentication, chained delegation routes, service, RunManager, RunStore, workspace semaphore, and Git. Human history deletion uses the real Hono app's public DELETE route. There is no paid backend request and no application/browser server launch.

The only backend doubles are external Claude stream-json and Codex app-server JSONL processes in `workflows/__fixtures__/delegation-wire.mjs`. Their documented handshake/result/item/turn envelopes pass through the actual adapters and process finalization. Per-turn filesystem gates establish ordering; fixture workers execute actual Git commits. Provisioner/lifecycle wrappers only capture credentials in test memory and await existing promises for teardown; they do not replace admission, execution, collection, termination or cleanup behavior.

Three coherent scenarios cover:

1. A parent and two real isolated worktrees, one same-backend Claude worker and one mixed-backend Codex worker. Explicit selected context reaches the intended process, each worker starts at the accepted parent commit, parent scratch is absent from both, and session tokens differ. Premature parent DONE parks behind an all-worker completion gate and human Finish is rejected. Explicit cancel-wait withdraws that wait without stopping children; a subsequent wait-any wakes the parent exactly once after alpha reaches review while beta remains running. Steering reaches the backend and has durable agent attribution, never a human user-message event. Running collection stays partial/unsettled; final collections expose review-ready summary/HEAD and an obtainable JSON snapshot containing `diffSnapshot`.
2. A Codex provider-error envelope produces failed public state and proven termination. A worker cannot steer its peer or spawn a nested worker; neither denial changes inputs or child count. Wait-all remains pending while another worker runs; explicit stop returns stopping/terminated and the final termination proof unlocks the wake. Finish stays blocked until failed/cancelled results are collected. Late steering cannot reopen a stopped worker. A no-diff parent can then explicitly Finish as done.
3. Parent cancellation terminates an actual running Codex worker, with private execution phase complete, while retaining another child's review state, committed worktree bytes and parent-collected patch. Cancellation does not implicitly destroy either worktree.

The first scenario also executes the requested integration/destruction sequence:

- Before any cherry-pick, both completed worker commits leave parent HEAD and `shared.txt` unchanged.
- Explicit `git cherry-pick <alpha SHA>` puts alpha in the parent. Explicit beta cherry-pick produces a real unmerged `shared.txt`; `git cherry-pick --abort` clears the conflict and leaves alpha intact.
- A real branch-ref `.lock` causes destruction to remove alpha's worktree but report incomplete cleanup with only the branch remaining. Child deletion remains ineligible, the owned branch still points at alpha, and the parent diff remains readable.
- Finish with the integrated diff reaches review. After disposing/reopening the real controller, manager and on-disk store, recovery preserves review, incomplete cleanup and the retained patch. Authorized human Continue provisions the parent again. Removing the lock and retrying destruction completes cleanup; repeated destruction is idempotent.
- Public child DELETE removes both child records and their NDJSON files. Parent-authenticated CLI collect still returns settled destroyed results with available summaries/diffs and deleted workspace/HEAD descriptors. Both patches survive; alpha remains reachable through the unchanged parent HEAD. Final parent DONE reaches review after observing the retained results.

The existing installed-package lifecycle test in `packages/cezar/test/e2e/delegation.test.ts` now expects Task 5's explicit worktree/branch `deleted` descriptors on destruction and retry. Its actual package execution belongs to root's final build/package gate; it was not run in this subtask.

## Verification and iteration evidence

No implementation defect was discovered. These are integration guards over already-reviewed Tasks 1–6; no production fix was introduced, so no artificial regression RED is claimed. Earlier runs exposed fixture assumptions and were corrected without changing production:

- `/tmp/task7-integration-first.log`: 3 failures because initial steering can legitimately report queued and stop can legitimately report stopping. The corrected tests await actual input delivery and complete private termination, then verify repeated stop returns terminated.
- `/tmp/task7-integration-second.log`: the fixture's deliberately untracked parent scratch had entered the existing parent diff helper's intent-to-add index, preventing Git cherry-pick; the scratch is now removed after proving it was excluded from workers. Also corrected no-diff Finish expectation from review to done.
- `/tmp/task7-integration-third.log`: corrected the integrated-diff Finish expectation back to review; the failure/cancellation scenarios passed.
- `/tmp/task7-integration-fourth.log`: all 3 new scenarios passed, 20.62s total, before adding the final persisted-attribution/recovered-review/secret-redaction assertions.

Final focused command, including all final assertions:

```sh
npm test -- packages/cezar/src/workflows/delegation-integration.test.ts packages/cezar/src/delegation/destruction-results.test.ts packages/cezar/src/delegation/results.test.ts packages/cezar/src/delegation/cli.test.ts packages/cezar/src/server/delegation-cleanup.test.ts packages/cezar/src/server/contract-parity.delegation.test.ts
```

**64 passed / 6 files**, 18.83s, exit 0. Log: `/tmp/task7-integration-focused.log`. This also checks result evidence and bounds, snapshot failures, cleanup/deletion interruption and retry, parent retention/deletion predicates, missing/malformed parent denial, retained artifact availability, CLI parsing, HTTP cleanup origin/scope, and contract parity. Those existing focused tests avoid duplicating the exhaustive cleanup matrix in the new scenario.

```sh
npm test -- packages/cezar/src/workflows/worker-wait.test.ts -t 'readiness|completion timeout|rebuilds a parked deadline|restart reconciles|cancelled parked wait|restarts cancelled settlement|all-mode|all-wait|parent timeout leaves'
```

**30 passed / 1 file**, 75 unrelated tests intentionally filtered, 54.42s, exit 0. Log: `/tmp/task7-wait-guards.log`. Covers fresh/Continue and closed-session readiness; actual stopped-process proof; latest settled revisions; bounded repeated completion/timeout attention; delayed OpenCode ACK monitoring exclusion; human asks; all-mode freshness and one wake; single-slot cancellation ordering and stale IDs; finite deadline rebuild; registered/parked/wake-pending recovery deduplication. Existing Tasks 3–6 reports retain their genuine pre-fix RED/mutation evidence.

`git diff --check` passed. `git diff --numstat 2b0b5e4c -- packages/web` returned no entries. No viewport/theme/browser checks were performed or claimed because this subtask changes no UI behavior. Existing relationship/transcript/error surfaces are exercised at persisted event/API boundaries here, not rendered in a browser.

## Retention and limits

Guaranteed observed retention: parent summary and bounded diff payloads remain after worktree/ref destruction, restart, and explicit child-history deletion; integrated alpha stays in parent Git history. Deleted HEAD SHA/path/ref strings are historical descriptors, not promises of retained worker resources. General attachment/handoff bytes are not archived under the parent; existing destruction-result tests explicitly cover their deletion/revalidation and parent-history removal. This test does not force Git garbage collection or claim unintegrated beta remains reachable.

Backend scope here is Claude + Codex. Existing backend parity/provisioning tests and Task 6's versioned control evidence cover OpenCode/pi, start/Continue/recovery and native restrictions. The documented pi arbitrary-extension exemption and same-user shell limitation remain unchanged. There is no auto-integration, review acceptance, network permission expansion, or new user-authored state.

Required work outside this handoff: root's full typecheck/test/unit/build/package sequence (including the updated installed-package test), independent review and any resulting repairs, final documentation, draft PR and CI. No push was performed.
