# One wait-kind table behind one wait engine

Decision record: [ADR 0061](../../docs/adr/0061-one-wait-engine-executes-wait-kind-rows.md).
Glossary: [Wait kind](../../GLOSSARY.md#wait-kind), [Wait engine](../../GLOSSARY.md#wait-engine).
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
  test or an entry literal; a grep with the false positives removed). Three more in
  `packages/contract` and eight in `packages/web` stay out of scope.
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
     what order, and how they fail (Table E). `open` takes these as per-path options, so 3.1
     changes no path. A path that compares the limit twice today (the PR wait, before and after
     its lookup) still compares it twice;
   - `resolve`: budget check, commit the result with its input, queue the wake;
   - `rearm`: arm every open wait of a recovered run;
   - `cancel` and `cancelAll`: commit, then disarm every watch kind;
   - `forgetRun`: disarm what a deleted run left in memory;
   - `dispose`: clear memory, keep the records.

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
P3.1 to P3.3 run in order (`run/wait-engine.ts`). P3.4 touches only the store and can run beside
P2 and P3.1 to P3.3 once 1.2 has merged. P3.5 runs last. P4.2 needs 1.2 and edits
`run/wait-registry.ts`: it lands before 3.1 starts or rebases onto it.

| Slice | Change | Files and regions at the baseline | Removes | Behavior change | Needs merged | Acceptance check |
|---|---|---|---|---|---|---|
| P0 | This spec, ADR 0061, glossary entries, pointers in ADR 0021 and the unified-waits spec | docs only | — | none | — | `node .github/scripts/check-citations.cjs` |
| 1.1 | One function stops every watch kind of a wait: CI watch, timer, CI retry, process watch and the worker resolve retry. The worker retry set moves from `FamilyReconciler` into `WaitWatches`. `RunManager.#disarmWait` calls the one function | `run.ts:355`; `run/wait-watches.ts:112-120`; `run/family-reconciler.ts:57`, `:288-290` | the three-call composite in the facade; `disarmProcessWatch` and `forgetRetry` as separate entry points | none | — | `npm test -- packages/cezar/src/workflows/ci-wait packages/cezar/src/workflows/worker-wait packages/cezar/src/workflows/subagent-waits.test.ts packages/cezar/src/workflows/run/boundary-family-reconciliation.test.ts`; `npm run test:parity` |
| 1.2 | One capacity function, `assertWaitCapacity(run, waitId?)` in `runs/wait-capacity.ts`, and one typed `WaitCapacityError`. Each of the 9 sites calls it where it compares today. The PR path keeps both compares: before its lookup (`:268`, an early refusal) and after it (`:298`, a registration that filled the list during the lookup). Each site maps the error to today's shape (Table B, column *After 1.2*). The store backstop throws it. Two callers of the backstop map it too: `openWait` to `capacity` with the `registrationGate` warning, and the worker list wait to site 1's `DelegationPolicyError`. Neither mapping is reachable at the baseline, because each path compares the limit in the same synchronous stretch before its commit, so the slice stays behavior-neutral | `run/wait-registry.ts:104`, `:241`, `:268`, `:298`, `:344`; `workflows/wait-scope.ts:60`; `run/human-waits.ts:65`; `run/turn-settler.ts:463`; `runs/wait-registration-write.ts:17` | 9 hand-written `>= WAIT_LIMIT` compares (the 9 call sites stay) | none | — | `npm test -- packages/cezar/src/workflows/ci-wait-list-registration.test.ts packages/cezar/src/workflows/worker-waits.test.ts packages/cezar/src/workflows/wait-scope.test.ts packages/cezar/src/workflows/subagent-waits.test.ts packages/cezar/src/runs/waits-store.test.ts packages/cezar/src/delegation/service.test.ts packages/cezar/src/workflows/run/turn-boundary-worker-order.test.ts`; `npm run test:parity` |
| 1.3 | One cancel function, `cancelWaits(runId, ids, opts)` in `run/wait-cancel.ts`: commit `cancelled`, then call the 1.1 disarm for each id; returns the settled waits. `opts.onCommitFailure` is `throw` (default) or `skip` (log `[cez] wait cancellation failed: <message>`, disarm nothing). `opts.superseded` passes through. The 7 commit-then-disarm sites call it (Table C). `cancelOpenWaits` keeps its own policy: it disarms even when the commit fails | `run/wait-registry.ts:182-183`, `:381-382`; `run/run-cancel.ts:129-132`; `run/family-reconciler.ts:210`, `:281-282`; `run/wake-admission.ts:60-62`; `run/subagent-waits.ts:231-240` | 7 hand-written commit-then-disarm pairs | none (see the `run-cancel.ts:131` note in Table C) | 1.1 | `npm test -- packages/cezar/src/workflows/worker-waits packages/cezar/src/workflows/peer-waits.test.ts packages/cezar/src/workflows/subagent-waits.test.ts packages/cezar/src/workflows/waits-wake.test.ts`; `npm run test:parity` |
| 1.4 | Reconcile a `worker` entry natively: revision match, `any`/`all`/`one` mode, first observations kept, request outcomes, the deadline (`timeout`) and no deadline for the completion wait. The cases of `delegation/wait.test.ts` move to the native function with the same inputs and expected results | `delegation/wait.ts:1-79`; `run/family-reconciler.ts:10`, `:279`; `delegation/wait.test.ts`; the comment at `runs/legacy-waits.ts:74` | `reconcileWorkerWait`, `reconcileRequestWait`, `legacyWorkerWait`, `observedWorkerEntry`, the `NEVER` sentinel | none | — | `npm test -- packages/cezar/src/delegation/wait.test.ts packages/cezar/src/workflows/worker-wait packages/cezar/src/workflows/request-completion.test.ts`; `npm run test:parity` |
| 2.1 | Rows gain budget charge, keeps slot, cancellable and `timers_disabled`. The readers read the row. `WAIT_KINDS` moves into the rows; `run-states.ts` imports and re-exports it | `workflows/waits.ts:66-71`, `:278-282`; `run/wake-admission.ts:409-427`; `run/wait-registry.ts:269-271`, `:328-329`, `:380`; `workflows/run-states.ts:261-299` | Table D rows 1-4 | none | P1 | `npm test -- packages/cezar/src/workflows/run-states.test.ts packages/cezar/src/workflows/waits.test.ts packages/cezar/src/workflows/waits-wake.test.ts`; `npm run test:parity` |
| 2.2 | Rows gain registration facts: answer kind, deadline rule, duplicate check with its defaults, entry builder | `workflows/waits.ts:38-41`, `:119-123`, `:132-161`, `:291-311`; `run/wait-registration.ts:12`, `:16`; `run/wait-registration-tool.ts:10`; `workflows/wait-scope.ts:58-64`, `:100-102`; `run/wait-registry.ts:107-109`, `:124`, `:131-133`, `:242`; `run/turn-settler.ts:467-470`; `run/subagent-waits.ts:173-174`; `run/human-waits.ts:66-67`; `run/run-recovery.ts:264`; `run/run-cancel.ts:119-121`; `delegation/service.ts:670` | Table D rows 6-8, 11, 12 | none | 2.1 | `npm test -- packages/cezar/src/workflows/waits.test.ts packages/cezar/src/workflows/ci-wait-registration.test.ts packages/cezar/src/workflows/wait-scope.test.ts packages/cezar/src/workflows/worker-waits.test.ts`; `npm run test:parity` |
| 2.3 | Rows gain the watch and the default resolve result. `armWait` dispatches through the row | `run/wait-watches.ts:48-79`; `workflows/waits.ts:315-328` | the `armWait` kind chain; the `settledWaitEntry` kind chain; Table D row 9 | none | 2.2 | `npm test -- packages/cezar/src/workflows/ci-wait packages/cezar/src/workflows/subagent-waits.test.ts packages/cezar/src/workflows/peer-waits.test.ts`; `npm run test:parity` |
| 2.4 | Rows gain their text: summary, result text, footer item, cap note and delivery label. Every string stays byte-identical | `workflows/waits.ts:98-109`, `:177-192`, `:260-269`, `:281`; `run/wake-admission.ts:63-65`; `run/input-delivery.ts:586` | Table D rows 5 and 10 (text) | none | 2.3 | `npm test -- packages/cezar/src/workflows/waits.test.ts packages/cezar/src/workflows/waits-wake.test.ts`; `npm run test:parity` |
| 3.1 | `WaitEngine.open` serves all 9 registration paths: `cezar_wait` (pr, timer, process, worker, request, peer), `cez worker wait`, the completion wait, `cez message wait --peer`, `cezar_ask`, the Cezar human alias, the monitoring timer, the subagent wait and the recovered ask. Each path keeps its refusal shape (Table B) and its open steps, their order and its failure policy (Table E), passed to `open` as per-path options | `run/wait-registry.ts:79-138`, `:163-173`, `:228-245`, `:253-364`; `run/human-waits.ts:59-71`; `run/turn-settler.ts:436-475`; `run/subagent-waits.ts:172-178`; `run/run-recovery.ts:257-270`; `run/compose.ts:278-305` | `openWait` and the open code in 4 other modules | none | P2 | `npm test -- packages/cezar/src/workflows/ci-wait packages/cezar/src/workflows/human-waits.test.ts packages/cezar/src/workflows/subagent-waits.test.ts packages/cezar/src/workflows/run/turn-settler.test.ts packages/cezar/src/workflows/peer-waits.test.ts`; `npm run test:parity` |
| 3.2 | `resolve` (with the CI and worker retries and the budget cap), `rearm` and `dispose` move into the engine | `run/wait-registry.ts:186-200`, `:390-409`; `run/wait-watches.ts:165-176`; `run/run-recovery.ts:222`, `:229`, `:337-340`, `:414-424`; `workflows/run.ts:260-269` | resolve and re-arm code outside the engine | none | 3.1 | `npm test -- packages/cezar/src/workflows/waits-wake.test.ts packages/cezar/src/workflows/worker-reboot packages/cezar/src/workflows/worker-restart`; `npm run test:parity` |
| 3.3 | `cancel`, `cancelAll` and `forgetRun` move into the engine. Every row of Table C calls one of them. `WaitRegistry` keeps only request validation (scope, gate, replay, refusals) | `run/wait-cancel.ts`; `run/wake-admission.ts:347-375`; `run/human-waits.ts:132-137`; `run/step-loop.ts:411-416`; `run/family-reconciler.ts:266`; `run/wait-registry.ts` | `cancelOpenWaits`, `disarmRunWaits` and `run/wait-cancel.ts` outside the engine | none | 3.2 | `npm test -- packages/cezar/src/workflows/waits-wake.test.ts packages/cezar/src/workflows/human-waits.test.ts packages/cezar/src/workflows/run-settlement.test.ts`; `npm run test:parity` |
| 3.4 | The store checks each wait write against `WAIT_PHASES` (Decision 3). A new entry must be `open`; a known entry may move only along a declared transition; an id found in `lastWaits` is a settled wait and records a violation. `WAIT_PHASES` first declares the transitions the code writes today (Decision 3). The slice deletes `RunStore.commitCiWait` (`runs/store.ts:1798-1800`): no production code calls it, and it creates a new `resolved` entry. Its test callers migrate: `runs/ci-wait-store.test.ts:32-65` and `:97` call `commitWait` with a `pr` entry, and the cases that create a resolved entry (`:43-52`, `:54-65`) commit it `open` first, then `resolved`; `workflows/autonomous-nudge-guards.test.ts:136` seeds its `ci-wait` case with `commitWait` and an open `pr` entry | `runs/wait-registration-write.ts:11-22`; `runs/outcome-commit.ts:118-172`; `runs/store.ts:1773-1800`; `workflows/run-states.ts:302-313`; `packages/cezar/vitest.setup.ts:177-178`; `runs/ci-wait-store.test.ts`; `workflows/autonomous-nudge-guards.test.ts:136-139` | the unchecked upsert; `commitCiWait` | tests only: an undeclared transition writes, then fails the test | 1.2 | `npm test -- packages/cezar/src/runs/waits-store.test.ts packages/cezar/src/runs/outcome-commit.test.ts packages/cezar/src/runs/ci-wait-store.test.ts packages/cezar/src/workflows/autonomous-nudge-guards.test.ts packages/cezar/src/workflows/run-states.test.ts`; `npm run test:parity` |
| 3.5 | A lint rule: no wait-kind literal in production code outside an allow-list: the engine, the table, the watch adapters, the legacy-waits upgrade, the boundary views, `packages/contract` and `packages/web` | new rule in `lint/` or `.ai/ast-grep/rules/` | — | none | 3.3 | `npm run lint`; the rule's own test |
| 4.2 | `registerCompletionWait` handles the limit refusal instead of throwing out of the turn end | `run/wait-registry.ts:128-138`; its caller in `run/turn-settler.ts` | — | yes: a full wait list no longer throws out of the turn end. A red test first | 1.2 | the new red test; `npm run test:parity` |

**Exit on integrated `main`:** one function compares the limit, called at each site that compares
today (the PR path twice, before and after its lookup); every cancel goes through
the engine; the kind-literal rule passes with about 8 production files of `packages/cezar` on its
allow-list (28 at the baseline); the inbound legacy round trip is deleted;
`npm run test:parity` and CI pass.

### Guards each slice keeps green

| Guard | What fires on a move | What the slice does |
|---|---|---|
| `workflows/run-states.test.ts:72-80` (`via` names) | Every `via` name in `RUN_TRIGGERS` must be declared as a function or method in `workflows/run.ts` or a direct child `run/*.ts` (`runSources()`, `:12-18`; subdirectories are not read) | The engine and the table live in direct children (`run/wait-engine.ts`, `run/wait-kinds.ts`). A slice that renames or deletes a `via` name (`resolveWait`, `armWait`, `refreshWait`, `openSubagentWait`, `withdrawCezarHumanWaits`, `parkOnWaits`, `queueWaitWake`, `resolvePeerWait`, `resolvePeerWaits`, `cancelAutomaticAtCap`, `reconcileWorkerWaits`, `cancel`) edits `RUN_TRIGGERS` in the same pull request |
| `workflows/run-states.test.ts:48` (`WAIT_KINDS`) | Each kind needs an automatic resolution or a `humanOnly` reason | 2.1 keeps the export and its fields |
| `run/wait-encapsulation.test.ts` | `state.waitIdentity` is a frozen `WaitGroup` from `createWaitGroup` in `run/wait-registry.ts`; `ciTurnId` changes only through `ensureCiTurn` and `rotateCiTurn` | Keep the factory where it is, or move it and update the test, the owner in `scripts/active-run-owner-rules.mjs` and the generated rules in one pull request |
| `active-run-*-write-outside-owner` ast-grep rules | Generated from `scripts/active-run-owner-rules.mjs` (`wait` owner `wait-registry.ts`, `children` owner `subagent-waits.ts`, `boundary` owner `turn-boundary.ts`); `scripts/active-run-owner-rules.test.mjs` fails on drift | A slice that moves an owner edits the metadata and runs `node scripts/active-run-owner-rules.mjs --write` |
| `outcome-write-outside-commit-outcome` | Writes `deliveredAt`, `consumedAt`, `cancelledAt`, `automaticWakes`, `waitDeliveryFailures` or `lastWaits` outside `runs/outcome-commit.ts` | The engine stages every settled phase through `RunStore.commitOutcome` |
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
| `WaitRegistry(ctx, host, 10)`, positional | `workflows/ci-wait-registration.test.ts:70`, `workflows/pr-merge-wait-parity.test.ts:75`, `workflows/ci-wait-conflict-parity.testkit.ts:57`; the last two pass a host Proxy that throws on any read | 1.2, 1.3, 3.1, 3.3 |
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
| cancel all | a failed commit is logged and never stops the disarm, so Stop still reaches the session when the store is closed | `run/wake-admission.ts:353-360` |

## Case tables

The run states and their exits do not change, so the **Transitions out** table of the template
does not apply. The tables below are the case tables for this change.

### Table A: each kind and its row

"No" in *Budget* means the wake is free. *Cancel* is `cezar_cancel_wait`.

| Field | pr | timer | process | human | worker | peer | subagent |
|---|---|---|---|---|---|---|---|
| Deadline | required, 1-7,200 s, default 1,800 (`workflows/waits.ts:301`) | required, 60-7,200 s (`:293`); monitoring timer: the interval (`run/turn-settler.ts:468`) | required, up to 7,200 s (`waits.ts:307`) | none (`packages/contract/src/waits.ts:322`; `waits.ts:120-122`) | agent wait required; Cezar's completion wait none (`run/wait-registry.ts:108`, `:131-133`; `hasWorkerDeadline`, contract `waits.ts:200`) | required, 1-1,800 s, default 600 (`wait-scope.ts:63`) | 30 min after the last child event, moved on each refresh (`run/subagent-waits.ts:166-168`, `:182-190`) |
| Keeps slot | yes (`run/wake-admission.ts:426`) | yes (`:426`) | yes (`:426`) | no: parks for the user (`:172-176`) | no (`:426`) | no (`:426`) | yes, also when not the top wait (`:409-421`) |
| Budget | no (`waits.ts:70`) | yes (`:70`) | yes (`:70`) | no | no | yes (`:70`) | only when resolved by its deadline (`:69`) |
| Cancel | yes | yes | yes | only before it is shown, `askSeq` unset (`run/wait-registry.ts:380`) | yes; `cez worker cancel-wait` only with a deadline (`run/run-cancel.ts:119`) | yes; also `cez message cancel-wait` (`run/wait-registry.ts:176-185`) | yes |
| `timers_disabled` | not checked | refused (`run/wait-registry.ts:270`); monitoring timer opens a human wait instead (`run/turn-settler.ts:446-450`) | refused (`run/wait-registry.ts:328`) | — | — | — | — |
| Budget spent at registration | not checked | refused (`:271`) | refused (`:329`) | — | — | — | — |
| `cezar_wait` answer kind | `pr` (`waits.ts:40`) | `timer` | `process` | not an answer (`:39`; `run/wait-registration-tool.ts:10`) | `worker`, or `request` with `requestIds` (`waits.ts:40`) | `peer` | not an answer |
| Duplicate check | same PR (normalized), `until ?? 'checks'`, `wake_on_conflict ?? true` (`waits.ts:137-138`); also an in-flight lookup key (`run/wait-registry.ts:276`) | same seconds, note and turn (`waits.ts:142`); monitoring: same `via` (`run/turn-settler.ts:445`) | same PID, start token and exit file (`waits.ts:139-141`) | one open per run (`run/wait-registry.ts:238-240`; `run/human-waits.ts:64-65`) | same ids in any order and mode `any` when omitted (`waits.ts:150-154`; `run/wait-registration.ts:16`) | same peers in any order (`waits.ts:158-161`; `wait-scope.ts:58-59`) | one open per run (`run/subagent-waits.ts:89-91`) |
| Entry builder | `prWaitEntry` (`waits.ts:298-303`) | `timerWaitEntry` (`:291-296`); monitoring (`run/turn-settler.ts:467-470`) | `processWaitEntry` (`waits.ts:305-311`) | `run/wait-registry.ts:242`; `run/human-waits.ts:66-67`; `run/run-recovery.ts:264` | `run/wait-registry.ts:107-109`, `:131-133` | `wait-scope.ts:62-64` | `run/subagent-waits.ts:173-174` |
| Watch | CI watch (`run/wait-watches.ts:50`, `:145-163`) | `setTimeout` on the deadline (`:70-78`) | process watch (`:51`, `:127-143`) | none (`:53`) | worker deadline re-reconciles the family (`:55`, `:87-109`) | resolves at once when the peer already wrote or settled, else a timer (`:57`) | interrupted when the session is gone, else a timer (`:58-61`) |
| Resolve result (default) | `outcome: 'deadline'` (`waits.ts:317`) | none (`:326`) | `outcome: 'deadline'` (`:319`) | not resolved: answered (`runs/outcome-commit.ts:156-161`) | the reconciled entry, else `reason: 'timeout'` (`waits.ts:321`) | `reason: 'timeout'` (`:323`); `message` or `settled` (`wait-scope.ts:80-87`) | `reason: 'timeout'` (`waits.ts:325`); `settled` (`run/subagent-waits.ts:204`); `interrupted` (`:262`); `superseded` on cancel (`runs/outcome-commit.ts:168`) |
| Text | `waits.ts:99`, `:178-181`, `:261` | `:108`, `:183` (monitoring), `:190-191`, `:268` | `:106`, `:187`, `:213-221`, `:266` | `:100-103`, `:185`, `:262` | `:104`, `:186`, `:199-209`, `:264` | `:105`, `:188`, `:225-231`, `:265` | `:107`, `:189`, `:235-246`, `:267` |
| Resolves, cancels, `humanOnly` (documentation) | `run-states.ts:272-275` | `:276-278` | `:279-281` | `:296-298` | `:292-295` | `:287-291` | `:282-286` |

Kind-specific facts that stay outside the row, because they belong to one kind's mechanism:
the PR wait holds conversation input for its own wake (`hasPrWait`, `waits.ts:287-289`, read at
`run/input-delivery.ts:672`); the upgraded worker wait's `wakeInputId` (`waits.ts:165-167`); the
peer wait needs messaging on (`run/wait-registry.ts:171`); the process wait's PID checks
(`:337-339`).

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

Callers that reach row 9. "Unreachable" means the path compares the limit in the same
synchronous stretch before its commit, so the backstop cannot refuse once that compare passed:

| Caller | Pre-check | On the backstop's refusal today | After 1.2 |
|---|---|---|---|
| `openWait` (`run/wait-registry.ts:358-359`): rows 2-6 | yes, in the same synchronous stretch | code `persistence`; unreachable | maps `WaitCapacityError` to code `capacity` with the `registrationGate` warning; other errors keep `persistence` |
| worker list wait (`run/wait-registry.ts:111`) | yes (row 1) | the error escapes: `cezar_wait` answers `outcome_unknown`; unreachable | maps `WaitCapacityError` to row 1's `DelegationPolicyError` |
| `registerCompletionWait` (`:134`) | none | the error escapes the turn end | unchanged; 4.2 changes this |
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

| # | Path | Compare | Withdraw | Commit | Arm | Park | Commit failure |
|---|---|---|---|---|---|---|---|
| 1 | `cezar_wait` kinds `pr`, `timer`, `process` (`run/wait-registry.ts:253-353` → `openWait` `:356-364`) | yes (`:268` and `:298` for a PR, before and after its lookup; `:344` for a process) | yes, after the compare (`:357`) | with receipt (`:358`) | yes (`:360`); a process whose PID is gone is disarmed and resolved at once (`:348-351`) | now | code `persistence` (`:359`) |
| 2 | worker and request list wait: `cez worker wait`, `cez message wait --request`, `cezar_wait` kinds `worker`, `request` (`:92-119`) | yes, after a family reconcile (`:94`, `:104`) | yes, after the compare (`:110`) | with receipt (`:111`) | through the family reconcile, which arms or resolves it (`:113`) | now, if the wait is still listed (`:117`) | throws to the caller |
| 3 | completion wait (`:128-138`) | no | no | no receipt (`:134`) | through the family reconcile (`:135`) | left to turn settlement (`run/turn-settler.ts:321-322`) | throws out of the turn end |
| 4 | peer wait: `cez message wait --peer`, `cezar_wait` kind `peer` (`:163-173`) | yes, in `peerWaitEntry` (`workflows/wait-scope.ts:60`) | yes, in `openWait` | with receipt | yes; resolves at once when the peer already wrote or settled | now | code `persistence` |
| 5 | `cezar_ask` (`:228-245`) | only when no agent question is open (`:241`) | yes, in `openWait` | no receipt | nothing to arm | now | code `persistence` |
| 6 | Cezar human alias (`run/human-waits.ts:59-71`) | yes, after the withdraw (`:65`) | only for an alias that is the agent's (`via` not `budget`, `no-wait` or `completion`), before the compare (`:62-63`) | no receipt (`:68`) | nothing to arm | left to the caller (`parkForUser`) | logged; returns undefined |
| 7 | monitoring and `ScheduleWakeup` timer (`run/turn-settler.ts:436-475`) | yes (`:463`) | yes, after the compare (`:471`) | no receipt (`:472`) | yes (`:474`) | left to turn settlement | logged; returns |
| 8 | subagent wait (`run/subagent-waits.ts:172-178`) | no | no | no receipt (`:175`) | yes (`:177`) | left to turn settlement | logged; the turn end falls back to the timer alias |
| 9 | recovered ask (`run/run-recovery.ts:257-270`) | no | yes, first (`:261`) | no receipt (`:264`) | nothing to arm | through recovery (`parkRecoveredRun`, `:305`) | logged; returns false |

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

## Older specs that disagree with the code

[The unified-waits spec](2026-10-17-unified-waits.md) says three things the code does not do.
The code wins. This spec changes none of them; a row records what the code does.

- **"Every wait except a human wait has a deadline"** (L90). Cezar's completion worker and
  request waits have none (`run/wait-registry.ts:131-133`). The subagent deadline moves with each
  child event (`run/subagent-waits.ts:182-190`).
- **"Nothing else ends a wait as a side effect"** (L70-71). These end a wait too: the agent's own
  registration cancels Cezar's human waits (`run/human-waits.ts:132-137`); a step's `timeoutMs`
  cancels human waits (`run/step-loop.ts:411-416`); the spent wake budget cancels timer, process,
  peer and timed-out subagent waits (`run/wake-admission.ts:58-67`); a runner resume supersedes
  the subagent wait and open timers (`run/subagent-waits.ts:222-229`).
- **Which wakes cost budget.** L326 names timer expiries, L1352 adds process wakes, and the
  [communication protocol](2026-10-27-task-communication-protocol.md) § 8 adds peer wakes. The code
  charges timer, process, peer, and a subagent wait resolved by its deadline
  (`workflows/waits.ts:66-71`).

## Open decisions

- **Refusing an undeclared wait-phase transition in production** (ADR 0056): after the 3.4
  warnings have run on the dev channel.

## Coordination

- Out of scope: the web package; engine-only parity cells (hearsay-tools/cezarion#2959), which are
  cheaper after P3; raising the 1,800 s cap and not charging a wake for a deadline that resolved
  nothing (row edits after this epic); the process exit-file race (hearsay-tools/cezarion#2904).
- hearsay-tools/cezarion#2445 and hearsay-tools/cezarion#2452 remove unreachable settlement paths
  in `run/turn-settler.ts`. Their coordinators check overlap with 1.2 and 3.1 there.
- Each slice's pull request names this spec and the epic. The planner gets each slice's pull
  request number.
