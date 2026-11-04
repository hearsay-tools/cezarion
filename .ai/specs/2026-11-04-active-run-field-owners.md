# Group ActiveRun fields by owner

Status: design draft for coordinator and planner review. No product change is authorized by this document.
Subject: hearsay-tools/cezarion#2520, slice 4.1 of hearsay-tools/cezarion#2487.
Baseline: `origin/main` at `172032e46e4475add22af4d11b20143a1f73ac3e`, fetched 2026-11-04.
All source paths below start at `packages/cezar/src/`, unless stated otherwise.
Line regions refer only to this SHA. PR labels P1–P6 below name future implementation PRs, not existing pull requests.

## Decision and limits

Give each field one module that writes it. Readers get a deep read-only view. Commands name an
operation, not an arbitrary patch. Keep each command at the old write's position in its handler.
Put all turn-boundary writes behind `transitionTurnBoundary`. Keep stored statuses under
`RunStore.move`; [ADR 0056](../../docs/adr/0056-let-the-run-store-own-run-exits.md) still applies.
Use the form and durability rules in [the run-exit spec](2026-11-03-run-store-owns-exits.md).

Eight groups cover all 59 fields. Queue and slot collections are not a ninth ActiveRun group:
`RunLine` already owns them. P5 retires the handler-order expiry block. P6 retires the queue-head
expiry block through read ownership at the existing read phases. The planner approved P6
on 2026-11-04 (decision `2ed14ca2`, routed by the coordinator). Both require their guards and proofs.

Use ES `#private` fields in one class per owner module. Getters expose read-only values;
methods perform the owner operations. Aliases and helpers do not acquire a writable reference.
The ast-grep rules guard escape forms and public mutable fields. No new semantic lint tool
is part of the primary design. P1 must prove the representation and guards before it expands.

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
The issue's queue/slot group is `RunLine` state, not ActiveRun state, so it is outside these
ActiveRun rules; slice 4.2 (hearsay-tools/cezarion#2521) covers slot release.
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

Migrate one group per PR. Each group is a class defined in its owner module. Its writable
state lives in ES `#private` fields. `ActiveRun` holds each group in a readonly property.
Only its owner module implements the class's commands. Do not export writable backing records.
P5 removes the last flat field and makes `createActiveRun` return `Object.freeze(container)`.
Freeze the ActiveRun group-slot container. Each owner class and each nested class also calls
`Object.freeze(this)` at the end of its constructor, after all public getters/methods and
private state are initialized. Freezing an instance prevents own-property additions and getter
shadowing; its ES private fields remain writable through owner commands. Freeze live read-view
facade instances too. Never freeze a backing Map/Set or an AgentSession. Before P5, each migrated group's rule rejects
whole-container target writes through Object.assign, Object.defineProperty, bracket replacement
and spread-into-target assignment, including ActiveRun aliases. Add an invalid fixture for
`Object.assign(state, { usage: other.usage })` and a valid constructor composition. At P5,
prove at runtime that whole-slot replacement cannot change the frozen container.

Replace all Object.assign/createActiveRun and spread replacement fixtures before that freeze;
P1 starts this migration and each later PR updates its own remaining fixture uses. Also replace
`ci-wait-registration.test.ts:69` restoring state with Object.assign. Use explicit owner commands
or a fresh factory object; do not unfreeze a fixture. The baseline AST write census found only
the 59 declared field targets. A grep for bracket writes, delete, Object.assign and
Object.defineProperty found no production code adding an undeclared ActiveRun property after
construction. P5 repeats both checks on its starting main, including alias receivers. Freezing
thus removes no declared product write path; constructor values, keys and slot identity stay
the same. Do not freeze earlier while flat fields still have legitimate writers.

Getters preserve the current values and live collection order. They do not copy a map/set
on each access or snapshot it at a new time. Their types use `ReadonlyMap`/`ReadonlySet` and
read-only nested records. AgentSession is still a runner capability, not owned runner internals.
A session getter returns that same session object; comparisons keep their identity meaning.
P1 proves that frozen group/nested/view instances still accept owner updates to private state
and expose those updates through the same live views. It also proves an aliased getter cannot
be shadowed with defineProperties or Reflect.defineProperty, even without a cast.

Owners expose `attachSession`, `retireSession`, `recordConsumed`, `acknowledgeFlight`,
`rotateCiTurn`, and `clearAutosave`. Commands name an operation, not a generic patch. Cross-group
operations call the other owner at the old effect position. No setter callback exposes backing
state. Keep `RunManager` as the facade under ADR 0053. No durable schema, API or protocol changes.

### Nested values and identity

A getter must not return a plain mutable record owned by the group. A read-only TypeScript type
alone does not stop `Object.assign`: a local pinned-compiler probe accepted both
`Object.assign(group.invocation, { observed: true })` and the same call through a local alias.
The representation closes that hole before the syntax guard runs.

| Field or nested value | Form | Baseline reference/write evidence and preservation requirement |
| --- | --- | --- |
| `agentInputFlight` | Small `InputFlight` class in the input owner, with private session/IDs/settled/reservation fields and read getters | `input-delivery.ts:341–434` captures `flight` across the ACK promise, compares `state.agentInputFlight === flight`, and changes `wakeReserved`/`settled` in place. Keep one flight object and those identity checks. The owner changes its private fields at the same points, including pre-attachment reservation. `input-receipts.ts:202` still reads its live settled promise. No frozen replacement per mutation. |
| `usageInvocation` | Small `UsageInvocation` class in the usage owner, with private observed flag and deduplication sets | `usage-accounting.ts:106–153` holds an invocation alias and passes it to `recordCompletedTurnUsage`. Keep one object per epoch and live set membership. Mutations stay in the usage module. |
| `parkAfterAck` | Frozen owner-created record, replaced as a whole | `turn-settler.ts:113` and `input-delivery.ts:254` assign new values; readers compare its session, not object identity. No member mutation exists in the census. Preserve the same record until its existing replacement/clear point. Freeze this container, never its AgentSession. |
| `doneRequested` | Frozen owner-created record, replaced as a whole | `run-finish.ts:62`, `completion-policy.ts:54`, `turn-settler.ts:59–67` set/read/clear it. Keep session identity and summary; there is no member mutation or across-await member update. |
| `nextStep` | Frozen owner-created record, replaced as a whole | `step-session.ts:266,310`, `continuation-session.ts:602`, `turn-nudges.ts:130` scope it to the same session and label. Keep that session, label and clear point. |
| `doneClose` | Frozen owner-created record, replaced as a whole | `turn-settler.ts:67–78` creates/reads it; no member mutation. Freeze only its scalar value container. |
| `delegationSettings` | Owned immutable cloneable value record; nested owned option arrays/account-binding data are immutable values | `step-session.ts:105`, `continuation-session.ts:331` replace the whole record. `delegation/execution-settings.ts:18` clones that value, not ActiveRun. The getter must return the same plain structured-cloneable value, not the group class. Freeze only owner-created value containers; do not freeze shared account/catalog objects. If an input container is shared, construct the owner value once on assignment, not on each read; prove no reader compares that container's identity. |
| `backgroundChildren` map values | Frozen owner-created `{ session, status }` records replaced by `set` | `subagent-waits.ts:90–93` reads the old entry and writes a new record. Preserve the entry's session identity and status; do not freeze session internals. |
| Maps/sets in usage, input and session groups | Stable live read-only collection views of private collections | No content copy. Getters expose only read operations; the view observes owner mutations immediately and keeps stable identity. If returning the native collection leaves an unguarded mutation path, use a stable read-only facade backed by the same private collection, never a snapshot. P1 proves this and all mutating escape fixtures before later groups move. |
| `skills` array and Skill records | Stable read-only catalog view; catalog discovery/replacement stays in `RunSkills` | Do not freeze shared catalog entries or change `enabledSkills` filtering time. A view must not expose a mutable nested Skill record; use read getters backed by the same entry where the catalog shares objects. Prove body/files/source reads stay the same. |
| `bundledInputIds`, flight `inputIds` | Owner-created immutable ID sequence | Bundled IDs are replaced/cleared (`input-receipts.ts:96,121,139`); flight IDs are read throughout ACK. Do not mutate a caller-owned array. Keep stable identity throughout one flight; no read-time copies. |

The classes for mutable nested records do not expose public mutation methods to readers. Their
owner has the write capability; readers see a getter-only interface. Frozen replacement values
are made once at their existing assignment points. This adds no new read phase, timer or await.
A stable collection facade is a live view of the same backing object, not a copied collection.
Test equality and iteration explicitly before choosing the native view or facade in P1.

### Copy and fixture sweep

Searches over `packages/cezar/src` found no production clone/serialization of ActiveRun itself.
`structuredClone(state.delegationSettings)` at `delegation/execution-settings.ts:18` clones one
plain value. It stays cloneable through the session getter; retain the clone-is-independent test.
Do not pass a group instance to `structuredClone` (private state would not survive).

Tests do spread or copy ActiveRun: `autonomous-nudge-guards.test.ts:131`,
`ci-wait-registration.test.ts:33,54`, and `delegation/input.test.ts:117,174`
(`Object.assign(createActiveRun(...), state)`). Replace these fixtures with a new factory-built
ActiveRun and explicit owner commands. A state replacement must use new group instances, so
old callbacks still fail the old-state identity check. A spread of a group would lose its
private state; never preserve a fixture by casting that spread. Other `...state` matches in
conversation, mapper, voice and automation code refer to other types and stay unchanged.
Repeat the sweep on each starting main; search aliases and all ActiveRun construction sites too.

`cwd` changes at `step-loop.ts:143`; `autonomous` changes at `memory-guard.ts:56`. Neither is
construction-only. `interrupt` swaps at `repo-root-lease.ts:45–55`: preserve installation before
park/release and restoration inside the existing finally, before unpark. `writeInput` likewise
restores `writingInput` in its current synchronous finally. Add explicit order tests for both.

## Guards with no baseline

Each row adds one ast-grep rule and valid/invalid fixtures. Rules scan production and tests.
No baseline file or suppression is allowed. The writing module contains the owner class and
all its command implementations, including initial values. `createActiveRun` calls constructors.

| Rule id | Owner class module (under `workflows/`) |
| --- | --- |
| `active-run-session-write-outside-owner` | `run/live-session-state.ts` |
| `active-run-boundary-write-outside-owner` | `run/turn-boundary.ts` |
| `active-run-input-write-outside-owner` | `run/input-delivery.ts` |
| `active-run-wait-write-outside-owner` | `run/wait-registry.ts` |
| `active-run-children-write-outside-owner` | `run/subagent-waits.ts` |
| `active-run-usage-write-outside-owner` | `run/usage-accounting.ts` |
| `active-run-skills-write-outside-owner` | `run/run-skills.ts` |
| `active-run-autosave-write-outside-owner` | `run/worktree-autosave.ts` |

ES private fields make `s.#value`, `s['#value']`, a renamed receiver, destructuring, or a helper
parameter unable to reach the backing state. Getter-only interfaces refuse direct assignments,
delete, updates, augmented assignments and collection mutation calls. A helper must accept a
read view or call an owner operation. It cannot accept a writable backing type that is not exported.
Runtime frozen getter-only group/nested/view instances and frozen value records also stop
aliased Object.assign or property-definition/prototype operations from
changing an owned record. Do not claim the compiler alone rejects Object.assign.

The syntax rule guards the remaining escapes. This is the exact pattern family to instantiate
for each group's class/view/getter names; G denotes that group's names, not a receiver spelling:

```yaml
any:
  # Cast syntax, including imported view aliases and a getter as the operand.
  - pattern: $VIEW as Map<$$$T>
  - pattern: $VIEW as Set<$$$T>
  - pattern: $VIEW as any
  - pattern: $VIEW as unknown
  - pattern: $VIEW as unknown as $TYPE
  - kind: type_assertion  # <Map<...>>view and other angle assertions
  # Target-copy escapes. Include direct getter, bracket getter, and local alias cases.
  - pattern: Object.assign($VIEW, $$$ARGS)
  - pattern: Object.defineProperty($VIEW, $$$ARGS)
  - pattern: Object.defineProperties($VIEW, $$$ARGS)
  - pattern: Reflect.defineProperty($VIEW, $$$ARGS)
  - pattern: Reflect.set($VIEW, $$$ARGS)
  - pattern: Object.setPrototypeOf($VIEW, $$$ARGS)
  - pattern: Reflect.setPrototypeOf($VIEW, $$$ARGS)
  # Public class fields: only #private state and get accessors are valid storage.
  - kind: public_field_definition
```

Constrain cast and target-copy matches with AST relations to a group view/getter or a bound
local alias, including a destructuring binding. Include imported type aliases and typed helper
parameters in rule fixtures. Public-field matches are constrained to the owner class, even
inside its module; readonly public storage that contains a mutable record is invalid too.
Match computed getter access and all type assertions, not only `as Map`. Also reject an
Object.assign source spread used to copy a writable target/view. Plain `{ ...view }` as a detached
read snapshot is not itself a state mutation, but it must never be cast back into a group.

The patterns are a second line of defense. They do not perform arbitrary interprocedural
analysis. The private/frozen/getter-only representation must prevent mutation even if a
renamed aliased record escapes a syntax match. A rule must not be presented as catching
arbitrary data flow. If P1 cannot meet this boundary with live views and no behavior change,
stop before moving another group and report the exact counterexample to the coordinator.
A TypeScript-checker companion is fallback scope only. It requires a new planner decision,
package-area review, a feasible library API (the pinned TS7 compiler is native), and cost evidence.
It is not authorized by this spec and is not a dependency of P1–P6.

P1 prototypes this on the usage group first. Compile direct/alias/destructuring/helper/bracket
mutation fixtures as expected errors. Exercise runtime attempts against nested getters and
frozen values to prove no owner state changes. Test `as Map`, `as Set`, `as any`, double casts,
angle assertions, getter aliases, helper parameters, Object.assign, Object.defineProperties,
Reflect.defineProperty, Reflect.set, Object/Reflect.setPrototypeOf, spread-into-target, and a
new public mutable field in the group's rule cases. Use unrelated objects and plain read aliases
as valid cases. A test-only injected cast write must make the usage rule fail; remove it and
require the zero-match scan. No new compiler-library dependency is needed.

Every later group's PR moves all its outside writes, updates all fixture copies/readers and
adds its guard in the same commit series. It must pass with no baseline. P1 replaces the
Appendix A census with enforced owner boundaries; the census remains historical evidence,
not a committed developer tool. This design PR commits only this Markdown file.

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
| ACK (`input-delivery.ts:376–434`) | success/reject/stale | current check → analyseAcknowledgedInput (including retiredInFlight.delete before checkpoint) → atomic outcome checkpoint → refund/charge/resume/receipt effects → clear flight → unread bound → flush input → late boundary settlement; reject follows existing fail path | new `ack analysis retires markers before commit and effects follow commit before boundary settlement`; `input-receipt-boundaries.test.ts` for callback session lookup |
| ready (`input-delivery.ts:308–328`) | pending/absent boundary | current checks → flush durable input → retry autonomous boundary or settle ACK | `autonomous-nudge-guards.test.ts`: `refused ordinary input waits for readiness without charging the cap or releasing capacity`; add order-log assertion |
| unread/held timers (`input-delivery.ts:229–299`) | stale/current/never drains | validate captured session → retire/retry input or mark expiry → restore boundary → re-settle; preserve notes and bounds | `held-human-input-liveness.test.ts`: `re-settles a DONE boundary after holdsHumanInput flips false without a new turn`, `expires a hold that never drains and settles with an unconfirmed-read note`; add unread order row |
| tool done (`run-finish.ts:40–65`) | accepted/refused/stale | session check → root Finish gate → question gate → completion refusal → retain done request | new `done admission keeps gates before boundary request` plus U20/U22/R13/R17 |
| nudge (`turn-nudges.ts:129–216`) | send/refuse/content/expiry | latch update → submit → existing bound/charge/note, or retain readiness; reply content cancels bound before resume; expiry clears bound before park | `autonomous-nudge-guards.test.ts`: `text before the reply timer is armed means the nudge was answered`, `expiry opens the no-wait human wait and the run waits for the user`; new order log for refusal |
| launch/reset/close (`step-session.ts:105–125,265–317`, `continuation-session.ts:498–604,637–638`) | fresh/Continue/setup failure | preserve session/step/input setup order; attach session → next-step scope → ever-opened → interrupt; close after receipts/ACK; reset handles at current finally points | `input-receipt-boundaries.test.ts`; new `fresh and continued attach and retire keep boundary reset order` |
| native ask (`session-events.ts:326–337`) | worker with parent on expired usage hold | create/show native ask and park worker → releaseSlot → first participant synchronously reconciles auto-resumes (parent hold withdraws to failed) → routeWorkerQuestion reads parent status → close worker ask as parent-stopped; no routed request/input | new `native ask routes only after synchronous release withdraws expired parent hold`; preserve 4.2 decisive-boundary outcomes below |
| slot release | valid future hold / due-now hold / 25-hour-missed hold, no live session | release → synchronous first-participant reconciliation → arm future/zero-delay timer or withdraw missed hold → return before any callback microtask | new `release arms future hold timer before return`, `release arms due-now timer before return`, `release withdraws missed hold before return` |
| human/child/wake/mode commands | human alias, child end, admitted wake, memory guard | keep caller's existing decision → boundary fact write → existing park/release/note order | new `boundary fact commands preserve human child wake and memory-guard order`; U3w/U9w/U15 |

P5 extends the existing call-log/Proxy tests for all new rows. A pure field-write assertion is
not enough: assert input delivery, timer registration, gate calls, durable writes and emitted
notes/heartbeat in order. For each moved site, name its table row in the migration ledger.
A site without a row blocks P5. Preserve synchronous return values and throw boundaries.

### Synchronous release regression cases required in P5

Slice 4.2 was excluded after paired probes showed an observable change. See
[its Decisive boundary and P5 test shapes](2026-11-04-slot-release-marks-pump-due.md#decisive-boundary),
reviewed on branch `cez/115618f4` at `5a0d41801`. The probes are investigation evidence;
P5 commits their test forms before deleting the handler-order block. No deferred drain ships.

Use a real temporary RunStore, RunManager, normal composition and active-state factory. Use
one first-sorted manager, an idle semaphore and no in-flight sweep. Launch no runner. Assert
before yielding, not after the eventual state converges:

| Case | Seed and trigger | Required result at synchronous return | Regression test |
| --- | --- | --- | --- |
| Native ask | parent root has unarmed 25-hour-missed usage hold; running worker has pending native ask; call handleNativeAskRequested | parent failed, deadline absent, zero parent conversation messages, zero parent inputs; worker human-ask-closed with parent-stopped; no worker-question-routed event | `native ask routes only after synchronous release withdraws expired parent hold` |
| Future hold | valid future hold without timer, no active session; release slot | timer already armed; row still waiting with deadline | `release arms future hold timer before return` |
| Due-now hold | valid deadline due now, fake timeout control prevents callback; release slot | zero-delay timer armed; row waiting. Then advance timer and assert ordinary continuation/refusal from the fixture | `release arms due-now timer before return` |
| Missed hold | unarmed deadline missed by 25 hours; release slot | row already failed, deadline absent, no timer | `release withdraws missed hold before return` |

Put these in new `workflows/native-ask-release-order.test.ts` and
`workflows/slot-release-return-boundary.test.ts`. Use the product signal for positive effects;
these immediate negative/count assertions need no elapsed-time wait. Record red results using
the test-only deferred-drain spike, then green results with the unchanged synchronous release.
The native-ask and timer tests must fail under that spike even if eventual rows converge.
Run parity for the touched run paths. A future-timer test does not replace the due-now case.
Do not change messages, timer delays or expected outcomes to make the excluded drain pass.
P5's changed files and focused-test set include both new files and the native-ask handler region.

## Implementation PRs

Land P1–P6 **in order**, each into current `main` after the preceding PR merges. No stack or
integration branch. The phase prerequisite remains slice 3.3 accepted on main. These PRs are
not dispatched until the planner approves this spec and the coordinator assigns regions.
All region numbers below are baseline lines, not reservations for parallel edits.

Every PR runs its owner/escape rule fixtures, zero-match scan, encapsulation cases, focused tests
below, root lint and typecheck. Every PR that touches wait/turn-end/failure/step settlement or a
parity fixture runs `npm run test:parity`. Unit results use Squeal where it validates; use the
repo parity command for its required gate. Every new guard/test gets recorded red/green proof.

| PR | Files and baseline regions; new files | Guard added | Focused and parity proof | Expiry block deleted |
| --- | --- | --- | --- | --- |
| P1: accounting and observation | `active-run.ts:12–14,119–140,172–181`; `run/usage-accounting.ts:13–27,33–47,105–153`; `run/subagent-waits.ts:63–96`; `run/run-skills.ts:38–76`; all usage/skills/children reader sites in evidence table; lint runner and rule fixtures | usage, children, skills rules; usage encapsulation prototype first | usage/accounting and skills tests; `team-skill-materialize.test.ts`; subagent wait tests; full `npm run test:parity` for shared fixtures. Prove private-state, nested getter, alias/helper/cast checks before proceeding | None |
| P2: session ownership | `active-run.ts` session fields; `run.ts:260–276,400–408`; `run/step-session.ts:105–125,244–269,304–317`; `run/continuation-session.ts:331,431,498–521,583–604,637–638`; `run/step-loop.ts:143,220,278–306,504`; `run/run-cancel.ts:55–59`; `run/launch-context.ts:164–172`; `run/repo-root-lease.ts:38–59`; `run/drop-active.ts:6–10`; `run/session-events.ts:103–190,280–302`; new `run/live-session-state.ts` | session rule | fresh/Continue receipt boundaries, cancellation, root lease, no-session cancellation and run-exit tests; parity U6s/U9w/U22. Move only session-group writes in listed regions | None |
| P3: input ownership | `active-run.ts:24–61,131–133,144–149`; `workflows/input-acknowledgement.ts:23`; `run/input-delivery.ts:86–101,229–299,332–434`; `run/input-receipts.ts:26–139`; `run/input-timers.ts:1–14`; `run/opening.ts:29`; `run/compose.ts:265`; fresh/Continue input setup `:125`/`:521` | input rule | input receipt/ACK tests, input consumption, held-human liveness, queued input, input-ready tests; parity U3w/U9w/U15 and input-delivery cells for each runner | None |
| P4: wait identity and autosave | `run/wait-registry.ts:95,118,152,213,247`; `run/cezar-tools.ts:123`; `run/session-events.ts:155`; `run/input-timers.ts:45`; `run/worktree-autosave.ts:138`; ActiveRun factory/view; callers clearing autosave | wait, autosave rules | wait/tool-generation and autosave tests; parity wait registration/cancel/restart cells on each runner. Keep actual timer clear at current teardown position | None |
| P5: boundary owner | new `run/turn-boundary.ts`; `run/turn-settler.ts:54–497`; `run/turn-nudges.ts:44–216`; `workflows/completion-policy.ts:52–65`; `run/input-delivery.ts:179–180,253–254,355,519–522,605–615`; `run/input-timers.ts:30–37`; `run/session-events.ts:153–155,272–274,318`; `run/step-session.ts:112,266,310–314`; Continue next-step and pending-ask writes `:469,602`; `run/human-waits.ts:28–29,105`; `run/run-finish.ts:62`; `run/run-settlement.ts:131`; `run/step-loop.ts:391`; `run/wake-admission.ts:414`; `run/subagent-waits.ts:131`; `run/memory-guard.ts:56`; `run/compose.ts:266`; skill block at baseline `load-bearing-change/SKILL.md:65–71` | boundary rule, all entry-path order tests | full order table; `autonomous-nudge-guards.test.ts`, `held-human-input-liveness.test.ts`, `input-receipt-boundaries.test.ts`; parity U6s/U15/U20/U22/U22s/U3w/U9w/R13/R17 plus existing wait/done cells on every runner | Handler-order block and its marker, only after every row and zero outside writes pass; freeze the group-slot container after fixture migration |
| P6: launch read ownership | New `run/launch-read-resolver.ts`; source regions, read forms and tests listed in the P6 section below; skill queue-head block at baseline `:35–42` | `launch-read-outside-resolver`, source-capability/alias fixtures | held-head and phase-gate fixtures for every mutable source; unchanged `team-skill-materialize.test.ts`, `agent-profile-wiring.test.ts`, model identity and queued input tests; `npm run test:parity` | Queue-head block and its marker, with zero off-owner reads and timing proof |

Each PR re-measures its regions on the current main it starts from; the baseline regions are
not reusable coordinates after a merge. Shared-file writes make these serial landing units even though groups are distinct. Allow one
implementation worker per PR by default. At most two workers may touch any hot file, and only
with assigned regions at least 40 lines apart. Closely spaced `step-session` and input regions
cannot run in parallel. P5 owns all of `turn-settler` and the relevant skill block; reserve that
whole interval. Recount and update line regions after each merge. Do not make a wide rename
while slice 4.2 or 4.3 has an assigned overlapping region.

## Behavior-neutral proof

No existing test's expected observable outcome changes. Each migration records old site,
command, order-table row and focused/parity cell in its PR body. The input owner command `analyseAcknowledgedInput` must preserve `input-acknowledgement.ts:23`
retired-marker deletion before commitOutcome, including when the commit fails; it is not moved
into post-commit receipt effects. The evidence table is the starting inventory; every 209 site must either move or already be in its owner. Constructor
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
or encapsulation diagnostic. An order regression swaps/removes one effect and must fail its named
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
The new ACK/UI/timer/launch rows and the native-ask/release return-boundary cases are required. Current `turn-settler.test.ts` alone is insufficient.
A swapped checkpoint/timer/ask operation must fail its order test; a restored outside write must
fail the owner guard. If any path lacks that proof, keep the block and report P5 incomplete.

### P6: phase-aware launch-read ownership (planner approved)

The planner approved this PR as required scope (decision `2ed14ca2`). Keeping the queue-head
block indefinitely is not the accepted exit. P6 deletes the block and its marker with the fix.
The resolver owns **where** values come from, not **when** they are read. Each call remains at
its current point, on the same side of every await, gate and callback. Nothing is read earlier.

Add `workflows/run/launch-read-resolver.ts` as the single owner of launch source selection.
Its named operations are `atTaskHead`, `atStepOpen`, `atContinue`, and `atLiveInput`.
Each is a set of narrow read operations called at the original read points, not one eager
read-all snapshot. A caller can request `resolveStepModel` after an earlier await, then
`resolveStepProfile` later as today. It must not preload the second value in the first call.
Move bodies, not calls. Existing `RunSkills`, `QueuedInput` and session adapters invoke the
resolver at those same points; their observable work and error handling stay in order.

Queue identity remains `RunLine.queue: string[]` (`run-line.ts:54`); pending job/continuation
maps retain the accepted workflow/input recipe. The resolver distinguishes authored pins,
durable amendments and live settings. It never replaces an authored input with a current
default, re-resolves an ad-hoc workflow by name, or turns the accepted job into a live catalog
lookup. Queue IDs alone cannot prove this: `pendingJobs` can still contain a stale live value.

#### Read inventory method

At the starting main, use the TypeScript AST parser from Appendix A to enumerate member,
bracket and destructured reads on `PendingJob`, `PendingContinuation`, `StartRunInput`,
`WorkflowDef`, launch config, step identity, profiles and skill-selection records. List source
imports and calls to loadConfig, model/provider/profile selection, skill discovery/off-list and
attachment reads. Follow each returned alias/helper parameter until it becomes a launch value.
Record file:line, source, pin/live policy, phase, call point, await position, error behavior,
resolver operation and test. Review computed keys and dynamic imports manually; none may be
ignored by the guard. Grep is a cross-check, not the inventory. This is P6's checked read ledger,
committed with that implementation's tests; do not treat the current table as a complete
future-main count. The AST census alone does not enforce read ownership.

#### Value and phase case table

TH means task head after dequeue; SO means each step open; C means Continue; LI means live
input into an existing session. A phase with no source read is explicit: P6 must not add one.
New tests below live in `workflows/run/launch-read-resolver.test.ts` and
`workflows/launch-read-boundaries.test.ts`. Existing tests keep their expected outcomes.

| Value | Read phase | Current source and pin/live policy | Test that pins it |
| --- | --- | --- | --- |
| Workflow | TH | accepted `job.workflow`, persisted `workflowDef` for restart; `run-start.ts:96–99,191`. Do not look up the name in a changed catalog | new `task head keeps accepted ad-hoc workflow after catalog edit and removal` |
| Workflow | SO | current accepted execution's `workflow.steps`; no catalog refresh | new `later step keeps accepted workflow definition` |
| Workflow | C | stored workflow definition/owning step selected by continuation setup | new `Continue uses stored owning workflow after catalog removal`; existing non-final done parity U6s |
| Workflow | LI | no workflow lookup; existing open session receives input | new `live input does not reload workflow` |
| Input recipe | TH | accepted `job.input` plus current durable task/message/attachment amendments; `queued-input.ts:68–92` | new `task head keeps accepted input pins and refreshes amendments` |
| Input recipe | SO | accepted execution input and authored step overrides; no wholesale refresh | new `step open keeps accepted input recipe` |
| Input recipe | C | hydrated pending continuation plus current `continuationMessage` and task/message stack (`queued-input.ts:99–131`) | new `queued Continue refreshes edits without dropping continuation pins` |
| Input recipe | LI | current delivery content and durable queue, not original opening input | new `live input delivers current queued content` |
| Task text | TH | current `run.task` plus current `queuedMessages`, folded at hydration (`queued-input.ts:69–73`) | new `task head sees edit and queued-message removal while held` |
| Task text | SO | prepared task/prompt and step substitution at its existing point; no new record refresh | new `later step preserves existing task substitution point` |
| Task text | C | current amended task plus continuation text (`queued-input.ts:109–113`) | new `queued Continue sees amended task and prompt` |
| Task text | LI | message content/durable input queue at send time; task record is not rewritten | new `live text delivery leaves task record unchanged` |
| Attachments | TH | original live blocks when available, otherwise persisted URLs; stacked URLs re-read and stat-checked at hydration (`queued-input.ts:75–92,134–160`) | new `task head honors attachment removal and replacement`; include persistence-failed live-block path |
| Attachments | SO | prepared attachment set at current step call point, not an eager new disk scan | new `step attachment read stays at its current point` |
| Attachments | C: hydration | only stacked queued-message attachments are read at hydration (`queued-input.ts:114–123`); this does not read checkpoint continuation images | new `queued Continue omits deleted queued attachment at hydration` |
| Attachments | C: opening | after awaited worktree setup and skill discovery (`continuation-session.ts:454–466`), continuationOpening calls continuationImages: read checkpoint.images when checkpoint.id matches stepId, kind continuation (`opening.ts:63–67`); prefer live input images for image blocks, append hydrated queued images/attachments | new `Continue deletes checkpoint attachment between hydration and opening`; new `Continue opening prefers live images and appends queued attachments` |
| Attachments | LI | current pasted blocks persisted by current message path | new `live attachment uses current message content` |
| Runner | TH | accepted `input.runner` else config default at `step-loop.ts:64–71`; account hold gate reads fallback during pump (`run-line.ts:246–257`) | new `held task reads current default runner but retains an explicit runner`; keep two separate read points |
| Runner | SO | authored `step.runner ?? taskBackend` (`step-session.ts:88`) and worker step identity | new `step runner override remains pinned` |
| Runner | C | recorded backend/owning step and existing continuation transport choice (`launch-settings.ts:88–105`) | new `Continue retains owning runner and transport` |
| Runner | LI | current session/delegation settings; no backend reselection | new `live input uses current session runner` |
| systemPrompt | TH | explicit input override wins, else live config default; worker pin path preserved (`step-loop.ts:78–80`) | new `held task reads current system prompt default and keeps explicit override` |
| systemPrompt | SO | existing launch/step prompt assembly, same extra prompt value and selected skill reads | new `step prompt preserves task extra-prompt pin` |
| systemPrompt | C | current continuation setup reads recorded/worker settings at its current point | new `Continue keeps recorded extra prompt and worker pin` |
| systemPrompt | LI | current slash expansion/message; no session system prompt rewrite | new `live input does not replace opening system prompt` |
| Model | TH | accepted model pin plus live model-lock/provider lookup; `step-loop.ts:81`, `launch-settings.ts:115–128` | new `held task preserves model pin and reads provider policy at launch` |
| Model | SO | worker step identity else authored step override else accepted input; live provider/lock lookup (`launch-settings.ts:140–190`) | `model-identity-wiring.test.ts`; new `step open reads provider policy after preceding step` |
| Model | C | stored owning step/run pin and live lock/provider lookup (`launch-settings.ts:35–81`) | `model-identity-wiring.test.ts`; new `Continue retains authored model and reads current policy` |
| Model | LI | no model reselection in ordinary message send; child delegation selection is its existing separate operation | new `ordinary live input does not resolve a model again` |
| Effort | TH | accepted input effort is persisted on the run at enqueue (`run-start.ts:74`); task-level model identity does not resolve effort. Do not add an eager effort read here | new `task head does not snapshot effort before step selection` |
| Effort | SO | model lock returns undefined; otherwise worker step identity, then authored step effort (including explicit unset semantics), then current `store.getRun(runId)?.effort ?? input.effort` (`launch-settings.ts:168–179`). The current record wins over the accepted input fallback | new `step open uses amended run effort ahead of original input`; new `authored and worker effort retain precedence over run amendments` |
| Effort | C | live model lock, else worker identity, else authored owning-step effort, else current continued record effort (`launch-settings.ts:64–81`); preserve parsing/error behavior | new `Continue uses current record effort after owning-step precedence` |
| Effort | LI | ordinary live messages do not reselect effort; delegation selection stays a separate existing operation | new `ordinary live input does not resolve effort again` |
| Agent profile | TH | per-run account pin persisted at enqueue (`run-start.ts:76–79`), current account/hold check at pump and startExecution | new `held task retains per-task account while current hold changes`; keep both gates |
| Agent profile | SO | worker step identity first; otherwise matching run account pin (only when step backend matches run runner), then project/default (`launch-context.ts:65–75`). Fresh `step-session.ts:97` passes stepId, not recordedProfileId. It must not reuse the prior step profile on retry | `agent-profile-wiring.test.ts`: `resolves each step of a MIXED-backend workflow against its own provider`; new `fresh step retry uses current run pin or project default instead of prior recorded profile`; keep deleted-account fallback test |
| Agent profile | C | worker step identity account wins first (`launch-context.ts:65–70`); otherwise recorded owning-step profile, then matching run pin, then project/default (`:72–75`). Continue passes owningStep.profileId and toolsStep.id (`continuation-session.ts:293–295`) | new `Continue worker identity wins over conflicting recorded profile`; `agent-profile-wiring.test.ts`: `keeps a Continue on the account the step recorded, whatever the project uses now` for non-worker path |
| Agent profile | LI | current session profile; no ordinary message account reselection | new `live input keeps current session account` |
| Skills | TH | discover run registry at existing start point (`run-skills.ts:38–46`), selected skill reads remain at prompt preparation | new `held task discovers current skill body and source availability` |
| Skills | SO | current off-list/source filtering on run registry at each prompt (`run-skills.ts:56–61`; `step-session.ts:160,179`) | `team-skill-materialize.test.ts`: `a later step does not run a skill switched off while an earlier step ran` |
| Skills | C | discover at Continue with current throw/ignore policy, then current enabled selection | `team-skill-materialize.test.ts`: `a companion switched off after the run started is not installed on Continue` |
| Skills | LI | live slash expansion/provision uses current disabled skill/source settings | `team-skill-materialize.test.ts`: `a live /name of a team skill switched off during the run is not expanded` |

Task-head includes several current boundaries, not one transaction: pump admission, dequeue
hydration, task preparation and spawn-time gate. Keep each one. The profile/runner row must
not merge the pre-dequeue and pre-spawn account gates. The same principle applies to different
await positions inside step and Continue setup. Test absence/deletion at the phase where it
already takes effect; do not make a pin live merely to satisfy a held-head assertion.

#### Read rule, regions and proof

P6 adds `launch-read-outside-resolver` with no baseline and no exceptions. It is a read rule,
not an ActiveRun write rule. Its YAML covers `workflows/run.ts` and `workflows/run/**`; only
`run/launch-read-resolver.ts` may import/call launch source selection APIs or unpack raw launch
source fields. Move relevant source adapters into that owner. Callers receive resolved values,
not the raw source record; owner-only wrappers keep source selection out of handlers.

The pattern families are: imports/re-exports of source selectors (including renamed imports),
member/subscript/destructuring reads of workflow/input/config/record launch fields at the
selection seams, and calls through a local imported alias. Include optional reads, defaulted
bindings, helper parameters and computed keys found in the read ledger. Each fixture corresponds
to a ledger form. The rule must distinguish a raw source read from reading an already-resolved
value. Narrow capability interfaces keep raw inputs inside the resolver; methods return the
chosen value at the old point. The class/adapter boundary must make an alias unable to expose
a raw source. Do not claim ast-grep can resolve arbitrary helper data flow. If the prototype
cannot close a found form without exceptions, stop and route the concrete gap before landing.

Add both positive fixtures for resolver operations at each phase and negative fixtures for
each off-owner source read, imported alias, destructured/bracket read and helper form. Scan
the full scoped source tree at zero matches. No source reader may remain as an ignored match.
Run the rule fixtures, compiler checks, focused tests below, and `npm run test:parity` for the
run paths touched. P6 must preserve all existing tests, including both suites named by the planner.

Baseline regions: `run-line.ts:140–171,200–269,288–310,375–382`;
`run-start.ts:61–105,164–191`; `queued-input.ts:68–160`;
`step-loop.ts:60–99`; `step-session.ts:88–105,150–180`;
`continuation-session.ts:160–185,240–335`; `launch-settings.ts:14–190`;
`session-events.ts:164–182`; `opening.ts:20–67`; `continuation-session.ts:445–466`;
`launch-context.ts:55–82`; `run-skills.ts:27–61,125–153`.
Add `launch-read-resolver.ts`, its rule/fixtures, `launch-read-resolver.test.ts`, and
`launch-read-boundaries.test.ts`. Re-measure all regions on P6's starting main. P6 runs after
P5; do not edit these hot regions in parallel with 4.2 or overlapping 4.3 batches.

Held-head fixtures use a product release gate: hold the first task, queue the second, change
the source, release, and observe the second task's actual runner input/store/events. For workflow
and explicit input pins, assert the accepted value survives catalog changes. For task text and
queued input, edit and remove queued messages. For attachments, replace and remove persisted
files and cover the original-live-block fallback. For runner/systemPrompt/model policy/profile and current run effort,
change the default and remove the selected resource where supported; keep explicit pins and
current fallback/error behavior. For skills, edit body, remove a source, and deselect skill/source.
Repeat for queued Continue. For SO and LI reads, add a second release gate at the current phase,
then change the source after task head; a task-head fixture alone cannot pin a later read.

Red proof is a **test-only patch** that captures each live source at enqueue and feeds that
snapshot to the original later call. It must fail each corresponding live-source fixture.
For deliberate pins and no-read phases, the paired fixture is a behavior guard; add an
opposite-policy mutant (re-resolve a pin or add a new read) and require that fixture to fail.
Do not claim an enqueue snapshot can fail a field deliberately pinned at enqueue: the planner's
stale-snapshot proof applies to the mutable late source, not accepted authored values. Record
source, phase, mutation patch, failing assertion, red command and fixed green command in the
PR body. All existing team-skill/profile tests stay unchanged and pass.

P6 then deletes `Preserve queue-head reads when changing queue boundaries...` and
`<!-- until: hearsay-tools/cezarion#2520 -->` in the same PR. A restored off-owner read must fail
the rule; a moved-early read must fail the phase fixture. These guards replace the block's
source-selection and read-timing protection. The resolver is not an eager cache or new queue.

## Interactions

- **Slice 4.2, hearsay-tools/cezarion#2521:** excluded: deferred drain changed the timer set at
  return and native-question routing history. Keep synchronous release/pumping exactly as
  shipped. P5 adopts the native-ask, future/due/missed-hold probes as committed regression tests
  above. Its handler-order block cannot be deleted without them. RunLine retains queue/slot
  collections; 4.1 adds no pumpDue flag, deferred drain or moved release call. Reserve overlapping
  compose, settler, native-ask and input regions through the coordinator.
- **Slice 4.3, hearsay-tools/cezarion#2522:** tests often read
  `runInternals(m).active.get(id)` fields. Search all old field names, new group paths and
  `runInternals(` before each group moves. 4.3 should assert store/events or a narrow public
  signal. It must not expose a mutable group view to preserve old tests. 4.3 batches touching these modules, especially B3 turn-end tests that construct TurnSettler,
  RunFinish and TurnNudges with stub hosts, must land before the PR that changes that module's
  host/state shape, or that PR must update the batch itself. 4.1 updates any
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

1. P6 has planner approval but its exact source capability/rule prototype still needs proof.
   It cannot land with an alias escape, moved read phase, or stale-source baseline. Neither
   expiry block is deleted by this design PR; P5 and P6 delete them with their replacements.
2. P1 must prove that private classes, immutable owned values and live read-only views close
   alias/helper writes without a semantic companion. If this fails, stop and route the
   counterexample; a new gate tool is not implicitly approved. A clean syntax scan alone cannot satisfy acceptance.
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
