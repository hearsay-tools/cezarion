# Group ActiveRun fields by owner

Status: design draft for coordinator and planner review. No product change is authorized by this document.
Subject: hearsay-tools/cezarion#2520, slice 4.1 of hearsay-tools/cezarion#2487.
Baseline: `origin/main` at `172032e46e4475add22af4d11b20143a1f73ac3e`, fetched 2026-11-04.
All source paths below start at `packages/cezar/src/`, unless stated otherwise.
Line regions refer only to this SHA. PR labels P1–P5 below name future implementation PRs, not existing pull requests.

## Decision and limits

Give each field one module that writes it. Readers get a deep read-only view. Commands name an
operation, not an arbitrary patch. Keep each command at the old write's position in its handler.
Put all turn-boundary writes behind `transitionTurnBoundary`. Keep stored statuses under
`RunStore.move`; [ADR 0056](../../docs/adr/0056-let-the-run-store-own-run-exits.md) still applies.
Use the form and durability rules in [the run-exit spec](2026-11-03-run-store-owns-exits.md).

Eight groups cover all 59 fields. Queue and slot collections are not a ninth ActiveRun group:
`RunLine` already owns them. P5 can retire the handler-order expiry block after it closes the
remaining entry-path test gaps. The queue-head expiry block has a separate scope question below.
This draft does **not** claim the Phase 4 exit is met while that question stays open.

An ast-grep pattern cannot resolve arbitrary aliases or helper calls. Each group's syntax rule
therefore ships with a type-aware ownership check and deep read-only caller types. A pattern
that checks only names such as `state` would leave the acceptance condition unenforced.
No PR may substitute such a pattern, add exceptions, or add a baseline to hide outside writes.

## Evidence

The issue's 59-field count still holds. Its estimate of about 160 writes in 27 outside modules
does not. The TypeScript-syntax audit in Appendix A finds **209 mutation sites in 30 modules**:
**207 sites in 29 modules outside `active-run.ts`**. It also finds nine explicit factory property
initializers. Count those separately: 218 mutation/initialization sites in total. Omitted optional
properties start absent. They are not additional assignments. All 59 fields have a post-factory
write; **no field is construction-only** on this baseline.

The nine factory keys are `delegationSettings`, `revokeDelegation`, `cancelled`, `interrupt`,
`cwd`, `pendingHumanAsk`, `pendingPermissions`, `backgroundChildren`, and `autonomous`
(`active-run.ts:172–181`). The factory must keep their current initial values.

A site is one assignment operator, delete, increment/decrement, or Map/Set mutation call.
Count nested writes to input-flight and usage records too. Thus `(state.retiredInFlight ??=
new Set()).add(id)` is two sites. Chained statements on one line are separate sites.
There are no `Object.assign` writes to an ActiveRun receiver on this baseline. The candidate
scan and inspection found no delete or increment sites on these fields. Reads below include
read/write references; the table is a reader inventory, not a claim that each access is pure.

| Module | Mutation sites | Referenced fields |
| --- | ---: | --- |
| `delegation/execution-settings.ts` | 0 | `delegationSettings`, `session` |
| `workflows/active-run.ts` | 2 | `writingInput` |
| `workflows/completion-policy.ts` | 7 | `completionNudgeAnswered`, `completionNudged`, `doneRequested`, `incomingRequestRefused`, `sentRequestRefused`, `session` |
| `workflows/input-acknowledgement.ts` | 1 | `agentInputFlight`, `consumedBeforeAck`, `inputDelivery`, `retiredInFlight` |
| `workflows/run/cezar-tools.ts` | 4 | `cancelled`, `ciGeneration`, `ciTurnId`, `finishRequested`, `revokeCiTools`, `session` |
| `workflows/run/completion-gate.ts` | 0 | `finishRequested`, `incomingRequestRefused`, `pendingHumanAsk`, `session` |
| `workflows/run/compose.ts` | 2 | `pendingHumanAsk`, `unreadInputIds` |
| `workflows/run/continuation-session.ts` | 20 | `agentInputError`, `agentSessionError`, `cancelled`, `consumedBeforeAck`, `currentStepId`, `cwd`, `delegationSettings`, `inputDelivery`, `interrupt`, `nextStep`, `openingAgentInputId`, `openingAnswerAskSeq`, `pendingHumanAsk`, `revokeCiTools`, `revokeDelegation`, `session`, `sessionEverOpened`, `unreadInputIds` |
| `workflows/run/drop-active.ts` | 2 | `pendingPermissions`, `releaseRepoRoot`, `revokeCiTools` |
| `workflows/run/family-reconciler.ts` | 0 | `atTurnBoundary`, `cancelled`, `session` |
| `workflows/run/human-waits.ts` | 3 | `autonomousNudgePending`, `ciTurnId`, `currentStepId`, `pendingHumanAsk` |
| `workflows/run/inbox-claims.ts` | 0 | `agentInputFlight`, `openingAgentInputId`, `session` |
| `workflows/run/input-batch.ts` | 0 | `agentInputFlight`, `openingAgentInputId` |
| `workflows/run/input-delivery.ts` | 38 | `agentInputError`, `agentInputFlight`, `agentSessionError`, `atTurnBoundary`, `autonomous`, `autonomousNudgePending`, `cancelled`, `completionNudged`, `consumedBeforeAck`, `currentStepId`, `doneAtBoundary`, `doneRequested`, `finishRequested`, `heldHumanInputExpired`, `heldHumanInputSince`, `heldHumanInputTimer`, `idleClosed`, `monitoringCapNoted`, `noWaitNudgeParked`, `noWaitNudgeSawContent`, `noWaitNudged`, `openingAgentInputId`, `parkAfterAck`, `pendingHumanAsk`, `pendingPermissions`, `session`, `unreadInputIds`, `unreadInputTimer`, `unreadRetried`, `waitWakeTurn` |
| `workflows/run/input-receipts.ts` | 11 | `agentInputError`, `agentInputFlight`, `bundledInputIds`, `cancelled`, `consumedBeforeAck`, `inputDelivery`, `openingAgentInputId`, `retiredInFlight`, `session`, `unreadInputIds` |
| `workflows/run/input-timers.ts` | 7 | `autosaveTimer`, `heldHumanInputExpired`, `heldHumanInputSince`, `heldHumanInputTimer`, `idleTimer`, `noWaitNudgeReplyTimer`, `session`, `unreadInputIds`, `unreadInputTimer` |
| `workflows/run/launch-context.ts` | 3 | `cwd`, `revokeDelegation` |
| `workflows/run/launch-settings.ts` | 0 | `cwd` |
| `workflows/run/memory-guard.ts` | 1 | `autonomous`, `cancelled`, `session` |
| `workflows/run/opening.ts` | 1 | `openingAgentInputId` |
| `workflows/run/pending-ask-facts.ts` | 0 | `cancelled`, `openingAnswerAskSeq`, `session` |
| `workflows/run/queued-input.ts` | 0 | `agentInputError`, `cancelled`, `sessionEverOpened` |
| `workflows/run/repo-root-lease.ts` | 4 | `cancelled`, `interrupt`, `releaseRepoRoot` |
| `workflows/run/run-cancel.ts` | 3 | `cancelled`, `interrupt`, `revokeCiTools`, `revokeDelegation` |
| `workflows/run/run-finish.ts` | 2 | `atTurnBoundary`, `currentStepId`, `doneRequested`, `finishRequested`, `nextStep`, `pendingHumanAsk`, `session` |
| `workflows/run/run-guards.ts` | 0 | `cancelled`, `finishRequested` |
| `workflows/run/run-settlement.ts` | 1 | `agentInputError`, `autonomousNudgePending`, `cancelled`, `completedStepId`, `finishRequested`, `idleClosed` |
| `workflows/run/run-skills.ts` | 2 | `cancelled`, `cwd`, `liveSkillProvisioning`, `session`, `skills` |
| `workflows/run/session-events.ts` | 15 | `agentInputError`, `agentSessionError`, `atTurnBoundary`, `autonomousNudgePending`, `cancelled`, `ciTurnId`, `currentStepId`, `doneAtBoundary`, `parkAfterAck`, `pendingHumanAsk`, `pendingPermissions`, `revokeCiTools`, `revokeDelegation`, `session`, `waitWakeTurn`, `writingInput` |
| `workflows/run/step-loop.ts` | 6 | `cancelled`, `completedStepId`, `cwd`, `finishRequested`, `idleClosed`, `interrupt`, `releaseRepoRoot`, `sessionEverOpened` |
| `workflows/run/step-session.ts` | 27 | `agentInputError`, `agentSessionError`, `atTurnBoundary`, `cancelled`, `completedStepId`, `consumedBeforeAck`, `currentStepId`, `cwd`, `delegationSettings`, `doneAtBoundary`, `inputDelivery`, `interrupt`, `nextStep`, `parkAfterAck`, `revokeCiTools`, `revokeDelegation`, `session`, `sessionEverOpened`, `unreadInputIds`, `waitWakeTurn` |
| `workflows/run/subagent-waits.ts` | 2 | `backgroundChildren`, `ciTurnId`, `heldForSubagents`, `pendingPermissions`, `session` |
| `workflows/run/turn-nudges.ts` | 11 | `agentInputError`, `agentInputFlight`, `agentSessionError`, `autonomous`, `autonomousNudgePending`, `cancelled`, `completionNudged`, `currentStepId`, `finishRequested`, `nextStep`, `noWaitNudgeParked`, `noWaitNudgeReplyTimer`, `noWaitNudgeSawContent`, `noWaitNudged`, `pendingHumanAsk`, `session` |
| `workflows/run/turn-settler.ts` | 17 | `agentInputError`, `agentInputFlight`, `autonomous`, `autonomousNudgePending`, `cancelled`, `ciTurnId`, `completedStepId`, `completionNudgeAnswered`, `completionNudged`, `currentStepId`, `doneAtBoundary`, `doneClose`, `doneRequested`, `heldForSubagents`, `idleClosed`, `idleTimer`, `monitoringCapNoted`, `nextStep`, `noWaitNudgeSawContent`, `noWaitNudged`, `parkAfterAck`, `pendingHumanAsk`, `sentRequestRefused`, `session` |
| `workflows/run/usage-accounting.ts` | 6 | `reportedClaudeCost`, `usageInvocation` |
| `workflows/run/wait-registry.ts` | 5 | `atTurnBoundary`, `autonomous`, `cancelled`, `ciGeneration`, `ciTurnId`, `openingAnswerAskSeq`, `session` |
| `workflows/run/wake-admission.ts` | 1 | `agentInputFlight`, `atTurnBoundary`, `cancelled`, `currentStepId`, `delegationSettings`, `heldForSubagents`, `pendingHumanAsk`, `session` |
| `workflows/run/wake-ledger.ts` | 0 | `atTurnBoundary`, `pendingHumanAsk`, `session` |
| `workflows/run/worktree-autosave.ts` | 1 | `autosaveTimer`, `cwd` |
| `workflows/run.ts` | 4 | `cwd`, `pendingPermissions`, `releaseRepoRoot`, `revokeCiTools`, `revokeDelegation` |

The audit parses production `.ts` files under all of `packages/cezar/src`, excluding `.test.ts`
and `.testkit.ts`. It does not count tests as product writers. Its receiver seeds (`state`,
`active`, and `*.active.get(...)`) were checked against the 202 baseline member-target candidates
before optional calls and aliases were added. Excluded same-name receivers were mapper events,
preview entries, runner-owned permission state, composer config, and `modules.inputDelivery`.
The final count adds optional calls, nested typed aliases, and chained mutations. It is a
baseline census, not the future ownership guard. Tests and testkits must stop writing moved
fields directly in each owning PR; there is no test-only rule exclusion.

## Groups and readers

The group boundary follows a decision that reads fields together. Do not group by spelling.
All paths in the owner column are under `workflows/`. The owner writes its group's factory
initial state too; `createActiveRun` composes those factories. This gives each group exactly
one writer, including construction. It keeps one ActiveRun construction site.

| Group | Single writing module | Fields, each listed once |
| --- | --- | --- |
| session (14) | `run/live-session-state.ts` | `delegationSettings`, `revokeDelegation`, `revokeCiTools`, `ciGeneration`, `cancelled`, `finishRequested`, `interrupt`, `cwd`, `session`, `pendingPermissions`, `agentSessionError`, `currentStepId`, `sessionEverOpened`, `releaseRepoRoot` |
| boundary (23) | `run/turn-boundary.ts` | `waitWakeTurn`, `pendingHumanAsk`, `noWaitNudgeReplyTimer`, `noWaitNudgeSawContent`, `noWaitNudgeParked`, `doneAtBoundary`, `doneRequested`, `nextStep`, `completedStepId`, `doneClose`, `parkAfterAck`, `atTurnBoundary`, `idleTimer`, `idleClosed`, `monitoringCapNoted`, `autonomous`, `autonomousNudgePending`, `noWaitNudged`, `incomingRequestRefused`, `sentRequestRefused`, `completionNudged`, `completionNudgeAnswered`, `heldForSubagents` |
| input (15) | `run/input-delivery.ts` | `agentInputError`, `agentInputFlight`, `inputDelivery`, `unreadInputIds`, `consumedBeforeAck`, `bundledInputIds`, `retiredInFlight`, `unreadInputTimer`, `unreadRetried`, `heldHumanInputTimer`, `heldHumanInputSince`, `heldHumanInputExpired`, `openingAnswerAskSeq`, `openingAgentInputId`, `writingInput` |
| wait (1) | `run/wait-registry.ts` | `ciTurnId` |
| children (1) | `run/subagent-waits.ts` | `backgroundChildren` |
| usage (2) | `run/usage-accounting.ts` | `reportedClaudeCost`, `usageInvocation` |
| skills (2) | `run/run-skills.ts` | `skills`, `liveSkillProvisioning` |
| autosave (1) | `run/worktree-autosave.ts` | `autosaveTimer` |

- **Session:** launch, Continue, Stop and disposal read the current session, step, cancellation,
  capability revokers and execution lease together. Put these writes in a new small module.
  This is not the stored run lifecycle. Lease acquire/release and interrupt ordering stay where
  they are; commands only update the in-memory handles at their original points.
- **Boundary:** `TurnSettler`, `TurnNudges`, completion policy, human waits and wake admission
  jointly read question, done, nudge and park state to choose one carrier. Idle closure is part
  of the carrier's liveness bound. `autonomous` remains mutable: memory guard turns it off today.
- **Input:** receipts, ACK, readiness and held-human checks read flight, consumption and opening
  input together. `writingInput` belongs here because it identifies runner-started versus
  Cezar-started turns. Keep its synchronous try/finally restoration.
- **Wait:** registration and tool generation read the session's CI turn identity together.
  A boundary calls the owner to rotate it; it does not mutate the identity itself.
- **Children:** child UI events update one map; subagent-wait decisions read it. `heldForSubagents`
  belongs to boundary policy, which reads it with park/idle/slot state, not to map observation.
- **Usage:** invocation epoch, turn deduplication and cumulative Claude cost are read together
  before usage checkpoints. Their owner already exists.
- **Skills:** discovery and live installation share registry/provisioning state. Preserve the
  existing `enabledSkills` read seam and its live disabled-source filtering.
- **Autosave:** the autosave loop opens its interval; cleanup asks it to clear it at the same
  point as today. It is separate from the boundary's idle and reply bounds.

### Representation and commands

Migrate one group per PR. A migrated property is a named group (`state.boundary`, `state.input`,
etc.) with a deep read-only public view. Its backing writable type and storage stay private to
the owner. Use `ReadonlyMap`/`ReadonlySet` and read-only nested records, not `Readonly<T>` alone.
Do not freeze or copy live maps: readers must still see the same current values and iteration
order. Session objects remain usable AgentSession capabilities; do not make their runner internals
part of ActiveRun's ownership domain. Only assignment of the session handle belongs to session.

Owners expose narrow commands such as `attachSession`, `retireSession`, `recordConsumed`,
`acknowledgeFlight`, `rotateCiTurn`, and `clearAutosave`. They do not export mutable references,
setter callbacks, or `patch(Partial<...>)`. A helper may request an operation. Only the owner
performs its writes. Cross-group operations call the other owner at the original effect position.
Keep `RunManager` as the facade under ADR 0053. No durable schema, API payload, event or runner
protocol changes. Migrating flat internal field reads is part of the same group's PR.

## Guards with no baseline

Each row adds one ast-grep rule in `.ai/ast-grep/rules/` and matching valid/invalid cases in
`.ai/ast-grep/rule-tests/`. All scan production **and tests**, with no baseline file. The allowed
path is the owner alone. Factory code calls the owner's constructor; it is not an exception.

| Rule id | Group | Allowed path |
| --- | --- | --- |
| `active-run-session-write-outside-owner` | `session` | `packages/cezar/src/workflows/run/live-session-state.ts` |
| `active-run-boundary-write-outside-owner` | `boundary` | `packages/cezar/src/workflows/run/turn-boundary.ts` |
| `active-run-input-write-outside-owner` | `input` | `packages/cezar/src/workflows/run/input-delivery.ts` |
| `active-run-wait-write-outside-owner` | `wait` | `packages/cezar/src/workflows/run/wait-registry.ts` |
| `active-run-children-write-outside-owner` | `children` | `packages/cezar/src/workflows/run/subagent-waits.ts` |
| `active-run-usage-write-outside-owner` | `usage` | `packages/cezar/src/workflows/run/usage-accounting.ts` |
| `active-run-skills-write-outside-owner` | `skills` | `packages/cezar/src/workflows/run/run-skills.ts` |
| `active-run-autosave-write-outside-owner` | `autosave` | `packages/cezar/src/workflows/run/worktree-autosave.ts` |

Use this exact syntax-pattern family for each group G (replace `boundary` below with G).
`$FIELD` is constrained to that group's table, plus its group property for replacement writes.
The real YAML must include both member and subscript AST forms, including optional forms.
Do not restrict the receiver to a variable named `state`.

```yaml
# Sketch: match targets, then exclude only the exact owner file by files/ignores.
any:
  - pattern: $OBJ.boundary.$FIELD = $VALUE
  - pattern: $OBJ.boundary[$KEY] = $VALUE
  - pattern: delete $OBJ.boundary.$FIELD
  - pattern: $OBJ.boundary.$FIELD++
  - pattern: ++$OBJ.boundary.$FIELD
  - pattern: $OBJ.boundary.$FIELD.set($$$ARGS)
  - pattern: $OBJ.boundary.$FIELD.add($$$ARGS)
  - pattern: $OBJ.boundary.$FIELD.delete($$$ARGS)
  - pattern: $OBJ.boundary.$FIELD.clear()
  - pattern: Object.assign($OBJ.boundary, $$$ARGS)
```

Also match all augmented assignments (`??=`, `||=`, `&&=`, arithmetic and bitwise operators),
decrement, optional mutation calls, a whole-group replacement, destructuring assignment targets,
and nested member paths (for example `usageInvocation.startedTurns.add`). Use AST kinds
`assignment_expression`, `augmented_assignment_expression`, `update_expression`,
`unary_expression`, `call_expression`, `member_expression`, and `subscript_expression` to
avoid a separate pattern for each operator. Constant and nonconstant subscript keys must both
be checked. Do not silently drop dynamic writes.

**Alias and helper closure:** the YAML family alone cannot catch `const b = state.boundary;
b.doneRequested = ...`, `const { unreadInputIds: ids } = state.input; ids.add(id)`, or a helper
that takes that map. Its same-PR companion, `active-run-ownership` in the repository lint
runner, uses the TypeScript checker to resolve the target type's group identity, including
indexed access types, imported aliases and helper parameters. It classifies assignment,
update, delete, destructuring targets, collection calls and `Object.assign` targets before
checking the owning source path. Brand writable backing types by group; never export them.
The check also rejects a cast to a writable group or `any`/`unknown` escape from a group view,
a mutable-return helper, and a callback that exposes a backing object. Unsupported target
provenance is an error, not an ignored match. Legitimate read aliases stay valid.

Deep read-only types refuse the ordinary alias/helper writes at typecheck. The ownership lint
check detects attempts to strip those types. This is an added guard, not a new baseline or
allowlist. The eight YAML rules provide local, fast diagnostics; the semantic check provides
the promise they cannot make alone. P1 must prove the checker integration on one group before
any later group is migrated. If the planner requires ast-grep alone to provide arbitrary
cross-module data-flow checking, that requirement is not feasible with the present scanner.
Do not call a name-only rule equivalent.

Guard fixtures must include direct, renamed receiver, whole-object alias, destructured alias,
nested typed alias, imported mutating helper, callback, chained initialization/mutation,
optional call, bracket access, `Object.assign`, delete, increment, and forged mutable cast.
For each form, an outside write is invalid and the owner command is valid. Add negative cases
for unrelated objects with the same property name and read aliases. Compile invalid alias
fixtures as expected diagnostics; do not put failing TypeScript into production tests.

The PR that adds each rule moves **every** outside write for that group, updates every test
fixture, and proves zero matches without update mode. Record a red scan on the baseline or an
injected outside write, then a green scan on the changed head. Keep compiler diagnostics and
semantic-lint proofs separate from ast-grep fixture results.

## Turn-boundary transition

Add `workflows/run/turn-boundary.ts`. It is the only writer of the boundary group.
Its entry point is synchronous; it must not add a microtask, timer or await between old effects.

```ts
function transitionTurnBoundary(
  runId: string,
  state: ActiveRun,
  event: TurnBoundaryEvent,
  effects: TurnBoundaryEffects,
): TurnEndOutcome | undefined;
```

`TurnBoundaryEvent` is a discriminated union, not a generic field patch. It carries the
expected session generation and the entry's current payload. Entries are `session-open`,
`turn-started`, `turn-end`, `done-request`, `done-step-consumed`, `input-submitted`, `input-ack`,
`input-ready`, `input-error`, `held-input-expired`, `unread-expired`, `reply-content`,
`reply-expired`, `completion-refusal`, `human-wait-opened`, `wait-wake-admitted`,
`subagents-changed`, `mode-disabled`, `idle-expired`, and `session-retired`.
The current-state/session checks stay at their original positions. The function does not
invent a new early return for stale events that had side effects before the old check.

`TurnBoundaryEffects` is a typed set of existing operations: submit/flush input; clear/arm
bounds; read/reconcile durable waits; invoke completion gate; store move/flush; open/show human
alias; park/pool/release/wake; worker notice; note/heartbeat; close session. Each event selects
an explicit path. There is no public generic effect callback that can mutate boundary state.
`TurnSettler` retains its decision classifier initially; each carrier calls this entry point.
P5 moves remaining writes and locks all entry paths. Do not merge handlers merely to shrink code.

These are internal boundary conditions, not new stored statuses. They overlap: a retained done
may coexist with an ACK flight; a question may coexist with resolved waits. Keep session
identity and these facts. Do not replace the facts with an exclusive enum that loses overlap.

### Transitions out

The durable catalogue remains `workflows/run-states.ts` and `runs/run-exits.ts`. The table covers
all internal states moved by this slice and maps the relevant durable state where useful.

| State | Trigger | Who or what fires it | Behavior at shipped defaults |
| --- | --- | --- | --- |
| Active turn (`running`) | turn end, done tool, native ask, Stop, failure | runner callbacks, tool, human, runner result | Record boundary and classify; preserve question and done priority. No new turn timeout. Stop/failure use existing store exits. |
| Completed boundary | queued input, waits, done, no-wait | turn-end, ACK, ready or completion gate | Flush eligible input before settlement; finish step/task, park, or send first no-wait nudge. Second no-wait end opens human wait. |
| ACK deferred | transport ACK resolves/rejects; Stop/disposal | current flight promise or lifecycle | Commit acceptance before receipt/charge/wait effects. Recheck generation. Reject fails/requeues as today; never treat a late replaced-session ACK as current. |
| Held human input | hold clears, bound expires, real activity | held-input timer, runner event | Re-settle retained boundary without a new turn. Expiry preserves today's unconfirmed-read note; activity clears held timer. |
| Readiness deferred | ready signal, new parent activity, idle bound | runner readiness callback, UI callback, existing idle timer | Flush durable input first. Retry pending nudge only for same boundary. Activity invalidates it. Missing ready reaches existing idle close. Autonomy is off by default. |
| Nudge reply pending | parent content/turn, next no-wait end, reply bound | runner event or existing five-minute reply timer | Mark real parent content; next turn consumes refusal/no-wait latches. Bound opens human wait. Do not count child content as parent reply. |
| Human/permission park (`waiting`) | answer, permission result, Stop | human or runner permission result | Human-only by design. Keep answerable card and current slot exemption; do not invent automatic completion. |
| Durable-wait park (`waiting`) | resolved CI/timer/process/request/worker/peer wait, cancel, budget gate | wait watchers, message/family reconciler, human | Preserve admission, account/cap checks and budget 40. Monitoring retains its current pool/slot semantics; no new drain schedule. |
| Native-child-held park | last child settles, parent activity, quiet deadline, Stop | child UI event/wait reconciler, runner, existing deadline | Keep live session and slot while child runs. No idle-close timer. Preserve the existing 30-minute quiet deadline. |
| Closing boundary | next step, task close, Stop/result | accepted done or runner result | Mark completed step before summary/lifecycle/wait cancellation/session close. A non-final done advances only its completed step. |
| Retired session | replacement launch or no event | next workflow step, Continue/restart | Clear old handles at current teardown points. Late callbacks cannot restore old boundary or charge input. With no session, existing durable continuation paths still work. |

An ACK without a current flight and a boundary event for a session that never opened cannot
be produced by the normal callback wiring; test forged/stale callbacks too. A final durable
run has no automatic boundary exit; Continue creates a new session. The no-session Stop and
recovery paths must keep their durable outcome without constructing a fake active session.

### Handler side-effect order

All named existing tests in this table are in `workflows/run/turn-settler.test.ts` unless a
path is given. Abbreviated test titles below retain enough exact text for `rg -F` selection.
New titles are requirements, not claims of existing coverage. A dash means no effect in that
category; do not add it during extraction. Outcome includes the current heartbeat/note seam.

| Entry | Case | Ordered effects | Pin |
| --- | --- | --- | --- |
| turn-end | ordinary | consume done → reset no-wait/completion latches → save boundary → settle/park → outcome → clear resume attempts | `turn-end consumes done before resetting nudges, saves boundary before settlement, then clears resume attempts` |
| turn-end | human card | read wait → discard queued input → reset nudge → prepare ask → save boundary | `turn-end discards queued input for a human wait card before preparing it and storing its boundary` |
| turn-end | live children | register/check child wait → save boundary → decide/park; no extra monitoring timer | `turn-end hands live subagents to the subagent wait before the rule decides, and opens no timer beside it` |
| ready | normal | completion gate → clear pending nudge → carrier → outcome | `ready calls the gate before clearing the pending nudge and dispatching the carrier` |
| gate | supplied refusal | no second gate → refusal note → park → worker notice → outcome | `gate uses the supplied refusal without calling the gate again, and records only through the outcome seam` |
| ACK/ready/gate | held input | gate → pool check → park outcome; retain done and held-input state | `held %s preserves boundary and input timer before reporting park` |
| take-input | refused flush | refusal note → flush → withdraw human alias → commit timer → arm timer → reread facts → unread bound → park → outcome | `take-input notes refusal before flushing, opens monitoring after a refused flush, then reads new facts` |
| turn-end | ask checkpoint | flush input → unread bound → held-input bound → emit ask → record question → route worker question → park → outcome | `turn-end checkpoint arms unread then held timer before emitting, recording, and routing ask` |
| input checkpoint | failure | try input → unread bound → clear held state → stop; no ask/carrier/outcome | `input checkpoint failure stops before ask emission or a carrier` |
| done | task/non-final step | completed step → summary note → lifecycle → cancel waits → close; no settled outcome | `done marks the step before summary, lifecycle, wait cancellation, and session close, without an outcome`; parity U6s |
| park | wait exists/absent | try waits → user fallback only if absent → worker notice → pool report → outcome | `park tries waits before user fallback, worker notice and slot report (waits=%s)` |
| completion-human | refusal | withdraw old waits → refusal note → open/show alias → move/flush → release/wake → worker notice → outcome | `completion human wait notes refusal, opens and shows alias, then parks and notifies worker` |
| completion nudge | accepted | clear content latch → submit → reply bound → charge → note → outcome | `completion nudge resets content before submission and completes the true path in order` |
| completion nudge | rejected | clear latch → submit attempt → retain done → note → user park → notice → outcome | same parameterized test, false case |
| completion-wait | refusal | withdraw old human waits → refusal note → register wait → park → notice → outcome | `completion wait notes the refusal before registering, parking and reporting the outcome` |
| no-wait/budget | human | open/show alias → park/release/wake → notice → outcome | `%s human wait opens and shows its alias before parking and recording the outcome` |
| no-wait | nudge | send → outcome | `no-wait nudge sends before recording its outcome` |
| non-turn-end | already parked | no duplicate park, release or outcome | `already parked non-turn-end does not park, release, or report another outcome` |
| user park | ordinary | move → flush → line park → leave pool → idle bound → release → wake | `user park updates and flushes waiting before line, pool, idle bound, release and wake` |
| monitoring | enabled | withdraw human waits → commit timer → arm → reread decision facts → park → outcome | `withdraws human waits, commits timer, then arms it before reading decision facts` |
| monitoring | off/budget | cause note → human alias → park; no timer commit/arm | `%s fallback notes the cause before opening its human alias` |
| monitoring | commit fails | withdraw alias → attempt commit → reread facts → park; no timer arm | `failed timer checkpoint leaves it unarmed before carrying out the park` |
| UI turn completed (`session-events.ts:150–156`) | fresh/Continue | retire unread → consume bundled → clear wake-turn → set boundary → rotate CI identity | new `fresh and continued completion preserve receipt-before-boundary order` |
| UI activity (`session-events.ts:263–318`) | parent/child/native ask | persist usage/UI → child tracking → reply content → activity clears boundary → permission/ask or spontaneous resume | new `parent activity invalidates boundary after persisted UI and child tracking`; retain child-only negative case |
| ACK (`input-delivery.ts:376–434`) | success/reject/stale | current check → atomic outcome checkpoint → refund/charge/resume/receipt effects → clear flight → unread bound → flush input → late boundary settlement; reject follows existing fail path | new `ack effects follow commit before boundary settlement`; `input-receipt-boundaries.test.ts` for callback session lookup |
| ready (`input-delivery.ts:308–328`) | pending/absent boundary | current checks → flush durable input → retry autonomous boundary or settle ACK | `autonomous-nudge-guards.test.ts`: `refused ordinary input waits for readiness without charging the cap or releasing capacity`; add order-log assertion |
| unread/held timers (`input-delivery.ts:229–299`) | stale/current/never drains | validate captured session → retire/retry input or mark expiry → restore boundary → re-settle; preserve notes and bounds | `held-human-input-liveness.test.ts`: `re-settles a DONE boundary after holdsHumanInput flips false without a new turn`, `expires a hold that never drains and settles with an unconfirmed-read note`; add unread order row |
| tool done (`run-finish.ts:40–65`) | accepted/refused/stale | session check → root Finish gate → question gate → completion refusal → retain done request | new `done admission keeps gates before boundary request` plus U20/U22/R13/R17 |
| nudge (`turn-nudges.ts:129–216`) | send/refuse/content/expiry | latch update → submit → existing bound/charge/note, or retain readiness; reply content cancels bound before resume; expiry clears bound before park | `autonomous-nudge-guards.test.ts`: `text before the reply timer is armed means the nudge was answered`, `expiry opens the no-wait human wait and the run waits for the user`; new order log for refusal |
| launch/reset/close (`step-session.ts:105–125,265–317`, `continuation-session.ts:498–604,637–638`) | fresh/Continue/setup failure | preserve session/step/input setup order; attach session → next-step scope → ever-opened → interrupt; close after receipts/ACK; reset handles at current finally points | `input-receipt-boundaries.test.ts`; new `fresh and continued attach and retire keep boundary reset order` |
| human/child/wake/mode commands | human alias, child end, admitted wake, memory guard | keep caller's existing decision → boundary fact write → existing park/release/note order | new `boundary fact commands preserve human child wake and memory-guard order`; U3w/U9w/U15 |

P5 extends the existing call-log/Proxy tests for all new rows. A pure field-write assertion is
not enough: assert input delivery, timer registration, gate calls, durable writes and emitted
notes/heartbeat in order. For each moved site, name its table row in the migration ledger.
A site without a row blocks P5. Preserve synchronous return values and throw boundaries.

## Implementation PRs

Land P1–P5 **in order**, each into current `main` after the preceding PR merges. No stack or
integration branch. The phase prerequisite remains slice 3.3 accepted on main. These PRs are
not dispatched until the planner approves this spec and the coordinator assigns regions.
All region numbers below are baseline lines, not reservations for parallel edits.

Every PR runs its group rule fixtures, zero-match scan, semantic ownership cases, focused tests
below, root lint and typecheck. Every PR that touches wait/turn-end/failure/step settlement or a
parity fixture runs `npm run test:parity`. Unit results use Squeal where it validates; use the
repo parity command for its required gate. Every new guard/test gets recorded red/green proof.

| PR | Files and baseline regions; new files | Guard added | Focused and parity proof | Expiry block deleted |
| --- | --- | --- | --- | --- |
| P1: accounting and observation | `active-run.ts:12–14,119–140,172–181`; `run/usage-accounting.ts:13–27,33–47,105–153`; `run/subagent-waits.ts:63–96`; `run/run-skills.ts:38–76`; all usage/skills/children reader sites in evidence table; lint runner and rule fixtures | usage, children, skills rules; semantic ownership checker first | usage/accounting and skills tests; `team-skill-materialize.test.ts`; subagent wait tests; full `npm run test:parity` for shared fixtures. Prove alias/helper/cast checks before proceeding | None |
| P2: session ownership | `active-run.ts` session fields; `run.ts:260–276,400–408`; `run/step-session.ts:105–125,244–269,304–317`; `run/continuation-session.ts:331,431,498–521,583–604,637–638`; `run/step-loop.ts:143,220,278–306,504`; `run/run-cancel.ts:55–59`; `run/launch-context.ts:164–172`; `run/repo-root-lease.ts:38–59`; `run/drop-active.ts:6–10`; `run/session-events.ts:103–190,280–302`; new `run/live-session-state.ts` | session rule | fresh/Continue receipt boundaries, cancellation, root lease, no-session cancellation and run-exit tests; parity U6s/U9w/U22. Move only session-group writes in listed regions | None |
| P3: input ownership | `active-run.ts:24–61,131–133,144–149`; `workflows/input-acknowledgement.ts:23`; `run/input-delivery.ts:86–101,229–299,332–434`; `run/input-receipts.ts:26–139`; `run/input-timers.ts:1–14`; `run/opening.ts:29`; `run/compose.ts:265`; fresh/Continue input setup `:125`/`:521` | input rule | input receipt/ACK tests, input consumption, held-human liveness, queued input, input-ready tests; parity U3w/U9w/U15 and input-delivery cells for each runner | None |
| P4: wait identity and autosave | `run/wait-registry.ts:95,118,152,213,247`; `run/cezar-tools.ts:123`; `run/session-events.ts:155`; `run/input-timers.ts:45`; `run/worktree-autosave.ts:138`; ActiveRun factory/view; callers clearing autosave | wait, autosave rules | wait/tool-generation and autosave tests; parity wait registration/cancel/restart cells on each runner. Keep actual timer clear at current teardown position | None |
| P5: boundary owner | new `run/turn-boundary.ts`; `run/turn-settler.ts:54–497`; `run/turn-nudges.ts:44–216`; `workflows/completion-policy.ts:52–65`; `run/input-delivery.ts:179–180,253–254,355,519–522,605–615`; `run/input-timers.ts:30–37`; `run/session-events.ts:153–155,272–274,318`; `run/step-session.ts:112,266,310–314`; Continue next-step and pending-ask writes `:469,602`; `run/human-waits.ts:28–29,105`; `run/run-finish.ts:62`; `run/run-settlement.ts:131`; `run/step-loop.ts:391`; `run/wake-admission.ts:414`; `run/subagent-waits.ts:131`; `run/memory-guard.ts:56`; `run/compose.ts:266`; skill block at baseline `load-bearing-change/SKILL.md:65–71` | boundary rule, all entry-path order tests | full order table; `autonomous-nudge-guards.test.ts`, `held-human-input-liveness.test.ts`, `input-receipt-boundaries.test.ts`; parity U6s/U15/U20/U22/U22s/U3w/U9w/R13/R17 plus existing wait/done cells on every runner | Handler-order block and its marker, only after every row and zero outside writes pass |

Shared-file writes make these serial landing units even though groups are distinct. Allow one
implementation worker per PR by default. At most two workers may touch any hot file, and only
with assigned regions at least 40 lines apart. Closely spaced `step-session` and input regions
cannot run in parallel. P5 owns all of `turn-settler` and the relevant skill block; reserve that
whole interval. Recount and update line regions after each merge. Do not make a wide rename
while slice 4.2 or 4.3 has an assigned overlapping region.

## Behavior-neutral proof

No existing test's expected observable outcome changes. Each migration records old site,
command, order-table row and focused/parity cell in its PR body. The evidence table is the
starting inventory; every 209 site must either move or already be in its owner. Constructor
values and absent-optionals get separate checks for fresh, Continue and restart paths.

- Session/input proof covers stored status/step fields, receipt durability and rejection,
  current-generation checks, cancellation, messages and no-session recovery. Keep all ACK
  commit boundaries and try/finally restoration. Do not turn a synchronous failure into a
  rejected promise, or the reverse.
- Boundary proof covers the ordered effects above, exact event/note bytes and counts,
  heartbeat/outcome calls, human card contents, wait rows, pool membership and busy-slot counts.
  Run every listed parity cell for every runner in `RUNNER_IDS`; no runner-specific omission.
  U6s pins non-final done; U20/U22/U22s pin live/closed/unanswered completion refusals;
  R13/R17 pin sent/incoming request refusal cycles; U3w/U9w pin input/failure beside worker waits;
  U15 pins the automatic budget. Retain all other existing parity expectations.
- Usage proof pins checkpoint-before-launch/event order, invocation epoch, deduplication,
  cumulative Claude deltas and crash recovery. No changed token/cost totals or durability.
- Skills proof pins live off-list reads, selected skill bodies and materialization, including
  removal/deselection between steps and during an open session. No snapshot or rediscovery added.
- Timing proof uses the existing fake-clock/release-gate fixtures. Assert the same timers,
  delays and armed/cleared order before each synchronous call returns. Preserve the existing
  reply, held-input, idle and child-quiet bounds. Record host load and CPU count for wall-time
  evidence. Do not add sleeps, retries or longer timeouts.

A guard proof injects an outside write in a disposable worktree and requires the intended rule
or semantic diagnostic. An order regression swaps/removes one effect and must fail its named
order test, then pass restored. Existing behavior tests may stay green before and after; label
them behavior guards, not regression proof. Follow `docs/sdlc/regression-proof.md`.
No full local suite is required for this docs-only design PR.

## Phase exit and expiry blocks

### Handler-order block

Protection today: merging handlers can omit or reorder input, waits, gates or notes.
Replacement: one boundary writer and one transition entry point, plus an entry/case order
ledger locked by the call-log tests above. Outside entry paths cannot mutate boundary facts.
P5 deletes **both** `List each handler's side effects, in order...` and its
`<!-- until: hearsay-tools/cezarion#2520 -->` marker in the same PR that moves the last write.
The new ACK/UI/timer/launch rows are required. Current `turn-settler.test.ts` alone is insufficient.
A swapped checkpoint/timer/ask operation must fail its order test; a restored outside write must
fail the owner guard. If any path lacks that proof, keep the block and report P5 incomplete.

### Queue-head block: candidate tested, scope decision needed

Protection today: a queued run must use values at the same points as before a queue-boundary
change. An ActiveRun write rule cannot protect this read contract.

The coordinator proposed (a) ID-only entries and (b) one named launch function that reads every
mutable launch setting/catalog/account/runner/model from store/live sources, with an outside-read
rule. Source-level checks against the baseline give this result:

| Candidate | Evidence | Result |
| --- | --- | --- |
| (a) queue entries are run IDs | `run/run-line.ts:54` is `string[]`; `enqueueJob` at `:375` takes an ID, but retains `{ workflow, input, startAt }` in `pendingJobs`; continuations have their own payload map | Entry identity holds. ID-only queue type alone does not prohibit an enqueue-time settings snapshot in a side map. Add a negative type/guard fixture for non-ID entries if this candidate proceeds. |
| (b) one launch read from current sources | `run/run-start.ts:164–191` launches `job.workflow` and hydrated `job.input`; `run/queued-input.ts:68–92` refreshes task/attachments but spreads original input; `run/step-loop.ts:64–81` reads config, then chooses `input.runner`, `input.systemPrompt`, `input.model` | Does not hold. Some authored inputs are deliberately pinned. A stored workflow definition also preserves ad-hoc workflows across restart (`run-start.ts:96–99`). |
| account/model read phase | `run/step-session.ts:92–97` resolves step model/profile after task launch; `run/launch-settings.ts:43–48,115–130` distinguishes authored/pinned model from live provider lookup | Task launch and each step are different read boundaries. One eager snapshot moves live reads earlier. |
| catalog removal/deselection | `run/run-skills.ts:38–59` discovers on start/Continue but filters disabled skills/sources on each prompt; `step-session.ts:160,179` reads enabled skills again | One launch snapshot would change a later step and live `/name` after deselection. |

This is a source test of the candidate, not a runtime experiment and not a claim of a failing
product test. Existing `team-skill-materialize.test.ts` cases `a later step does not run a skill
switched off while an earlier step ran`, `a live /name of a team skill switched off during the
run is not expanded`, and `a companion switched off after the run started is not installed on
Continue` pin why those later reads cannot move into an eager task-launch snapshot.
`agent-profile-wiring.test.ts` also pins that a recorded step profile wins over changed defaults.

A shared resolver module could preserve these distinct phases by exposing task-head, step-open,
Continue and live-input operations. It must keep pinned inputs distinct from live values and
must not cache later reads at enqueue or head. That is a broader read-ownership design, not
proof that one launch-time snapshot works. No implementation PR in P1–P5 deletes this block.
The coordinator must route this gap to the planner: approve that behavior-neutral multi-phase
resolver/guard as added scope, or keep the block and revise the phase exit. This design does
not authorize a behavior change or claim a weaker guard replaces the rule.

If extra scope is approved, its separately reviewed PR must list every source/read phase,
centralize the reads without moving their call points, refuse off-owner reads, and add held-head
fixtures that edit/remove/deselect each mutable source before releasing the head. Red proof
must replace a late read with the enqueue snapshot and fail the intended assertion. Only that
PR may delete `Preserve queue-head reads when changing queue boundaries...` and its marker.
A PR number and complete read inventory are not available yet; this remains an explicit exit
blocker for planner review, not a promised follow-up that counts as completion.

## Interactions

- **Slice 4.2, hearsay-tools/cezarion#2521:** `RunLine` continues to own queue, starting,
  waiting, monitoring and wake admission. This spec needs its caller/case table and baseline
  timer-before-return evidence before P5 lands. It must avoid changing the point where an
  ownership command releases a slot, pumping reentrancy or an existing timer set. 4.1 does
  not adopt `pumpDue`, defer a drain, or move a release call. Reserve overlapping compose,
  settler and input regions through the coordinator.
- **Slice 4.3, hearsay-tools/cezarion#2522:** tests often read
  `runInternals(m).active.get(id)` fields. Search all old field names, new group paths and
  `runInternals(` before each group moves. 4.3 should assert store/events or a narrow public
  signal. It must not expose a mutable group view to preserve old tests. 4.1 updates any
  remaining internal read assertions in its own PR; it adds no new `runInternals` calls.
  Coordinate each file so one worker owns fixture changes. Tests that intentionally pin
  internal command order use the owner's test seam and observe effects, not mutable handles.
- **Run-exit spec / S4b:** current main already has `runs/run-exits.ts` and
  `RunStore.move(id, exit, extras)`. Do not reintroduce `RunManager.move` status patches,
  `transitionVia` or ActiveRun status fields from the older issue text. Any remaining S4b
  fixture work must keep the new single-writer types and factory construction. Ask the
  coordinator for ownership of shared fixtures before editing; recheck current main first.
- **Planner:** design approval is required before implementation dispatch. The spec PR is
  docs-only and references, rather than closes, hearsay-tools/cezarion#2520. The coordinator
  sends it to task `0b8679f4` and owns merge authority.

## Open risks and decisions

1. The queue-head candidate does not satisfy its one-launch-read condition. The phase exit
   remains blocked until the planner resolves the scope above. Neither expiry block is
   deleted by this design PR.
2. Arbitrary alias/helper enforcement requires a semantic companion. Prototype its diagnostics
   and read-only return boundary in P1. The pinned TypeScript 7 compiler is native; do not assume
   its npm package exports the older JavaScript checker API. Check tool feasibility before
   dispatch. Any added compiler-library dependency needs package-area review and planner approval. A clean syntax scan alone cannot satisfy acceptance.
3. P5 moves many small writes across interleaved handlers. The event union and order tests
   must preserve overlaps and caller reentrancy. An over-broad transition command would hide
   policy instead of owning it; review each command against its ledger rows.
4. The census is exact for its audited baseline forms, not a general TypeScript data-flow
   engine. Re-run it and review new receiver/cast/helper forms on each implementation base.
   Do not use an unreviewed census as the ownership guard.
5. Shared test fixtures may drift during S4b and 4.3. Counts and regions are evidence at the
   stated SHA, not an instruction to overwrite concurrent work.
6. No config, public format or default changes are permitted. If a proposed extraction needs
   one, stop and report the concrete behavior difference to the coordinator.

## Appendix A: repeat the baseline census

Tool: `@babel/parser` with its TypeScript plugin, plus an AST walker. It parses TypeScript
nodes; `rg` is only a cross-check. Save the following fenced script as `/tmp/count-active.cjs`.
Run it from this repository so its installed parser resolves. `git archive` reads the exact
baseline without switching this worker's branch:

```sh
mkdir -p /tmp/active-run-2520-main
git archive 172032e46e4475add22af4d11b20143a1f73ac3e packages/cezar/src | tar -x -C /tmp/active-run-2520-main
node /tmp/count-active.cjs /tmp/active-run-2520-main > /tmp/active-audit.json
node -e 'const a=require("/tmp/active-audit.json"); console.log(a.fields.length); for(const r of a.results) console.log(r.file,r.writes.length); console.log(a.results.reduce((n,r)=>n+r.writes.length,0))'
```

The expected final lines/counts are the evidence table above: 59 fields, 209 mutation sites.
The script returns per-site file, line, field and source text, and referenced fields by module.
`objectAssign` is a candidate list for manual target inspection; it is empty on this baseline.
The nine top-level factory keys are counted directly from the factory literal as stated above.
This script recognizes baseline typed-field aliases and field-derived local aliases; it is
not a complete arbitrary helper data-flow analysis. Inspect all candidate receiver names and
helper parameter types when extending it. All current typed aliases (`flight`, `invocation`)
are included. Construction of their fresh local literal is counted at the parent-field write;
subsequent typed nested mutations are also counted, even before attachment.

```js
const {parse}=require(process.cwd()+'/node_modules/@babel/parser');
const fs=require('fs'),path=require('path');
const root=process.argv[2]+'/packages/cezar/src';
const member=n=>n&&['MemberExpression','OptionalMemberExpression'].includes(n.type);
const key=n=>n.computed?n.property.value:n.property.name;
const unwrap=n=>['TSAsExpression','TSNonNullExpression','TSTypeAssertion'].includes(n?.type)?unwrap(n.expression):n;
function walk(n,fn){if(!n||typeof n!=='object')return;if(n.type)fn(n);for(const [k,v] of Object.entries(n)){if(['loc','start','end'].includes(k))continue;if(Array.isArray(v))v.forEach(x=>walk(x,fn));else if(v&&typeof v==='object')walk(v,fn);}}
function tree(f){return parse(fs.readFileSync(f,'utf8'),{sourceType:'module',plugins:['typescript']});}
let fields=[];walk(tree(root+'/workflows/active-run.ts'),n=>{if(n.type==='TSInterfaceDeclaration'&&n.id.name==='ActiveRun')fields=n.body.body.map(x=>x.key.name)});
let results=[];function visit(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())visit(f);else if(f.endsWith('.ts')&&!/\.(test|testkit)\.ts$/.test(f)){const t=tree(f),src=fs.readFileSync(f,'utf8');
// Baseline receiver names are audited below. Track field aliases to a fixed point.
const aliases=new Map([['state',[]],['active',[]]]);
walk(t,n=>{if(n.type==='TSIndexedAccessType'&&n.objectType.type==='TSTypeReference'&&n.objectType.typeName.name==='ActiveRun'&&n.indexType.type==='TSLiteralType'){ /* handled through annotated identifiers below */ }
if(n.type==='Identifier'&&n.typeAnnotation){let names=[];walk(n.typeAnnotation,q=>{if(q.type==='TSIndexedAccessType'&&q.objectType.type==='TSTypeReference'&&q.objectType.typeName.name==='ActiveRun'&&q.indexType.type==='TSLiteralType')names.push(q.indexType.literal.value);});if(names.length===1&&fields.includes(names[0]))aliases.set(n.name,[names[0]]);}});
function fieldPath(n){n=unwrap(n);if(n?.type==='AssignmentExpression')return fieldPath(n.left);if(n?.type==='Identifier')return aliases.get(n.name);if(n?.type==='CallExpression'&&member(n.callee)&&key(n.callee)==='get'&&member(n.callee.object)&&key(n.callee.object)==='active')return [];if(member(n)){let p=fieldPath(n.object);if(p)return [...p,key(n)];}return undefined;}
let changed=true;while(changed){changed=false;walk(t,n=>{if(n.type==='VariableDeclarator'&&n.init){const p=fieldPath(n.init);if(p&&p.length&&fields.includes(p[0])){if(n.id.type==='Identifier'&&!aliases.has(n.id.name)){aliases.set(n.id.name,p);changed=true;}if(n.id.type==='ObjectPattern')for(const q of n.id.properties)if(q.type==='ObjectProperty'&&q.value.type==='Identifier'&&!aliases.has(q.value.name)){aliases.set(q.value.name,[...p,q.key.name??q.key.value]);changed=true;}}}});}
let writes=[],refs=new Set(),assigns=[];
walk(t,n=>{if(member(n)){const p=fieldPath(n);if(p?.length&&fields.includes(p[0]))refs.add(p[0]);}
let target;if(n.type==='AssignmentExpression')target=n.left;if(n.type==='UpdateExpression'||n.type==='UnaryExpression'&&n.operator==='delete')target=n.argument;
if(['CallExpression','OptionalCallExpression'].includes(n.type)&&member(n.callee)&&['set','add','delete','clear'].includes(key(n.callee)))target=n.callee.object;
if(['CallExpression','OptionalCallExpression'].includes(n.type)&&member(n.callee)&&n.callee.object.name==='Object'&&key(n.callee)==='assign'){const p=fieldPath(n.arguments[0]);if(p)assigns.push(n.loc.start.line);}
const p=fieldPath(target);if(p?.length&&fields.includes(p[0]))writes.push({line:n.loc.start.line,field:p[0],code:src.slice(n.start,n.end).split('\n')[0]});
});if(refs.size||writes.length||assigns.length)results.push({file:f.slice(root.length+1),writes,readFields:[...refs].sort(),objectAssign:assigns});
}}}visit(root);console.log(JSON.stringify({fields,results},null,2));
```
