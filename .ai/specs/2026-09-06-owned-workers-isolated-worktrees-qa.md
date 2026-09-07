# Owned workers acceptance and QA

Date: 2026-09-07. Issue #111. Acceptance is in progress; publication and CI are
not yet complete. This file records observed results, with pending checks named
explicitly. The approved spec and implementation plan share this filename prefix.

## Environment and scope

Current main through `ab6d076a20a08146bfc1c614c64a442374f4fd61` (v0.11.10) was
integrated before final verification. The sole conflict preserves upstream
parent-turn-only activity recognition for both monitoring and owned worker waits.
The merge remains uncommitted for controller review. No real agent account,
remote browser, user browser profile or user repository is used by QA fixtures.

The packaged lifecycle installs the actual release tarball into a temporary path
containing spaces/apostrophes. It imports that installation's real RunStore,
RunManager, WorkspaceSemaphore and DelegationController, invokes its provisioned
absolute CLI with no `cez` on PATH, and runs a real ClaudeCliRunner child process
over wire-faithful stream-json. Only that external agent process is scripted.
The successful first targeted run took 5.6 seconds. Review assertions explicitly
set the existing `CEZ_REVIEW_GATE=1`; the shipped default remains off.

Browser prerequisite adaptation is confined to a disposable scratch PATH wrapper
around cached native agent-browser 0.36.0 and Chrome 151. Each real command uses
`TMPDIR=/tmp` and `AGENT_BROWSER_ARGS=--no-sandbox` because this container's
inherited temporary path exceeds Chromium's Unix-socket limit and its sandbox
cannot launch. Doctor runs native `--offline --quick` cached checks followed by
an actual unique-session open/get-url/close live probe. These replace the native
doctor's failing network/built-in-launch probes. No descriptor or suite marker is
fabricated. `skills get core` is unavailable in the native cache (no skills
directory); the repository's provider instructions and actual command interface
are used. This is prerequisite evidence, not an application pass.

## Acceptance matrix

Paths below are under `packages/cezar/src` unless prefixed otherwise. Named tests
are executed by the full Vitest gate, not inferred from source presence alone.

| Approved requirement | Actual evidence |
| --- | --- |
| Complete parent lifecycle | `packages/cezar/test/e2e/delegation.test.ts`: “installed CLI completes owned-worker lifecycle with lost spawn reply and one slot”. Actual spawn acceptance with ignored first reply, exact replay after parent HEAD moves, committed baseline/dirty exclusion, queued child at maxParallel=1, immediate wait registration, yield/admission, inspect, attributed steer, worker review/parent wake, worker-only diff, stop, checked destroy/repeat, worktree/registration/branch absence and retained review/history. |
| Server-derived identity and no secrets | `delegation/credentials.test.ts`: independent tokens, invalid/altered token, rotation, revocation, close. `delegation/policy.test.ts` operation matrix: copied Caller, wrong project, unrelated root, worker, missing/malformed owner, persisted grants and lifecycle. `delegation/routes.test.ts`: strict forged identities/JSON/query, scope rejection, origin/Host guards and no cockpit authority. Installed lifecycle checks public records/events contain no generated credential. |
| One generation, ownership, finite limits | `delegation/policy.test.ts`: all operations denied to workers even with elevated persisted permissions; `delegation/service.test.ts`: “caps accepted creations at 32 including destroyed workers; replay does not consume a creation”, replay across moving HEAD/restart, and 33rd undelivered input rejection. |
| Committed isolation and attributed diff | `delegation/workspace.test.ts`: parent HEAD excludes dirty edits without autosave; named-ref movement; non-Git/foreign/bad refs; collisions and private marker/receipt substitution; real manager creation fails before agent launch with no root fallback; worker commits/dirty/ignored files, changed branch, bounded truncation and unavailable resources. Installed lifecycle independently checks committed content and parent-only edits. |
| Capacity, wake and recovery | `workflows/worker-wait.test.ts`: “releases only on yield and admits a live wake behind already queued work”; all terminal outcomes before register/park; 32 outcomes; finite deadline without cancelling a child ask; registered execution retains capacity; every recovery phase and identified duplicate delivery; scheduler fairness; durable Finish and cancelled-intent recovery. Both fresh/continuation handlers use the same wait/ask/input decisions. |
| Safe destruction and crash ambiguity | `workflows/worker-destroy.test.ts`: queued/startup/live/parked paths, ignored SIGTERM, concurrent waiters, session result plus pending bookkeeping, periodic autosave/check-process barriers, unknown/stale/private completion, destruction guards and explicit retry. `delegation/workspace.test.ts`: moved/symlink/replaced/locked resources, branch checked elsewhere/tip changes, partial checkpoint replay and missing receipt denial. `delegation/service.test.ts`: serialized retry, unknown termination incomplete, exact remaining resources and retained tombstone. |
| All four runners preserve human answers | `core/harness-parity.test.ts`: S11/S12 and R6–R11 run through real Claude/Codex/OpenCode/pi runners with their offline wire fixtures. Before/during/after asks, native acknowledgement, queued/startup/restart/Continue, refused human delivery, delayed reply plus DONE and post-send checkpoint failures. The executable matrix rejects skipped/pending cells and permits only declared wire limitations. |
| Default off, inherited env, degraded provisioning | `delegation/provision.test.ts`: no listener/ordinary metadata off; failed listener leaves ordinary runs unprovisioned; invalid metadata never promoted; all runner environments. `core/agent-env.test.ts`: all four backends strip inherited URL/token under full and passthrough modes, then merge only controller-generated values. `delegation/provision-workflows.test.ts`: ordinary native Claude off/Continue guard; controller close revokes without terminalizing; lazy projects provision before recovery. |
| Supported execution identity across constructors | `delegation/provision-workflows.test.ts`: queued/restart/Continue keep accepted account after registry deletion/repoint, native versus explicit/named Claude layout, same-directory override and changed-HOME refusal, actual merged environment, missing/malformed private evidence/home, model/effort locks and supported provider limits. `workflows/run.ts` has both ActiveRun construction sites, both call shared account preparation/provisioning and hydrate pending asks; recovery launches through these paths. |
| Persistence/quarantine, termination versus shutdown | `runs/delegation-state.test.ts` validates optional legacy metadata, malformed authority quarantine, atomic ownership/receipts/private evidence and failed-write no-publication. `workflows/worker-wait.test.ts` covers parent cancelled/failed/review/done cascade separately from disposal and late callbacks; waits/children survive shutdown. |
| Human deletion and retention | `server/delegation-cleanup.test.ts`, `server/worktrees-api.test.ts`, `workflows/worker-destroy.test.ts` and `delegation/workspace.test.ts` cover off-mode human cleanup, malformed body no mutation, blocked continuation/rematerialization/deletion, missing parent receipts and protected orphan resources. `runs/store.ts:canDeleteRun` scans both receipts and actual children; worker/invalid history is retained. `runs/retention.ts` excludes owned/invalid resources at every reclaim entry. |
| HTTP contract and inventory | `server/contract-parity.delegation.test.ts` checks both directions and scoped/boot aliases; `server/run-relationships.test.ts` reads complete archived ownership with strict params/query; `server/runs-index-api.test.ts` verifies slim role/wait projection; typed bodies, route parity, version surface and `bc-route-inventory.test.ts` run in the full suite. API-client re-exports schemas; service runtime does not import it. |
| Cockpit | `packages/web/e2e/worker-relationships.e2e.ts` is discovered by the existing `*.e2e.ts` include. Actual browser observations and suite outcome are recorded below after execution. Component/cache tests cover query errors/retry, durable IDs, ask priority, attribution, all four tabs, full 32-worker list and all local/global/palette consumers. |

## Verification and observed failures

Exact commands, stdout/stderr and exit codes are retained under
`.superpowers/sdd/2026-09-06-owned-workers-isolated-worktrees-plan/native-task-9-*`.

- First targeted package attempt correctly settled the worker to `done`: its new
  fixture had omitted the existing review opt-in. Its teardown also called the
  worker-only termination barrier for the root, masking the first assertion and
  leaving the controller open. Wire/events were preserved; fixture setup and
  teardown were corrected. No product behavior or timeout was changed.
- First ordered typecheck failed on a duplicate observation key in the new browser
  test. The duplicate key was renamed; all later gates were withheld.
- First integrated full Vitest run: 364 files/7,436 tests passed, one test failed.
  The old autosave-gate fixture still invoked private `armAutosave(state)` after
  Task 6 added its run-ID argument. Both production call sites were correct.
  Updating the test seam and passing the actual fixture ID gave 6/6 focused
  passes. No production autosave mechanism changed.
- Existing broad-suite ENOENT/EISDIR diagnostics are preserved. The previously
  recorded OpenCode ten-second waits are not relabeled as a proven startup bug
  or fixed by a blanket timeout change.

Final ordered gates and actual browser results: pending execution.
