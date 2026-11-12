# One wait-kind table behind one wait engine

Decision record: [ADR 0061](../../docs/adr/0061-one-wait-engine-executes-wait-kind-rows.md).
Glossary: [Wait kind](../../GLOSSARY.md#wait-kind), [Wait engine](../../GLOSSARY.md#wait-engine).
Epic: hearsay-tools/cezarion#3079.
Baseline: `main` at `721c19b00`. The owner approved the plan on 2026-11-09 (planner task
f50d920b). The rules of [the unified-waits spec](2026-10-17-unified-waits.md) stay; this spec
changes where the per-kind rules live and who executes them.

Paths are under `packages/cezar/src/` unless they name a package. `run/` means
`workflows/run/`. Line numbers are as of the baseline; every slice moves them.

## Problem

A run's waits share one list, but each kind's rules are spread over many files. A new kind
touched 8 to 22 files under `packages/cezar/src`, counting neither tests (`*.test.*`) nor
testkits (`*.testkit.*`) nor fixtures (process: 8, hearsay-tools/cezarion#1522; peer and
request: 12, hearsay-tools/cezarion#2033; native subagents: 22, hearsay-tools/cezarion#2449).
At the baseline:

- **28 production files in `packages/cezar/src` branch on a wait's kind** (a `kind === '<kind>'`
  test, a `case` label or an entry literal). Table F lists each file and the slice that removes
  its branch, or its allow-list entry. The same search matches two files in `packages/contract`
  (`attention.ts`, `waits.ts`) and five in `packages/web`; both packages stay out of scope.
- **One per-kind table exists, and nothing executes it.** `WAIT_KINDS` (`workflows/run-states.ts:271-299`)
  holds deadline, keeps-slot, resolves and cancels per kind. Only `run-states.test.ts:48` reads it.
  `WAIT_PHASES` (`run-states.ts:302-313`) has no reader at all.
- **The open-wait limit is compared at 9 sites with 4 refusal shapes** (Table B): two error types,
  a plain store `Error`, and two silent returns.
- **Disarm is split in three.** `WaitWatches.disarmWait` (`run/wait-watches.ts:112-116`) stops CI
  watches, timers and CI retries. `disarmProcessWatch` (`:118-120`) stops process watches.
  `FamilyReconciler.forgetRetry` (`run/family-reconciler.ts:57`) forgets a worker resolve retry.
  Only the facade's `#disarmWait` (`workflows/run.ts:355`) calls all three. Every module reaches
  it through its host (`run.ts:200`, `run/compose.ts:274-305`), so no live path skips a watch
  today; the rule is held by wiring, not by one function.
- **Eleven sites write a `cancelled` outcome, under five policies** (Table C, groups C1-C5): six
  commit, then disarm, and a failed commit throws before the disarm; one disarms only after a
  successful commit and logs a failed one; one disarms even when the commit fails; two commit
  and never disarm, because nothing is armed; one logs a failed commit and never disarms.
- **12 per-kind rules have more than one copy** (Table D).
- **Worker waits round-trip through the old engine.** `reconcileWorkerEntry`
  (`delegation/wait.ts:71-79`) converts a list entry to the schema-3 `WorkerWait`
  (`legacyWorkerWait`, `:50-55`, with a `NEVER` deadline for the completion wait), runs the old
  `reconcileWorkerWait` (`:7-47`), and copies back only the outcomes (`:58-63`). The old `phase`,
  `wakeId` and `wake-pending` it computes are thrown away.
- **The store does not check wait phases.** `registeredWaitRecord`
  (`runs/wait-registration-write.ts:11-22`) upserts any `open` or `resolved` entry by id. It does
  not compare with the stored phase, so a `resolved` entry can be written back to `open`, and a
  stale commit of a wait that already moved to `lastWaits` appends it again as new. The only
  guard on open → resolved is in the caller (`run/wait-registry.ts:391-392`).

## Decisions

1. **One row per stored kind.** `run/wait-kinds.ts` holds one row for each of `pr`, `timer`,
   `process`, `human`, `worker`, `peer` and `subagent`, typed
   `{ readonly [K in Wait['kind']]: WaitKindRow<K> }`. A new kind fails typecheck until it has a
   row. `workflows/run-states.ts` imports the table, as it imports the run exits, and keeps the
   `WAIT_KINDS` export for its test. A row holds today's `WAIT_KINDS` fields (deadline, keeps
   slot, resolves, cancels, `humanOnly`) and: budget charge, cancellable, `timers_disabled`,
   answer kind, deadline rule, duplicate check, entry builder, watch, resolve result and text.
   `request` is not a stored kind: it stays a `worker` row with `requestIds`. `ci` stays a
   read-time upgrade to `pr` in `runs/legacy-waits.ts`.
2. **One wait engine behind RunManager.** `run/wait-engine.ts` executes the rows. It is a module
   under ADR 0053: it never imports `run.ts`, it calls back through a host, and the facade keeps
   its public methods. Operations:
   - `open`: compare the limit through the one capacity function, withdraw Cezar's human waits,
     commit, arm the watch, park. The paths differ today in which of these steps they run, in
     what order, and how they fail (Table E). `open` reads the arm, the park guard and the
     returned entry from the row (the `worker` row reconciles its family; every other row arms its
     watch). A path chooses only the withdraw, the receipt, the commit-failure policy, the park,
     and a result it already holds (a process wait on a PID already gone opens resolved and arms
     no watch);
     a step only one path runs (the compare, a check for an open human wait) stays at that call
     site, in the same order (hearsay-tools/cezarion#3153). 3.1 changes no path. A path that compares the limit twice today (the PR wait, before and after
     its lookup) still compares it twice;
   - `resolve`: budget check, commit the result with its input, queue the wake;
   - `rearm`: arm every open wait of a recovered run;
   - `refresh`: commit a changed open wait, then arm it; a moved deadline disarms the old one
     first (a subagent wait's new children, a worker wait's observations);
   - `cancel` and `cancelAll`: commit, then disarm every watch kind;
   - `forgetRun`: disarm what a deleted run left in memory;
   - `dispose`: clear memory, keep the records.

   A watch adapter takes a source request and an abort signal and returns or delivers an
   observation (deadline adapters deliver synchronously through an observe callback, to keep
   timer timing); it reads no run state. The engine owns everything run-scoped: the commit,
   the budget and the wake. Waits and automations stay separate; a trigger source is shared
   only when it gets a second user (hearsay-tools/cezarion#3127).

   Wake admission (`run/wake-admission.ts`) and the wake-budget ledger (`run/wake-ledger.ts`)
   stay outside the engine and call it.
3. **The store checks wait-phase transitions under the ADR 0056 rule.** An undeclared transition
   is written and recorded as a violation. Production logs one warning. The test setup fails the
   test after it ran (`packages/cezar/vitest.setup.ts:177-178` does this for run exits today).
   Nothing throws in the write path. `WAIT_PHASES` in `run-states.ts` is the declared set. It
   declares the transitions the code writes today and lacks at the baseline: open → delivered
   (an answered human wait, `runs/outcome-commit.ts:156-161`), open → open (a human wait shown,
   `run/human-waits.ts:81`, `:125`; a subagent refresh, `run/subagent-waits.ts:185`; a worker
   entry's observations, `run/family-reconciler.ts:296`) and resolved → resolved (a restored
   worker wake input, `run/wake-admission.ts:293`).
4. **Unchanged:** the contract package (wire schemas and attention facts stay there; it is
   Node-free, and the clone gate refuses a cross-package clone), the web package, the CLI
   worker-wait output shape (`workerWaitEntryToLegacy`, `packages/contract/src/waits.ts:680`,
   stays as a boundary view under `BACKWARD_COMPATIBILITY.md`), and every error code and message.
   Only slice 4.2 changes behavior.

## Slices

Each slice is one pull request into `main` and changes no behavior, unless its row says so.
Each slice that touches a wait, turn-end or settlement path in `workflows/run.ts` or `run/` runs
`npm run test:parity` before push (AGENTS.md). Every slice runs `npm run lint` and
`npm run typecheck` before its first push, and `npm run check:clones` when it moves code.

**Parallel work.** P1: 1.1, 1.2 and 1.4 can run at the same time. 1.3 starts when 1.1 has merged,
because its cancel function calls the 1.1 disarm. Hot files: `run/wait-registry.ts` (1.2 and
1.3, different regions) and `run/family-reconciler.ts` (1.1 at `:57`, 1.3 at `:210` and
`:281-282`, 1.4 at `:279`). The second pull request on a hot file rebases on the first.
P2 starts when P1 has merged; its slices run in order, because each edits `run/wait-kinds.ts`.
2.5 touches many files (Table F); it lands before 3.1 starts, so 3.1 moves code that already
reads the rows.
P3.1 to P3.3 run in order (`run/wait-engine.ts`). 3.4a needs no merged slice: it touches the
store's patch type, a testkit and test fixtures, so it can run beside P1, P2 and P3.1 to P3.3.
Its fixtures overlap test files that other slices edit (Table G); the second pull request on a
file rebases on the first. 3.4b needs 3.4a and 1.2 (both edit the store's wait write). P3.5 runs
last. P4.2 needs 1.2 and edits
`run/wait-registry.ts`: it lands before 3.1 starts or rebases onto it.

| Slice | Change | Files and regions at the baseline | Removes | Behavior change | Needs merged | Acceptance check |
|---|---|---|---|---|---|---|
| P0 | This spec, ADR 0061, glossary entries, pointers in ADR 0021 and the unified-waits spec | docs only | — | none | — | `node .github/scripts/check-citations.cjs` |
| 1.1 | One function stops every watch kind of a wait: CI watch, timer, CI retry, process watch and the worker resolve retry. The worker retry set moves from `FamilyReconciler` into `WaitWatches`. `RunManager.#disarmWait` calls the one function | `run.ts:355`; `run/wait-watches.ts:112-120`; `run/family-reconciler.ts:57`, `:288-290` | the three-call composite in the facade; `disarmProcessWatch` and `forgetRetry` as separate entry points | none | — | `npm test -- packages/cezar/src/workflows/ci-wait packages/cezar/src/workflows/worker-wait packages/cezar/src/workflows/subagent-waits.test.ts packages/cezar/src/workflows/run/boundary-family-reconciliation.test.ts`; `npm run test:parity` |
| 1.2 | One capacity function, `assertWaitCapacity(run, waitId?)` in `runs/wait-capacity.ts`, and one typed `WaitCapacityError`. Each of the 9 sites calls it where it compares today. The PR path keeps both compares: before its lookup (`:268`, an early refusal) and after it (`:298`, a registration that filled the list during the lookup). Each site maps the error to today's shape (Table B, column *After 1.2*). The store backstop throws it. Two callers of the backstop map it too: `openWait` to `capacity` with the `registrationGate` warning, and the worker list wait to site 1's `DelegationPolicyError`. Neither mapping is reachable at the baseline, so the slice stays behavior-neutral. Between the compare and the commit each path runs only synchronous code. Its one store write there is the withdraw of Cezar's human waits, which emits `run` events; no `run` listener opens a wait for a live run (the family listener only reaps scratch and resolves peer waits of settled runs, `run/family-reconciler.ts:34-46`; the others publish), and the withdraw can only lower the open count (Table B) | `run/wait-registry.ts:104`, `:241`, `:268`, `:298`, `:344`; `workflows/wait-scope.ts:60`; `run/human-waits.ts:65`; `run/turn-settler.ts:463`; `runs/wait-registration-write.ts:17` | 9 hand-written `>= WAIT_LIMIT` compares (the 9 call sites stay) | none | — | `npm test -- packages/cezar/src/workflows/ci-wait-list-registration.test.ts packages/cezar/src/workflows/worker-waits.test.ts packages/cezar/src/workflows/wait-scope.test.ts packages/cezar/src/workflows/subagent-waits.test.ts packages/cezar/src/runs/waits-store.test.ts packages/cezar/src/delegation/service.test.ts packages/cezar/src/workflows/run/turn-boundary-worker-order.test.ts`; `npm run test:parity` |
| 1.3 | One cancel function, `cancelWaits(runId, ids, opts)` in `run/wait-cancel.ts`: commit `cancelled`, then call the 1.1 disarm for each id; returns the settled waits. `opts.onCommitFailure` is `throw` (default) or `skip` (log `[cez] wait cancellation failed: <message>`, disarm nothing). `opts.superseded` passes through. The 7 commit-then-disarm sites call it (Table C). `cancelOpenWaits` keeps its own policy: it disarms even when the commit fails | `run/wait-registry.ts:182-183`, `:381-382`; `run/run-cancel.ts:129-132`; `run/family-reconciler.ts:210`, `:281-282`; `run/wake-admission.ts:60-62`; `run/subagent-waits.ts:231-240` | 7 hand-written commit-then-disarm pairs | none (see the `run-cancel.ts:131` note in Table C) | 1.1 | `npm test -- packages/cezar/src/workflows/worker-waits packages/cezar/src/workflows/peer-waits.test.ts packages/cezar/src/workflows/subagent-waits.test.ts packages/cezar/src/workflows/waits-wake-`; `npm run test:parity` |
| 1.4 | Reconcile a `worker` entry natively: revision match, `any`/`all`/`one` mode, first observations kept, request outcomes, the deadline (`timeout`) and no deadline for the completion wait. `delegation/wait.test.ts` splits by what live code can reach. Live code reaches the old function only through `reconcileWorkerEntry`, which passes `legacyWorkerWait(entry)`: phase `registered`, no `reason`, no `wakeId` (`delegation/wait.ts:50-55`); it returns early for an entry that is not `open` (`:72`). These cases translate to the native function, with an open entry as input and `{ entry, reason }` as the result: revision matching (`delegation/wait.test.ts:15-19`), an unchanged unexpired wait (`:20-22`), expiry at the exact deadline (`:24-25`), each worker status from `registered` (the `registered` half of `:30-37`), unrelated workers (`:40`), all-mode accumulation (`:52-60`), all-mode timeout with partial outcomes (`:61-65`), request accumulation and timeout (`:90-97`, `:100-104`), and the `reconcileWorkerEntry` cases (`:108-146`). These cases are deleted with the removed code, because they test inputs no live path builds: the `parked` phase (the `parked` half of `:30-37`), a stable `wakeId` on a `wake-pending` wait (`:26-28`), a recorded `reason` kept after the deadline (`:66`, `:68-73`), accumulation after settlement (`:41-45`, `:98`), and the reason inferred for a `wake-pending` wait without one (`:74-78`). A stored schema-3 row in those phases never reaches the reconcile: the store converts it on read (`workerWaitEntry`, `runs/legacy-waits.ts:111-127`), with its own inference (`inferredLegacyWaitReason`, `:76-83`) and its own tests (`runs/waits-store.test.ts:445-715`). Those tests have no case for a `wake-pending` row without a reason, so the slice adds one (an outcome and a timeout) before it deletes `:74-78`. The schema case (`:79-84`) does not call the function and stays | `delegation/wait.ts:1-79`; `run/family-reconciler.ts:10`, `:279`; `delegation/wait.test.ts`; `runs/waits-store.test.ts:445-715`; the comment at `runs/legacy-waits.ts:74` | `reconcileWorkerWait`, `reconcileRequestWait`, `legacyWorkerWait`, `observedWorkerEntry`, the `NEVER` sentinel | none | — | `npm test -- packages/cezar/src/delegation/wait.test.ts packages/cezar/src/runs/waits-store.test.ts packages/cezar/src/workflows/worker-wait packages/cezar/src/workflows/request-completion.test.ts`; `npm run test:parity` |
| 2.1 | Rows gain budget charge, keeps slot, cancellable and `timers_disabled`, and four flags the Table F readers ask: `userAnswers` (the user's answer settles it: `human`), `holdsConversationInput` (`pr`, open or resolved), `runnerResumeCancels` (the phases a runner resume cancels: `subagent` open or resolved, `timer` open) and `holdsSession` (`subagent`: any open one keeps the session and a slot). The readers read the row, including every Table F branch marked 2.1. The row facts stay plain data with no `run/` module import, so `runs/` files can read them (`runs/outcome-commit.ts` already imports `workflows/waits.ts`); 2.3 binds the watches in the engine. `WAIT_KINDS` moves into the rows; `run-states.ts` imports and re-exports it | `workflows/waits.ts:66-71`, `:278-282`; `run/wake-admission.ts:409-427`; `run/wait-registry.ts:269-271`, `:328-329`, `:380`; `workflows/run-states.ts:261-299` | Table D rows 1-4 | none | P1 | `npm test -- packages/cezar/src/workflows/run-states.test.ts packages/cezar/src/workflows/waits.test.ts packages/cezar/src/workflows/waits-wake-`; `npm run test:parity` |
| 2.2 | Rows gain registration facts: answer kind, deadline rule, duplicate check with its defaults (and the timeout field a repeat compares), entry builder, and the request kinds the row registers (`worker` registers `worker` and `request`). Each fact keeps every condition and exclusion Table A and Table E state for it: the wait's `source`, `askSeq`, `via` (monitoring timers), `mode`, `until`, and the completion wait against the agent wait. For example, the human row's duplicate check still skips Cezar's own human waits and the question the turn's opening answers. A row that drops a condition fails the slice. The Table F branches marked 2.2 read them | `workflows/waits.ts:38-41`, `:119-123`, `:132-161`, `:291-311`; `run/wait-registration.ts:12`, `:16`; `run/wait-registration-tool.ts:10`; `workflows/wait-scope.ts:58-64`, `:100-102`; `run/wait-registry.ts:107-109`, `:124`, `:131-133`, `:242`; `run/turn-settler.ts:467-470`; `run/subagent-waits.ts:173-174`; `run/human-waits.ts:66-67`; `run/run-recovery.ts:264`; `run/run-cancel.ts:119-121`; `delegation/service.ts:670` | Table D rows 6-8, 11, 12 | none | 2.1 | `npm test -- packages/cezar/src/workflows/waits.test.ts packages/cezar/src/workflows/ci-wait-registration.test.ts packages/cezar/src/workflows/wait-scope.test.ts packages/cezar/src/workflows/worker-waits.test.ts`; `npm run test:parity` |
| 2.3 | Rows gain the watch, the default resolve result, the result of a superseded cancel and the input id that delivers the result (`wakeInputId` for an upgraded worker wait). `armWait` dispatches through the row. The Table F branches marked 2.3 read them | `run/wait-watches.ts:48-79`; `workflows/waits.ts:315-328` | the `armWait` kind chain; the `settledWaitEntry` kind chain; Table D row 9 | none | 2.2 | `npm test -- packages/cezar/src/workflows/ci-wait packages/cezar/src/workflows/subagent-waits.test.ts packages/cezar/src/workflows/peer-waits.test.ts`; `npm run test:parity` |
| 2.4 | Rows gain their text: summary, result text, footer item, cap note, delivery label, monitoring-timer nudge, and the sessionless wake prompt with its priority (pr, worker, subagent, then the timer text). Every string stays byte-identical. The Table F branches marked 2.4 read them | `workflows/waits.ts:98-109`, `:177-192`, `:260-269`, `:281`; `run/wake-admission.ts:63-65`; `run/input-delivery.ts:586` | Table D rows 5 and 10 (text) | none | 2.3 | `npm test -- packages/cezar/src/workflows/waits.test.ts packages/cezar/src/workflows/waits-wake-`; `npm run test:parity` |
| 2.5 | Each row gains a typed selector (`WAIT_KINDS.<kind>.select(waits)`, and `selectOpen`) that returns that kind's entries. Every Table F branch marked 2.5 calls it instead of comparing `kind` with a literal: one kind's typed entries come from its row | the Table F rows marked 2.5: `delegation/park-notice.ts:28`; `voice/pending-ask.ts:42`; `run/completion-gate.ts:50`; `run/family-reconciler.ts:209`, `:255`; `run/human-waits.ts:46`, `:64`, `:77`, `:123`, `:148`; `run/run-cancel.ts:119`, `:121`, `:130`; `run/run-finish.ts:233`; `run/run-recovery.ts:259`, `:262`, `:277`; `run/subagent-waits.ts:90`; `run/wait-registry.ts:124`, `:189`, `:238`; `run/wake-admission.ts:172`, `:291`; `run/wake-ledger.ts:84`; `workflows/wait-scope.ts:69`, `:94`; `workflows/waits.ts:86` | the Table F branches marked 2.5 | none | 2.4 | `npm test -- packages/cezar/src/workflows/human-waits.test.ts packages/cezar/src/workflows/worker-waits.test.ts packages/cezar/src/workflows/peer-waits.test.ts packages/cezar/src/workflows/subagent-waits.test.ts packages/cezar/src/voice`; `npm run test:parity` |
| 3.1 | `WaitEngine.open` serves all 9 registration paths: `cezar_wait` (pr, timer, process, worker, request, peer), `cez worker wait`, the completion wait, `cez message wait --peer`, `cezar_ask`, the Cezar human alias, the monitoring timer, the subagent wait and the recovered ask. Each path keeps its refusal shape (Table B) and its open steps, their order and its failure policy (Table E), passed to `open` as per-path options | `run/wait-registry.ts:79-138`, `:163-173`, `:228-245`, `:253-364`; `run/human-waits.ts:59-71`; `run/turn-settler.ts:436-475`; `run/subagent-waits.ts:172-178`; `run/run-recovery.ts:257-270`; `run/compose.ts:278-305` | `openWait` and the open code in 4 other modules | none | P2 | `npm test -- packages/cezar/src/workflows/ci-wait packages/cezar/src/workflows/human-waits.test.ts packages/cezar/src/workflows/subagent-waits.test.ts packages/cezar/src/workflows/run/turn-settler.test.ts packages/cezar/src/workflows/peer-waits.test.ts`; `npm run test:parity` |
| 3.2 | `resolve` (with the CI and worker retries and the budget cap), `rearm` and `dispose` move into the engine. Each watch adapter meets the Decision 2 adapter rule: it returns or delivers an observation (deadline adapters deliver synchronously through an observe callback, to keep timer timing). The timer, peer, subagent and worker watches get one deadline adapter, and their run-scoped steps move into the engine | `run/wait-registry.ts:186-200`, `:390-409`; `run/wait-watches.ts:165-176`; `run/family-reconciler.ts:287-297`; `run/wait-watches.ts:48-147`; `run/input-delivery.ts`; `run/wake-admission.ts`; `run/run-recovery.ts:222`, `:229`, `:337-340`, `:414-424`; `workflows/run.ts:260-269` | resolve and re-arm code outside the engine | none | 3.1 | `npm test -- packages/cezar/src/workflows/waits-wake- packages/cezar/src/workflows/worker-reboot packages/cezar/src/workflows/worker-restart`; `npm run test:parity` |
| 3.3 | `cancel`, `cancelAll` and `forgetRun` move into the engine. Every row of Table C calls one of them. `WaitRegistry` keeps only request validation (scope, gate, replay, refusals) | `run/wait-cancellation.ts`; `run/wait-cancel.ts` (deleted); `run/wake-admission.ts:347-375`; `run/human-waits.ts:132-137`; `run/step-loop.ts:411-416`; `run/family-reconciler.ts:266`; `run/wait-registry.ts` | `cancelOpenWaits`, `disarmRunWaits` and `run/wait-cancel.ts` outside the engine | none | 3.2 | `npm test -- packages/cezar/src/workflows/waits-wake- packages/cezar/src/workflows/human-waits.test.ts packages/cezar/src/workflows/run-settlement.test.ts`; `npm run test:parity` |
| 3.4a | Prepare the fixtures for the phase check. Add `seedWaits(store, runId, { waits, lastWaits })` to `runs/run-store.testkit.ts`: it writes through the unchecked update path, as `setRunStatus` does (ADR 0056), and the import guard keeps it out of production. Migrate the Table G fixtures by one rule: a fixture that needs a wait already past `open` seeds it with `seedWaits`; a fixture whose test is about the commit itself commits the entry `open` first, then moves it along a transition 3.4b declares. Delete `RunStore.commitCiWait` (`runs/store.ts:1798-1800`): no production code calls it, and it creates a new `resolved` entry. Its test callers migrate: `runs/ci-wait-store.test.ts:32-65` and `:97` call `commitWait` with a `pr` entry, and the cases that create a resolved entry (`:43-52`, `:54-65`) commit it `open` first, then `resolved`; `workflows/autonomous-nudge-guards.test.ts:136` seeds its `ci-wait` case with `commitWait` and an open `pr` entry. Remove `waits` and `lastWaits` from `RunPatch` (`runs/run-exits.ts:23`): no production code writes them through `updateRun` (§ Table G), so after this slice only `commitWait`, `commitOutcome` and `seedWaits` write them. The worker finds the calls to migrate by its own scan (§ Table G), and by running the 3.4b check locally without committing it | `runs/run-store.testkit.ts`; `runs/run-exits.ts:23`; `runs/store.ts:1798-1800`; `runs/ci-wait-store.test.ts`; `workflows/autonomous-nudge-guards.test.ts:133-139`; every fixture in Table G | `commitCiWait`; `waits` and `lastWaits` in `RunPatch`; new non-open entries in test fixtures outside `seedWaits` | none | none | `npm test -- packages/cezar/src/runs/ci-wait-store.test.ts packages/cezar/src/workflows/autonomous-nudge-guards.test.ts` and every file in Table G; `npm run typecheck`; `npm run lint` (the import guard) |
| 3.4b | The store checks each wait write against `WAIT_PHASES` (Decision 3), with the ADR 0056 rule: an undeclared transition is written and recorded as a violation; production logs a warning; the test setup fails the test in `afterEach`. A new entry must be `open`; a known entry may move only along a declared transition; an id found in `lastWaits` is a settled wait and records a violation. The check covers both production write paths of `waits` and `lastWaits`: `commitWait` and `commitOutcome`. `WAIT_PHASES` first declares the transitions the code writes today (Decision 3) | `runs/wait-registration-write.ts:11-22`; `runs/outcome-commit.ts:118-172`; `runs/store.ts:1773-1797`; `workflows/run-states.ts:302-313`; `packages/cezar/vitest.setup.ts:177-178` | the unchecked upsert | tests only: an undeclared transition writes, then fails the test | 3.4a, 1.2 | `npm test -- packages/cezar/src/runs/waits-store.test.ts packages/cezar/src/runs/outcome-commit.test.ts packages/cezar/src/workflows/run-states.test.ts` and every file in Table G; `npm run test:parity` |
| 3.5 | A lint rule over production files of `packages/cezar/src`: no `kind` compared (`===`, `!==`) with one of the seven stored kind names or `ci`, no `case` label with one, and no object property `kind` with one, outside the allow-list. The rule is syntactic, like the repository's other rules, so the allow-list names each file with its reason (Table F): the engine, the table, the watch adapters, the read-time upgrade, the two boundary views, and two files whose `kind` is not a wait kind. `packages/contract` and `packages/web` are outside its scope | new rule in `lint/` or `.ai/ast-grep/rules/` | — | none | 3.3, and every slice that Table F names | `npm run lint`; the rule's own test |
| 4.2 | `registerCompletionWait` handles the limit refusal instead of throwing out of the turn end | `run/wait-registry.ts:128-138`; its caller in `run/turn-settler.ts` | — | yes: a full wait list no longer throws out of the turn end. A red test first | 1.2 | the new red test; `npm run test:parity` |

**Exit on integrated `main`:** one function compares the limit, called at each site that compares
today (the PR path twice, before and after its lookup); every cancel goes through
the engine; the kind-literal rule passes with the 6 files of Table F's allow-list (28 files branch
on a wait's kind at the baseline); the inbound legacy round trip is deleted;
`npm run test:parity` and CI pass.

### Guards each slice keeps green

| Guard | What fires on a move | What the slice does |
|---|---|---|
| `workflows/run-states.test.ts:72-80` (`via` names) | Every `via` name in `RUN_TRIGGERS` must be declared as a function or method in `workflows/run.ts` or a direct child `run/*.ts` (`runSources()`, `:12-18`; subdirectories are not read) | The engine and the table live in direct children (`run/wait-engine.ts`, `run/wait-kinds.ts`). A slice that renames or deletes a `via` name (`resolveWait`, `armWait`, `refreshWait`, `openSubagentWait`, `withdrawCezarHumanWaits`, `parkOnWaits`, `queueWaitWake`, `resolvePeerWait`, `resolvePeerWaits`, `cancelAutomaticAtCap`, `reconcileWorkerWaits`, `cancel`) edits `RUN_TRIGGERS` in the same pull request |
| `workflows/run-states.test.ts:48` (`WAIT_KINDS`) | Each kind needs an automatic resolution or a `humanOnly` reason | 2.1 keeps the export and its fields |
| `run/wait-encapsulation.test.ts` | `state.waitIdentity` is a frozen `WaitGroup` from `createWaitGroup` in `run/wait-registry.ts`; `ciTurnId` changes only through `ensureCiTurn` and `rotateCiTurn` | Keep the factory where it is, or move it and update the test, the owner in `scripts/active-run-owner-rules.mjs` and the generated rules in one pull request |
| `active-run-*-write-outside-owner` ast-grep rules | Generated from `scripts/active-run-owner-rules.mjs` (`wait` owner `wait-registry.ts`, `children` owner `subagent-waits.ts`, `boundary` owner `turn-boundary.ts`); `scripts/active-run-owner-rules.test.mjs` fails on drift | A slice that moves an owner edits the metadata and runs `node scripts/active-run-owner-rules.mjs --write` |
| `outcome-write-outside-commit-outcome` | Writes `deliveredAt`, `consumedAt`, `cancelledAt`, `automaticWakes`, `waitDeliveryFailures` or `lastWaits` outside `runs/outcome-commit.ts` | A `resolved` write goes through `commitWait(runId, settled, input)`; `delivered` and `cancelled` receipts go through `commitOutcome` |
| `workflows/run-private-access.test.ts` | A private `RunManager` member must be `#private` | An engine field on the facade is `#waitEngine` |
| File length (`file-length.test.ts`, limit 1,000 lines) | A new file over the limit fails; `runs/store.ts` is pinned at its length | Split the engine by operation before it nears the limit. A slice that shrinks `runs/store.ts` runs `FILE_LENGTH_UPDATE=1 npm run lint` |
| Clone gate (`.github/scripts/check-clones.cjs`) | A new file pair with clone tokens, a grown pair, a new same-file clone, any cross-package clone | A move deletes the old copy in the same pull request. No row copies contract code |
| Complexity gate (`.ai/skills/check-code-quality/scripts/complexity-gate.mjs`) | A new or grown function over complexity 20; a moved body that stays identical matches its source | Move bodies verbatim first, then change them in a later commit |
| `cez/runner-fact-combination`, `cez/run-fact-reader` | Two runner facts in one function; a file that reads `autoResumeAt` must be listed in `lint/resume-time-readers.json` | The engine reads no runner fact. A slice that moves an `autoResumeAt` read updates the list |

**Tests that spy on `RunManager` methods.** Modules reach these methods through the host that
`run/compose.ts` builds, so a spy sees each internal call. A slice that makes the engine call
its own method instead breaks them; it keeps the host route (ADR 0053):

| Method | Tests | Slices that touch the path |
|---|---|---|
| `reconcileWorkerWaits` | `delegation/conversation-effects.test.ts:21`, `delegation/conversation-service.test.ts:426`, `workflows/dead-owner-claims.test.ts:76`, `workflows/delegation-transcript-reads.test.ts:52`, `:79`, `:86`, `workflows/request-completion.test.ts:108`, `workflows/worker-wait-outcomes.test.ts:91` (mocked to a no-op) | 1.4, 3.1, 3.2 |
| `registerWait`, `recover` | `workflows/waits.testkit.ts:55`, `:68` (`observeWaitTimers`); `server/project-context-warm.test.ts`, `server/archive-on-merge-boot.test.ts`, `server/providers-api.test.ts` (`recover`) | 3.1, 3.2 |
| `registerRequestWait` | `delegation/peer-conversations.test.ts:266` (mocked) | 1.2, 3.1 |
| `acceptDone` | `workflows/waits-parity-cells.testkit.ts:314`, `:2703`, `:2716`, `:3586`; `workflows/worker-waits-messages.test.ts:182` | 3.3 |

**Tests that construct modules directly.** A host or constructor change breaks them:

| Module | Tests | Slices |
|---|---|---|
| `WaitRegistry(ctx, host, 10)`, positional | `workflows/ci-wait-registration.test.ts:70`, `workflows/pr-merge-wait-parity.test.ts:75`, `workflows/ci-wait-conflict-parity.testkit.ts:57`; the last two pass a host Proxy that throws on any read | 1.2, 1.3, 3.1, 3.2, 3.3 |
| `TurnSettler` | `run/turn-settler.test.ts`, `run/boundary-order.testkit.ts`, `workflows/autonomous-nudge-guards.test.ts`, `workflows/completion-gate-entry.test.ts` | 1.2, 3.1 |
| `HumanWaits` | `run/boundary-order.testkit.ts` | 1.2, 3.1, 3.3 |
| `FamilyReconciler` (`unused` host) | `run/boundary-family-reconciliation.test.ts:22` | 1.1, 1.3, 1.4 |
| `SubagentWaits` | `run/children-encapsulation.test.ts`, `run/turn-boundary-adapter-order.test.ts` | 1.3, 3.1 |
| `WakeAdmission` (`unused` host) | `run/turn-boundary-adapter-order.test.ts` (two) | 1.3, 2.1, 3.3 |
| `RunFinish`, `RunSettlement` | `workflows/fixture-cleanup.test.ts`, `workflows/run-settlement.test.ts`, `workflows/step-completion-mark.test.ts`, `run/run-settlement-branch-sweep.test.ts`, `run/turn-boundary-adapter-order.test.ts`, `workflows/completion-gate-entry.test.ts` | 3.3 |

## Orders that must survive

These come from [the decomposition spec](2026-10-28-run-ts-decomposition.md#orders-that-must-survive)
and the lifecycle research. The engine keeps each one:

| Operation | Order | Today |
|---|---|---|
| open | each registration path runs the steps Table E lists for it, in today's order. The common order is compare the limit → withdraw Cezar's human waits → commit (with the registration receipt when there is one) → arm → park when the run is at a boundary or parked. The human alias and the recovered ask withdraw first. A path that commits and arms commits first, so a watch never resolves a wait that is not on disk | `run/wait-registry.ts:356-364`; Table E |
| resolve | the wait is still open → budget check on the resolved entry → commit the result with its input → queue the wake; a failed queue arms the admission retry | `run/wait-registry.ts:390-409` |
| park | human wait first, then clear the idle timer, then publish the intent; `releaseSlot` last | `run/wake-admission.ts:169` onward |
| finish | cancel open waits first, then persist the root finish request | `run/run-finish.ts:170-173` |
| dispose | `disposed = true` first; wait records stay, so a later manager re-arms them | `workflows/run.ts:260-269` |
| reentrancy | after every host callback, read the run from the store again; keep no snapshot across a callback. `resolveWait` → `queueWaitWake` → `flushAgentInputs` → `cancelAutomaticAtCap` re-enters synchronously, and `reconcileWorkerWaits` re-enters itself | `run/family-reconciler.ts:254-306` |
| family snapshot exception | `endStoppedParent` reads `parent.waits` once. `reconcileWorkerEntries` keeps its selected entries through retired cancellation and the open-entry loop; the same-family recursion guard still returns. Do not add a read or iteration after each `cancel`: the move keeps the existing snapshots | `run/family-reconciler.ts`: `endStoppedParent`, `reconcileWorkerEntries`, `reconcileWorkerWaits` |
| re-arm snapshot exception | The four recovery re-arm loops keep their caller-held snapshot (`found` for the usage-limit hold; `run` after `parkRecoveredRun`, inside `parkOnOpenWaits` and for owed results in `rearmRecoveredWakes`). An overdue timer may resolve inside the loop; do not re-read between waits | `run/run-recovery.ts:221`, `:228`, `:338`, `:417` at `54078b114` |
| cancel all | a failed commit is logged and never stops the disarm, so Stop still reaches the session when the store is closed | `run/wake-admission.ts:353-360` |

## Case tables

The run states and their exits do not change, so the **Transitions out** table of the template
does not apply. The tables below are the case tables for this change.

### Table A: each kind and its row

Each cell states the rule with every condition its code applies: the wait's `source` (agent or
Cezar), its `via` (for example a monitoring timer, `via` `monitoring-line` or `schedule-wakeup`),
`askSeq` (a human wait shown to the user), `mode`, `until`, and an agent wait against Cezar's
completion wait. Slice 2.2 and its neighbours move each rule into the row with these conditions;
a row that drops one changes behavior. "No" in *Budget* means the wake is free. *Cancel* is
`cezar_cancel_wait`; it cancels only an `open` wait (`run/wait-registry.ts:379`).

| Field | pr | timer | process | human | worker | peer | subagent |
|---|---|---|---|---|---|---|---|
| Deadline | required, 1-7,200 s, default 1,800 (`packages/contract/src/ci-wait.ts:21`; set at `workflows/waits.ts:301`) | agent timer: `seconds`, 60-7,200 s (`waits.ts:293`; contract `waits.ts:29-30`). Monitoring timer: the `ScheduleWakeup` delay clamped to 60 s and `scheduleWakeupMaxSeconds`, else the monitoring interval (`run/turn-settler.ts:464`, `:468`) | required, 1-7,200 s, default 1,800 (`waits.ts:307`; contract `waits.ts:33-34`) | none (contract `waits.ts:322`; `waits.ts:120-122`) | agent wait (`source` agent): required, 1-7,200 s, default 600 (contract `waits.ts:270`; `run/wait-registry.ts:108`). Cezar's completion wait (`source` cezar, `via` completion): none (`:131-133`; `hasWorkerDeadline`, contract `waits.ts:200`) | required, 1-7,200 s, default 600 (contract `waits.ts:270`; `wait-scope.ts:63`) | 30 min after the last child event, moved on each refresh (`run/subagent-waits.ts:166-168`, `:182-190`) |
| Keeps slot | yes when it is the top wait: no open human, worker, peer or subagent wait ranks above it, and no usage-limit hold (`run/wake-admission.ts:425-427`; order in contract `computeWaitingOn`, `waits.ts:572-598`) | as pr | as pr | no: any open human wait, of either source, parks for the user first (`run/wake-admission.ts:172-176`) | no (`:426`) | no (`:426`) | yes, whichever wait ranks first: any open subagent wait, or live children without one, keeps the session and a slot (`:409-421`) |
| Budget | no | yes, agent and monitoring timers alike | yes except an empty deadline observation | no | no | yes except an empty deadline observation | only when resolved by its deadline, `result.reason` `timeout` (`:69`) |
| Cancel | yes | yes | yes | only while not shown, `askSeq` unset (`run/wait-registry.ts:380`). Cezar's own human wait (`source` cezar) is not listed to the agent (`waits.ts:85-87`, `:120`) | yes. Cezar's completion wait (no deadline) is not listed to the agent (`waits.ts:120`). `cez worker cancel-wait` cancels only a wait with a deadline (`run/run-cancel.ts:119`) | yes; also `cez message cancel-wait` (`run/wait-registry.ts:176-185`) | yes |
| `timers_disabled` | not checked | agent timer: refused (`run/wait-registry.ts:270`). Monitoring timer: Cezar opens a human wait (`via` `monitoring-line`) instead (`run/turn-settler.ts:446-450`) | refused (`run/wait-registry.ts:328`) | — | — | — | — |
| Wake budget at registration | not checked | agent timer: refused when spent (`:271`). Monitoring timer: when spent, Cezar notes the cap once and opens its `budget` human wait (`run/turn-settler.ts:452-461`); on an autonomous run with wakes left and a continuation possible, no timer opens (`:439`) | refused when spent (`run/wait-registry.ts:329`) | `cezar_ask` on an autonomous run is refused (`autonomous_run`) while wakes remain (`:233`) | — | — | — |
| `cezar_wait` answer kind | `pr` (`waits.ts:40`) | `timer` | `process` | not an answer (`:39`; `run/wait-registration-tool.ts:10`) | `worker`, or `request` when the entry has `requestIds` (`waits.ts:40`) | `peer` | not an answer |
| Duplicate check | an open wait with the same PR (case and trailing slash ignored), the same `until` (`checks` when omitted) and the same `wake_on_conflict` (true when omitted) (`waits.ts:137-138`); also a lookup still in flight for that key (`run/wait-registry.ts:276-281`). A repeat with another `timeout_seconds` is refused `duplicate_deadline` (`run/wait-registration.ts:30-33`) | agent timer: an open timer with the same `seconds` and `note`, registered in the same turn (`waits.ts:142`); a repeat never compares a timeout (`run/wait-registry.ts:266`). Monitoring timer: none opens when an open timer has the same `via`, or, for `monitoring-line`, when any open wait other than a human wait exists (`run/turn-settler.ts:444-445`) | an open wait with the same PID, the same start token (read only while the PID is live) and the same resolved exit file (`waits.ts:139-141`; `run/wait-registry.ts:340-343`); another timeout is refused `duplicate_deadline` | `cezar_ask`: the first open agent human wait (`source` not cezar), skipping the one whose `askSeq` the turn's opening answers while the session is open (`run/wait-registry.ts:237-239`; `run/continuation-session.ts:214-221`). A shown one (`askSeq` set) is returned unchanged; an unshown one keeps its id and takes the new card (`:240-244`). So an answer turn can hold two open human waits: the answered one until its turn end settles it, and the new question. Human alias: any open human wait, of either source, is returned and none opens (`run/human-waits.ts:64-65`). Recovered ask: none opens while an agent human wait, or one shown as the pending ask, is open (`run/run-recovery.ts:259-262`) | agent wait: an open worker entry with the same target kind (`workerIds` or `requestIds`), the same ids in any order and the same `mode` (`any` when omitted) (`waits.ts:150-154`; `run/wait-registration.ts:16`), and only an entry with a deadline is a repeat (`run/wait-registry.ts:103`); another timeout is refused `duplicate_deadline`. Completion wait: no check (`:128-138`) | an open peer wait with the same peers in any order (`waits.ts:158-161`; `wait-scope.ts:58-59`); another timeout is refused `duplicate_deadline` | one open per run: the turn end refreshes the open one instead of opening another (`run/subagent-waits.ts:89-91`, `:130-139`) |
| Entry builder | `prWaitEntry` (`waits.ts:298-303`) | agent: `timerWaitEntry` (`:291-296`); monitoring: `run/turn-settler.ts:467-470` (`note` only for `monitoring-line`) | `processWaitEntry` (`waits.ts:305-311`) | `cezar_ask` (`source` agent, `via` `cezar_ask`): `run/wait-registry.ts:242`; alias (`source` cezar for `via` budget, no-wait, completion, else agent): `run/human-waits.ts:62`, `:66-67`; recovered ask (`via` `ask-line`, shown): `run/run-recovery.ts:264` | agent wait: `run/wait-registry.ts:107-109`; completion wait (`source` cezar, `mode` all, own workers only): `:130-133` | `wait-scope.ts:62-64` | `run/subagent-waits.ts:173-174` (`source` cezar) |
| Watch | CI watch (`run/wait-watches.ts:50`, `:145-163`); its result does not check whether the run can proceed | `setTimeout` on the deadline; an overdue one fires at once; a stopping, stopped or finishing run takes no wake and the wait stays open (`:62-78`) | process watch (`:51`, `:127-143`); a run that cannot proceed takes no wake (`:136`) | none (`:53`) | agent wait: the deadline re-reconciles the family (`:55`, `:87-109`). Completion wait: nothing armed; only a reconcile resolves it (`:88-89`) | resolves at once when a named peer already wrote or settled, else a timer as for timer (`:57`; `run/wait-registry.ts:194-200`, which also skips a run that cannot proceed) | interrupted at once when the session is gone, else a timer as for timer, which interrupts it if the session is gone when it fires (`:58-69`) |
| Resolve result (default) | the watcher's validated observation, else `outcome: 'deadline'` (`waits.ts:317`; `run/wait-watches.ts:151-158`) | none (`:326`) | the watcher's result, else `outcome: 'deadline'` (`:319`) | not resolved: an `answered` outcome settles open human waits as `delivered` (`runs/outcome-commit.ts:156-161`) | the reconciled entry, else `reason: 'timeout'` (`waits.ts:321`) | `reason: 'timeout'` (`:323`); `message` or `settled` (`wait-scope.ts:80-87`) | `reason: 'timeout'` (`waits.ts:325`); `settled` (`run/subagent-waits.ts:204`); `interrupted` (`:262`); `superseded` on a cancel with `superseded` (`runs/outcome-commit.ts:168`) |
| Text | by `until`: `waits.ts:99`, `:178-181`, `:261` | monitoring timer (`via` `monitoring-line` or `schedule-wakeup`): `:183`; agent timer: `:108`, `:190-191`, `:268` | `:106`, `:187`, `:213-221`, `:266` | `:100-103`, `:185`, `:262`; Cezar's own wait is left out of the footer (`:275`) | worker or request by `requestIds`: `:104`, `:186`, `:199-209`, `:264` | `:105`, `:188`, `:225-231`, `:265` | `:107`, `:189`, `:235-246`, `:267` |
| Resolves, cancels, `humanOnly` (documentation) | `run-states.ts:272-275` | `:276-278` | `:279-281` | `:296-298` | `:292-295` | `:287-291` | `:282-286` |

Two more facts become row fields: the PR wait holds conversation input for its own wake
(`hasPrWait`, `waits.ts:287-289`, read at `run/input-delivery.ts:672`; flag
`holdsConversationInput`, 2.1), and the upgraded worker wait delivers through its `wakeInputId`
(`waits.ts:165-167`; input id, 2.3). Two checks stay in their kind's registration code, because
they compare no kind: the peer wait needs messaging on (`run/wait-registry.ts:171`), and the
process wait checks its PID (`:337-339`).

### Table B: the limit sites

`WAIT_LIMIT` is 16 (`packages/contract/src/waits.ts:27`). *Warn* is the
`[cez] wait registration refused: <code>` line of `registrationGate` (`run/wait-registry.ts:208`).
"Message 60" and "message 77" are `ci-wait/errors.ts:60` and `:77`.

| # | Site | Path | Today's refusal | Agent or CLI sees | After 1.2 |
|---|---|---|---|---|---|
| 1 | `run/wait-registry.ts:104` | worker and request list wait | `DelegationPolicyError('capacity_limit', 'This run already has 16 open waits; cancel one first')`, no warn | CLI `cez worker wait`, `cez message wait --request`: `capacity_limit` with that message. `cezar_wait`: `delegationWaitRefusal` maps it to `capacity` (`wait-scope.ts:115`), message 60 | the site maps `WaitCapacityError` to the same `DelegationPolicyError` |
| 2 | `workflows/wait-scope.ts:60` | peer wait (`peerWaitEntry`) | same `DelegationPolicyError`, no warn | CLI `cez message wait --peer`: `capacity_limit`. `cezar_wait`: `capacity`, message 60 | as row 1 |
| 3 | `run/wait-registry.ts:241` | `cezar_ask` | `Error{code:'capacity'}` through `registrationGate`; warn | `capacity`, message 77 (`run/cezar-tools.ts:59` maps by code) | the site maps to the same coded error and warn |
| 4 | `run/wait-registry.ts:268` | timer and PR, before the lookup: an early refusal | as row 3 | `capacity`, message 60 (`run/wait-registration-tool.ts` maps by code) | as row 3; the compare stays |
| 5 | `run/wait-registry.ts:298` | PR, after the lookup: a registration that filled the list during the lookup | as row 3 | as row 4 | as row 3; the compare stays, so the PR path compares twice |
| 6 | `run/wait-registry.ts:344` | process wait | `Error{code:'capacity'}` through a local `refuse`; no warn | as row 4 | the coded error, no warn |
| 7 | `run/human-waits.ts:65` | `openHumanAlias` | silent: returns the open human wait, or undefined | nothing | stays silent |
| 8 | `run/turn-settler.ts:463` | monitoring and `ScheduleWakeup` timer | silent `return` | nothing | stays silent |
| 9 | `runs/wait-registration-write.ts:17` | store backstop on every `commitWait` of a new open entry | plain `Error('open wait limit reached (16)')` | depends on the caller, below | throws `WaitCapacityError` with the same message |
| 10 | `run/wait-registry.ts`, `registerCompletionWait` | completion worker or request wait | before 4.2: the store backstop throws out of the turn end | nothing after 4.2 | After 4.2: `registerCompletionWait` compares `waitCapacityAvailable` and on a full list returns undefined silently; no commit, reconcile or parked-worker notice; turn settlement parks on the remaining waits, else for the user |

Callers that reach row 9. "Unreachable" means the backstop cannot refuse once the path's own
compare passed. Between that compare and the commit the path runs only synchronous code. Its one
store write there is the withdraw of Cezar's human waits (`run/human-waits.ts:132-137`). That
commit emits `run` events to the store's listeners (`runs/store.ts:2003-2008`). No listener opens
a wait for a live run: `FamilyReconciler.onDelegationRun` (`run/family-reconciler.ts:34-46`) reaps
scratch, cancels the waits of a settled run, and resolves the peer waits that name a settled run
(`runsAwaitingPeer` returns none for a live one); the other listeners publish or stream
(`activity/publisher.ts`, `activity/tool-activity.ts`, `artifacts/reports-index.ts`,
`runs/webhook.ts`, `server/server.ts`, `server/workspace-run-feed.ts`, `headless-run.ts`). The
withdraw itself only lowers the open count. A slice that adds a listener which opens a wait, or a
write between the compare and the commit, re-checks this table:

| Caller | Pre-check | On the backstop's refusal today | After 1.2 |
|---|---|---|---|
| `openWait` (`run/wait-registry.ts:358-359`): rows 2-6 | yes, in the same synchronous stretch | code `persistence`; unreachable | maps `WaitCapacityError` to code `capacity` with the `registrationGate` warning; other errors keep `persistence` |
| worker list wait (`run/wait-registry.ts:111`) | yes (row 1) | the error escapes: `cezar_wait` answers `outcome_unknown`; unreachable | maps `WaitCapacityError` to row 1's `DelegationPolicyError` |
| `registerCompletionWait` (`:134`) | after 4.2: yes (row 10), in the same synchronous stretch | the error escapes the turn end at the baseline | after 4.2: unreachable after the pre-check; a full list opens none silently, other errors still escape |
| subagent wait (`run/subagent-waits.ts:175-176`) | none | logged; the turn end falls back to the timer alias | unchanged; the log text keeps the message |
| recovered ask (`run/run-recovery.ts:263-268`) | none | logged; returns false | unchanged |
| human alias (`run/human-waits.ts:68-69`) | row 7 | logged; returns undefined | unchanged |
| monitoring timer (`run/turn-settler.ts:472-473`) | row 8 | logged; returns | unchanged |

### Table E: the steps each registration path runs to open a wait

Opening is not one sequence today. Each path below runs its own subset of the steps, in its own
order, with its own failure policy. `open` takes these as per-path options; 3.1 keeps every cell.
*Compare* is the limit compare (Table B). *Withdraw* cancels Cezar's open human waits
(`run/human-waits.ts:132-137`). *Receipt* is the `cezar_wait` registration receipt
(`operation_id`). *Park now* parks when the run is at a turn boundary or parked
(`run/wait-registry.ts:117`, `:361`).

| # | Path | Before the compare | Compare | Withdraw | Commit | Arm | Park | Commit failure |
|---|---|---|---|---|---|---|---|---|
| 1 | `cezar_wait` kinds `pr`, `timer`, `process` (`run/wait-registry.ts:253-353` → `openWait` `:356-364`) | replay of the `operation_id` (`:256`), the registration gate (`:259`). Timer and PR: the duplicate check (`:265-266`). Process: `timers_disabled`, the wake budget, the exit file, the PID checks and the duplicate check (`:328-343`) | timer and PR before the lookup (`:268`); PR again after it (`:298`); process (`:344`). Then a timer checks `timers_disabled` and the wake budget (`:270-271`) | yes, after the compare (`:357`) | with receipt (`:358`); the tool always sends an `operation_id` | yes (`:360`); a process whose PID is already gone is disarmed and resolved at once (`:348-351`) | now | code `persistence` (`:359`) |
| 2 | worker and request list wait: `cez worker wait`, `cez message wait --request`, `cezar_wait` kinds `worker`, `request` (`:92-119`) | a family reconcile (`:94`), the worker gate (`:95`), the scope check (`:98-101`), the duplicate check, which repeats only a wait with a deadline (`:102-103`) | yes (`:104`) | yes, after the compare (`:110`) | with receipt from `cezar_wait` (`:111`); the CLI passes none (`:81`, `:158`) | through the family reconcile, which arms or resolves it (`:113`) | now, if the wait is still listed (`:117`) | throws to the caller |
| 3 | completion wait (`:128-138`) | none; after the compare, the worker ids are narrowed to the run's own workers (`:130`) | yes, silent | no | no receipt (`:134`) | through the family reconcile (`:135`), then notice parked workers | left to turn settlement (`run/turn-settler.ts:321-322`): withdraw Cezar human waits → refusal note → completion wait → park | a full list opens none; other errors throw out of the turn end |
| 4 | peer wait: `cez message wait --peer`, `cezar_wait` kind `peer` (`:163-173`) | the worker gate (`:164`), the peer scope and the duplicate check in `peerWaitEntry` (`workflows/wait-scope.ts:57-59`); after the compare, a new wait needs messaging on (`run/wait-registry.ts:171`) | yes, in `peerWaitEntry` (`workflows/wait-scope.ts:60`) | yes, in `openWait` | with receipt from `cezar_wait`; the CLI passes none (`delegation/service.ts:592`) | yes; resolves at once when a named peer already wrote or settled | now | code `persistence` |
| 5 | `cezar_ask` (`:228-245`) | the registration gate (`:230-231`); refused on an autonomous run while wakes remain (`:233`); the open agent question, skipping the one this turn's opening answers (`:237-239`): a shown one is returned unchanged (`:240`) | only when no agent question is open besides that skipped one (`:241`); an unshown open question keeps its id and takes the new card, with no compare | yes, in `openWait` | no receipt | nothing to arm | now | code `persistence` |
| 6 | human alias (`run/human-waits.ts:59-71`) | the withdraw (next column); any open human wait, of either source, is returned and none opens (`:64-65`) | yes, after the withdraw (`:65`) | only for an alias whose source is the agent (`via` not `budget`, `no-wait` or `completion`), before the compare (`:62-63`) | no receipt (`:68`) | nothing to arm | left to the caller (`parkForUser`) | logged; returns undefined |
| 7 | monitoring and `ScheduleWakeup` timer (`run/turn-settler.ts:436-475`) | the run can proceed (`:438`); not on an autonomous run with wakes left that can continue (`:439`); the duplicate rules of Table A (`:444-445`); `timers_disabled` opens a human alias instead (`:446-450`); a spent budget opens Cezar's `budget` human wait instead (`:452-461`) | yes (`:463`) | yes, after the compare (`:471`) | no receipt (`:472`) | yes (`:474`) | left to turn settlement | logged; returns |
| 8 | subagent wait (`run/subagent-waits.ts:172-178`) | the turn end has live children, an open session, no done and no pending permission request, and no subagent wait is open (`:130-139`) | no | no | no receipt (`:175`) | yes (`:177`) | left to turn settlement | logged; the turn end falls back to the timer alias |
| 9 | recovered ask (`run/run-recovery.ts:257-270`) | an unanswered ask in the transcript and no open agent human wait or wait shown as that ask (`:258-260`); after the withdraw, no open human wait (`:262`) | no | yes, first (`:261`) | no receipt (`:264`) | nothing to arm | through recovery (`parkRecoveredRun`, `:305`) | logged; returns false |

### Table C: cancel paths

Eleven sites write a `cancelled` outcome through `RunStore.commitOutcome`. They fall into five
disjoint policy groups:

- **C1, commit then disarm; a failed commit throws before the disarm** (6): rows 1, 2, 3, 10, 11
  and 13.
- **C2, disarm only after a successful commit; a failed commit is logged** (1): row 14.
- **C3, disarm even when the commit fails; a failed commit is logged** (1): `cancelOpenWaits`
  (`run/wake-admission.ts:356`), reached by rows 4-8.
- **C4, commit only; a failed commit throws; nothing is armed** (2): rows 12 and 16.
- **C5, commit only; a failed commit is logged; nothing is armed** (1): row 15.

Slice 1.3 serves C1 and C2, the seven commit-then-disarm sites. Row 9 writes nothing: the row
is gone.

| # | Path | Site | Today | Engine call (3.3) |
|---|---|---|---|---|
| 1 | Agent `cezar_cancel_wait` | `run/wait-registry.ts:381-382` | commit, then disarm; a failed commit throws before the disarm | `cancel` (1.3: `cancelWaits`, `throw`) |
| 2 | `cez message cancel-wait` on a peer wait | `run/wait-registry.ts:182-183` | as row 1 | `cancel` (1.3) |
| 3 | `cez worker cancel-wait` | `run/run-cancel.ts:129-132` | as row 1; `:131` throws between commit and disarm when the receipt lacks the wait | `cancel` (1.3). The `:131` check moves after the disarm. It cannot fire: `:125` saw the wait open, and the `cancelled` handler settles every open id it names (`runs/outcome-commit.ts:164`) |
| 4 | Stop, run cancel, worker stop | `run/run-cancel.ts:39` → `cancelOpenWaits` | commit every open and resolved wait; a failed commit is logged; disarm each wait and `disarmRunWaits` always | `cancelAll` |
| 5 | Finish | `run/run-finish.ts:172` | `cancelOpenWaits` | `cancelAll` |
| 6 | Done at the turn end | `run/turn-settler.ts:70` | `cancelOpenWaits` | `cancelAll` |
| 7 | Terminal run seen by the family pass | `run/family-reconciler.ts:39` | `cancelOpenWaits` | `cancelAll` |
| 8 | Recovery of a terminal row | `run/run-recovery.ts:419` | `cancelOpenWaits` | `cancelAll` |
| 9 | Run deleted | `run/wake-admission.ts:373-374` | `disarmRunWaits` only: the row is gone | `forgetRun` |
| 10 | Settled parent's worker waits | `run/family-reconciler.ts:210` | commit, then disarm | `cancel` (1.3) |
| 11 | Every named worker destroyed, wait open | `run/family-reconciler.ts:281-282` | commit, then disarm | `cancel` (1.3) |
| 12 | Every named worker destroyed, wait resolved | `run/family-reconciler.ts:266` | commit only: the wait was disarmed when it resolved (`:294`) | `cancel`; the disarm finds nothing |
| 13 | Wake budget spent at resolution or flush | `run/wake-admission.ts:58-67` (from `run/wait-registry.ts:399`, `run/input-delivery.ts:641`) | commit, then disarm and a cap note per wait | `cancel` (1.3); the notes follow, no host callback runs between |
| 14 | Runner resumed the parent itself | `run/subagent-waits.ts:231-240` | commit with `superseded`; a failed commit is logged and nothing is disarmed | `cancel` with `skip` and `superseded` (1.3) |
| 15 | Agent's own wait replaces Cezar's human waits | `run/human-waits.ts:132-137` | commit; a failed commit is logged; nothing to disarm | `cancel` with `skip`; the disarm finds nothing |
| 16 | Step deadline expired | `run/step-loop.ts:411-416` | commit human waits; nothing to disarm | `cancel`; the disarm finds nothing |

Not cancels, and they stay as they are: the subagent refresh disarms and re-arms the same wait
(`run/subagent-waits.ts:187-188`); a process wait whose PID is already gone disarms and resolves
at once (`run/wait-registry.ts:348-351`); a failed worker resolve disarms and arms a retry
(`run/family-reconciler.ts:289-291`). Timer, worker, peer, PR and process deadlines resolve
their wait; they never cancel it.

### Table D: per-kind rules with more than one copy

| # | Rule | Copies at the baseline | Removed by |
|---|---|---|---|
| 1 | Which kinds spend a wake | `chargesBudget` (`workflows/waits.ts:66-71`); registration refusal for timer and process only (`run/wait-registry.ts:271`, `:329`); cap note wording (`run/wake-admission.ts:63-65`); delivery label (`run/input-delivery.ts:586`) | 2.1 (rule), 2.4 (text) |
| 2 | Which kinds keep a slot | `WAIT_KINDS.keepsSlot` and `MONITORING` (`workflows/run-states.ts:100`, `:271-299`); `parkTopKeepsSlot` (`run/wake-admission.ts:425-427`), which reads `WaitingOn` kinds | 2.1 |
| 3 | Which waits the agent can cancel | `cancelWait` refuses a shown human wait (`run/wait-registry.ts:380`); the footer treats every human wait as not cancellable (`workflows/waits.ts:278-279`) and lists the kinds again (`:281`) | 2.1 (rule), 2.4 (text) |
| 4 | `timers_disabled` | timer (`run/wait-registry.ts:270`), process (`:328`), monitoring timer (`run/turn-settler.ts:446`) | 2.1 |
| 5 | PR `until` wording | `workflows/waits.ts:99`, `:179-181`, `:261`; the rung split in `packages/contract/src/attention.ts` stays (Decision 4) | 2.4 |
| 6 | Which kinds have a deadline or are `cezar_wait` answers | `openWaitSchema` (contract, stays); `openWaitList` (`workflows/waits.ts:120`); `waitAnswerKind` (`:38-41`); `run/wait-registration-tool.ts:10`; `WAIT_KINDS.deadline` | 2.2 |
| 7 | Which kinds `cezar_wait` registers through delegation | `isDelegationWait` (`workflows/wait-scope.ts:100-102`); the exclusion in `identicalWait` (`workflows/waits.ts:136`); the contract schema stays | 2.2 |
| 8 | Duplicate defaults | PR URL normalization and the worker/request `mode: 'any'` default in `registrationIdentity` (`run/wait-registration.ts:12`, `:16`) and again in `identicalWait` and `identicalWorkerWait` (`workflows/waits.ts:137`, `:153`) | 2.2 |
| 9 | Arm and disarm are not one pair | `armWait` dispatches by kind (`run/wait-watches.ts:48-79`); disarm is three functions (`:112-120`, `run/family-reconciler.ts:57`) | 1.1 (disarm), 2.3 (watch per row) |
| 10 | Monitoring timers | `isMonitoringTimer` (`workflows/waits.ts:57-59`); `run/turn-settler.ts:444-445`; `run/subagent-waits.ts:225-226`; `run/wake-admission.ts:65`; `run/input-delivery.ts:586` | 2.4 (text), 3.1 (open rule) |
| 11 | Worker wait with a deadline against the completion wait | `run/wait-registry.ts:103`, `:124`; `run/run-cancel.ts:119-121`; `delegation/service.ts:670`; inlined in `workflows/waits.ts:120` | 2.2 |
| 12 | Entry building | `workflows/waits.ts:291-311`; `workflows/wait-scope.ts:62-64`; `run/wait-registry.ts:107-109`, `:131-133`, `:242`; `run/turn-settler.ts:467-470`; `run/subagent-waits.ts:173-174`; `run/human-waits.ts:66-67`; `run/run-recovery.ts:264`. The upgrade builders in `runs/legacy-waits.ts` stay | 2.2 |

### Table F: every file that branches on a wait kind

Each file that the 3.5 rule matches at the baseline gets one disposition: the slice that removes
its branch and the row field, selector or engine operation that replaces it, or its allow-list
entry with the reason. 3.5 lands only when every row below is done. Search: the 3.5 rule's
pattern over production files of `packages/cezar/src` (a `kind` compared with `===` or `!==`, a
`case` label, or an object property `kind`, with one of `pr`, `timer`, `process`, `human`,
`worker`, `peer`, `subagent`, `ci`), tests and testkits excluded.

| # | File | Branches at the baseline | Disposition |
|---|---|---|---|
| 1 | `activity/wait.ts` | `:37-77` (`case` labels and `kind` literals) | allow-list: boundary view. It builds the contract's `ActivityWait` wire kinds from `WaitingOn` |
| 2 | `delegation/park-notice.ts` | `:28` worker; `:60` human | `:28` 2.5 worker selector; `:60` 2.1 `userAnswers` |
| 3 | `delegation/service.ts` | `:670` worker; `:733-734` worker and request; `:739` peer | allow-list: CLI boundary. It routes `cez worker cancel-wait` and `cez message cancel-wait` by stored kind and answers in each kind's CLI shape (`BACKWARD_COMPATIBILITY.md`) |
| 4 | `runs/archive-family.ts` | `:129` human | 2.1 `userAnswers`: an open wait the user answers blocks the automatic archive |
| 5 | `runs/legacy-waits.ts` | `:25`, `:67`, `:120`, `:135`, `:171`, `:235`, `:242`, `:249` | allow-list: the read-time upgrade of schema-3 rows and `ci` entries |
| 6 | `runs/outcome-commit.ts` | `:157` human; `:168` subagent | `:157` 2.1 `userAnswers` (the `answered` handler settles the open waits the user answers); `:168` 2.3 superseded-cancel result |
| 7 | `voice/pending-ask.ts` | `:42` human | 2.5 human selector |
| 8 | `workflows/run-scheduling.ts` | `:46-50` pr, worker, subagent | 2.4 sessionless wake prompt and its priority |
| 9 | `run/completion-gate.ts` | `:50` worker | 2.5 worker selector |
| 10 | `run/continuation-session.ts` | `:219` human | 2.1 `userAnswers` |
| 11 | `run/family-reconciler.ts` | `:209`, `:255` worker | 2.5 worker selector |
| 12 | `run/human-waits.ts` | `:46`, `:64`, `:77`, `:123`, `:148` human; `:66` entry | 2.5 human selector; `:66` 2.2 entry builder |
| 13 | `run/input-batch.ts` | `:12` human | 2.1 `userAnswers` |
| 14 | `run/input-delivery.ts` | `:756` human | 2.1 `userAnswers` |
| 15 | `run/run-cancel.ts` | `:119`, `:121`, `:130` worker | 2.5 worker selector, with 2.2's deadline rule |
| 16 | `run/run-finish.ts` | `:233` human | 2.5 human selector |
| 17 | `run/run-recovery.ts` | `:259`, `:262`, `:277` human; `:264` entry | 2.5 human selector; `:264` 2.2 entry builder |
| 18 | `run/step-loop.ts` | `:413` human | 2.1 `userAnswers`: a step deadline expires the waits the user answers |
| 19 | `run/subagent-waits.ts` | `:90` subagent; `:173` entry; `:225-226` subagent and timer | `:90` 2.5 subagent selector; `:173` 2.2 entry builder; `:225-226` 2.1 `runnerResumeCancels` |
| 20 | `run/turn-settler.ts` | `:444` human; `:445` timer; `:467` entry | `:444` 2.1 `userAnswers`; `:445` 2.2 duplicate check; `:467` 2.2 entry builder |
| 21 | `run/wait-registration-tool.ts` | `:10` human, subagent | 2.2 answer kind |
| 22 | `run/wait-registration.ts` | `:12` pr; `:16` worker, request; `:30` timer | 2.2 duplicate defaults and the timeout field a repeat compares |
| 23 | `run/wait-registry.ts` | `:107`, `:131`, `:242` entries; `:124` worker; `:189` peer; `:238` human; `:264`, `:266`, `:269`, `:297`, `:312`, `:343` request dispatch; `:380` human | entries 2.2; `:124`, `:189`, `:238` 2.5 selectors; the request dispatch 3.1 (`open` dispatches through the row's registration facts); `:380` 2.1 `cancellable` |
| 24 | `run/wait-watches.ts` | `:50-60` | no exception needed: the watch adapters hold no kind literal; `armWait` dispatches through the row |
| 25 | `run/wake-admission.ts` | `:63` process, peer, subagent; `:172` human; `:291` worker; `:410` subagent | `:63` 2.4 cap note; `:172`, `:291` 2.5 selectors; `:410` 2.1 `holdsSession` |
| 26 | `run/wake-ledger.ts` | `:84` human | 2.5 human selector |
| 27 | `workflows/wait-scope.ts` | `:62` entry; `:69`, `:94` peer; `:98-106` request kinds | `:62` 2.2 entry builder; `:69`, `:94` 2.5 peer selector; `:98-106` 2.2 request kinds per row |
| 28 | `workflows/waits.ts` | `:38-40`, `:58`, `:69-70`, `:86`, `:99-107`, `:120`, `:136-160`, `:166`, `:178-189`, `:261-267`, `:278-279`, `:288`, `:291-306`, `:316-324` | 2.1 `:69-70` budget, `:278-279` `userAnswers` and `cancellable`, `:288` `holdsConversationInput`; 2.2 `:38-40` answer kind, `:120` deadline rule, `:136-160` duplicates, `:291-306` builders; 2.3 `:166` input id, `:316-324` results; 2.4 `:58` monitoring timer, `:99-107`, `:178-189`, `:261-267` text; 2.5 `:86` human selector |
| 29 | `server/forge/github.ts` | many | allow-list: not a wait kind. Its `kind` is a GitHub item kind (`pr` or `issue`) |
| 30 | `subcommands.ts` | `:31` | allow-list: not a wait kind. Its `case 'worker'` is a CLI subcommand |
| 31 | `run/wait-engine.ts`, `run/wait-kinds.ts` | new | allow-list: the table only. The engine holds no kind literal and needs no exception. hearsay-tools/cezarion#3153 merged `run/wait-resolve.ts` and `run/wait-cancellation.ts` into the engine |

The allow-list at the end of the epic holds 6 files: rows 1, 3, 5, 29, 30 and the table
of row 31. Only files with a kind-literal match have an exception; the stale-entry test enforces this.

### Table G: test fixtures 3.4a migrates

3.4b checks every write of `waits` and `lastWaits`. A grep finds no production write outside
`commitWait`, `commitOutcome` and the read-time upgrade:
`grep -rnE "\b(waits|lastWaits)\s*:" packages/cezar/src --include=*.ts` with tests, testkits,
`runs/outcome-commit.ts`, `runs/wait-registration-write.ts` and `runs/legacy-waits.ts` left out
finds only reads and parameter names.

Test fixtures do write non-open entries. A scan lists every test and testkit call to
`commitWait`, `commitCiWait`, `updateRun`, `setRunStatus`, `createRun` or
`registeredWaitRecord` whose arguments hold a wait with a phase other than `open`. It parses each
file with `@babel/parser` (typescript plugin) and resolves helper functions and constants across
all test and testkit files up to three levels. Command, from the repository root:
`node .ai/qa/wait-engine/scan-non-open-waits.mjs "$PWD"`. The script is a planning aid and is
not committed; the 3.4a worker runs a scan of its own on its baseline. At `721c19b00` the scan
lists 82 calls in 34 files. The list is a superset: a call that moves a known entry along a
declared transition, or that matched a helper of the same name, needs no change. The 3.4a pull
request migrates every call that 3.4b's check would fail, by the one rule in its row.

| File | Lines |
|---|---|
| `delegation/conversation-service.test.ts` | `:358` |
| `delegation/destruction-results.test.ts` | `:268` |
| `delegation/service.testkit.ts` | `:53` |
| `runs/ci-wait-store.test.ts` | `:37, :47, :48, :55, :97` |
| `runs/outcome-commit.test.ts` | `:45, :67, :78, :80, :81, :126` |
| `runs/store-claims.test.ts` | `:86` |
| `runs/store-resume-time.test.ts` | `:66, :116` |
| `runs/store.test.ts` | `:448` |
| `runs/waits-store.test.ts` | `:226, :228, :229, :242, :244, :245, :246, :253, :262, :263, :264, :278, :287, :288, :289, :306, :324, :351, :352, :363, :364, :388, :643, :644` |
| `runs/webhook.test.ts` | `:127, :143, :165, :180, :252` |
| `server/activity-routes.test.ts` | `:186, :209` |
| `server/runs-index-api.test.ts` | `:407` |
| `task-cli/cli.test.ts` | `:509, :580, :1051` |
| `task-cli/status-question.test.ts` | `:49` |
| `task-cli/watch.test.ts` | `:38` |
| `workflows/auto-resume.test.ts` | `:778` |
| `workflows/autonomous-nudge-guards.test.ts` | `:133, :136` |
| `workflows/completion-gate-entry.test.ts` | `:144` |
| `workflows/peer-waits.test.ts` | `:251` |
| `workflows/run-settlement.test.ts` | `:178` |
| `workflows/run.test.ts` | `:1206, :1225, :1246, :1261` |
| `workflows/run/boundary-family-reconciliation.test.ts` | `:19` |
| `workflows/run/turn-boundary-adapter-order.test.ts` | `:38, :51` |
| `workflows/run/turn-boundary-worker-order.test.ts` | `:60, :63` |
| `workflows/run/turn-nudges-decisions.test.ts` | `:213` |
| `workflows/subagent-waits.test.ts` | `:413, :456` |
| `workflows/waits-parity-cells.testkit.ts` | `:2110` |
| `workflows/waits-subagents-parity-cells.testkit.ts` | `:110` |
| `workflows/worker-destroy-orphaned-generation.test.ts` | `:319` |
| `workflows/worker-parent-attention.testkit.ts` | `:204` |
| `workflows/worker-wait-core.testkit.ts` | `:321` |
| `workflows/worker-wait-disposal.test.ts` | `:67, :68` |
| `workflows/worker-wait-settlement.test.ts` | `:57` |
| `workflows/worker-wait-terminal-ordering.test.ts` | `:125` |

## Older specs that disagree with the code

[The unified-waits spec](2026-10-17-unified-waits.md) says three things the code does not do.
The code wins. This spec changes none of them; a row records what the code does.

- **"Every wait except a human wait has a deadline"** (L90). Cezar's completion worker and
  request waits have none (`run/wait-registry.ts:131-133`). The subagent deadline moves with each
  child event (`run/subagent-waits.ts:182-190`).
- **"Nothing else ends a wait as a side effect"** (L70-71). These end a wait too: the agent's own
  registration cancels Cezar's human waits (`run/human-waits.ts:132-137`); a step's `timeoutMs`
  cancels human waits (`run/step-loop.ts:411-416`); the spent wake budget cancels timer, chargeable process,
  chargeable peer and timed-out subagent waits (`run/wake-admission.ts:58-67`); a runner resume supersedes
  the subagent wait and open timers (`run/subagent-waits.ts:222-229`).
- **Which wakes cost budget.** L326 names timer expiries, L1352 adds process wakes, and the
  [communication protocol](2026-10-27-task-communication-protocol.md) § 8 adds peer wakes. The code
  charges timer, substantive process and peer outcomes, and a subagent wait resolved by its deadline;
  empty dependency deadline observations do not charge
  (`workflows/waits.ts:66-71`).

## Open decisions

- **Refusing an undeclared wait-phase transition in production** (ADR 0056): after the 3.4b
  warnings have run on the dev channel.

## Coordination

- Out of scope: the web package; engine-only parity cells (hearsay-tools/cezarion#2959), which are
  cheaper after P3; the later 7,200 s dependency cap and empty-deadline charging change
  ([ADR 0061](../../docs/adr/0061-one-wait-engine-executes-wait-kind-rows.md#longer-dependency-waits-and-empty-deadline-wakes),
  [hearsay-tools/squawk#3339](https://github.com/hearsay-tools/squawk/issues/3339)); the process exit-file race (hearsay-tools/cezarion#2904).
- hearsay-tools/cezarion#2445 and hearsay-tools/cezarion#2452 remove unreachable settlement paths
  in `run/turn-settler.ts`. Their coordinators check overlap with 1.2 and 3.1 there.
- Each slice's pull request names this spec and the epic. The planner gets each slice's pull
  request number.
