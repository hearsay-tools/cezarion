# Owned Workers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a parent supervise ordinary worker runs in owned isolated worktrees through a provisioned CLI without changing ordinary-run defaults.

**Architecture:** A single delegation service enforces identity and ownership; thin authenticated HTTP and CLI adapters call it. RunManager retains scheduling, safe delivery and process lifetime; RunStore persists intent before side effects. A loopback listener belongs to the existing controller process and supports both cockpit and headless launches.

**Tech Stack:** Strict TypeScript ESM, Node >=20, npm workspaces, Hono, Zod, React 19, Vitest and existing node:test/package/browser gates; no new dependency.

**Spec:** `.ai/specs/2026-09-06-owned-workers-isolated-worktrees.md` (owner approved 2026-09-06).

## Global Constraints

- `CEZ_DELEGATION` defaults off.
- No recursive delegation, peer messaging, shared workspaces, dirty snapshots, automatic merge, or automatic review acceptance.
- This is cooperative local-agent supervision, not process isolation.
- All routes use `/api/v1`; inventory the new surface in `BACKWARD_COMPATIBILITY.md`.
- Default timeout is 600 seconds; accepted values are 1–1800 seconds.
- At most 32 accepted worker creations per parent, including destroyed workers.
- Wait up to 30 seconds for proven termination during destruction.
- No authored configuration, no daemon, no new dependencies; every new CEZ variable is documented in `.env.example` in the same commit.
- Both execute and runContinuation initialize every new delivery/provisioning field.
- Every runner parity row is live or has a documented real wire exemption, never a skip.
- Repository verification runs before **every** commit. Do not make per-task commits on narrow tests alone. Keep one logical feature commit if repeating the full gate at each boundary is wasteful.

## Workspace and execution rules

Use the existing worktree and branch `feat/owned-workers-isolated-worktrees`.
The issue is assigned and project #4 is In progress. No PR exists. Do not create
another worktree unless parallel writers require it. Sequential implementation
with read-only review is sufficient because lifecycle tasks share RunManager.

For each task: write the test, run it red, make the smallest change, run it green,
and record commands/results in the task handoff. For regression tests that were
added after diagnosis, temporarily remove only the source fix and demonstrate
red, then restore it without losing unrelated work. Never stash other writers'
changes. Run Vitest through `npm test --`, never npx.

## File ownership and dependency map

| Unit | Responsibility | Files |
| --- | --- | --- |
| Contract | Shared schemas/types; no Node imports | `packages/contract/src/delegation.ts`, `runs.ts`, `events.ts`, `index.ts` |
| Persistence | Atomic owned-run creation, durable intent, parse quarantine | `packages/cezar/src/runs/store.ts`, `runs/delegation-state.ts` |
| Credentials | Ephemeral session authentication, not relationship policy | `packages/cezar/src/delegation/credentials.ts` |
| Policy/service | Parent-only authorization and operation coordination | `packages/cezar/src/delegation/service.ts`, `policy.ts` |
| Owned Git resources | Pin/verify baseline; checked destruction | `packages/cezar/src/delegation/workspace.ts` |
| Lifecycle | Durable wait reducer and manager admission/termination | `packages/cezar/src/delegation/wait.ts`, `workflows/run.ts` |
| Safe input | Attributed queue and backend non-human seam | `packages/cezar/src/delegation/input.ts`, `core/agent-runner.ts`, four runners |
| Transport | Chained route adapter and lifecycle-owned listener | `packages/cezar/src/delegation/routes.ts`, `transport.ts` |
| Provisioning/CLI | Child-only env, bundled invocation and CLI JSON parsing | `packages/cezar/src/delegation/provision.ts`, `cli.ts`, `index.ts` |
| UI | Relationships and attributed input using existing views | `packages/web/src/routes/task-thread/run-relationships.tsx`, existing header/list/transcript/cache |

Tasks 1–2 establish contracts and policy; 3 establishes owned workspaces; 4–6
establish safe delivery/lifecycle/cleanup; 7 wires the working interface; 8 adds
cockpit navigation; 9 runs cross-layer acceptance and publication gates.
Do not expose transport before tasks 1–6 pass their integration tests.

## Task 1: Validated metadata and durable owned-run persistence

**Files:** Create `packages/contract/src/delegation.ts`,
`packages/cezar/src/runs/delegation-state.ts`,
`packages/cezar/src/runs/delegation-state.test.ts`.
Modify `packages/contract/src/{index,runs,events}.ts`,
`packages/cezar/src/runs/store.ts`,
`packages/cezar/src/server/contract-parity.runs.test.ts`.

**Interfaces:** Export Zod schemas and inferred types `DelegationState`,
`WorkerWorkspace`, `WorkerWait`, `WorkerOutcome`, `WorkerDestroy`,
`WorkerSpawnRequest`, `WorkerSteerRequest`, `WorkerWaitRequest`,
`WorkerInspection`, `WorkerDiff`, `WorkerStopResult`, `WorkerDestroyResult`,
`RunRelationships`, `AgentInput`, `DelegationErrorResponse`, `WorkerOperation`.
Export `workerOperationSchema` with spawn/inspect/steer/stop/destroy/diff/wait;
`WorkerOperation` is inferred from it. No handwritten API interfaces. `DelegationState` is an optional discriminated
union: root, worker, or invalid/quarantined. Worker carries `parentRunId`,
`workspace`, `destroy?`; root carries durable creation receipts and `wait?`.
Invalid metadata must not collapse to absence and make a worker eligible as root.

- [x] Add schema tests for strict requests, optional legacy metadata, enum
  discrimination, date/UUID/commit validation, request ID retry shape and bounds.
  Use these representative assertions in `delegation-state.test.ts`:

```ts
expect(workerWaitRequestSchema.parse({ workerIds: [workerId] }).timeoutSeconds).toBe(600);
expect(workerWaitRequestSchema.safeParse({ workerIds: [workerId], timeoutSeconds: 1801 }).success).toBe(false);
expect(workerSpawnRequestSchema.safeParse({ task: 'fix tests', requestId, baseline: 'parent-head', parentRunId: workerId }).success).toBe(false);
```

  Define `workerId` and `requestId` in this test as `randomUUID()` values; import
  `randomUUID` from `node:crypto` only in the service test, not the contract.
- [x] Run `npm test -- packages/cezar/src/runs/delegation-state.test.ts` and record
  red (missing schemas initially).
- [x] Implement schemas using strict request objects and normal shared schema
  composition. Avoid circular imports: delegation schemas own their terminal
  status literals; `runs.ts` imports delegation metadata, never vice versa.

```ts
export const workerWaitRequestSchema = z.object({
  workerIds: z.array(z.uuid()).min(1).max(32)
    .refine(ids => new Set(ids).size === ids.length),
  timeoutSeconds: z.number().int().min(1).max(1800).default(600),
}).strict();
export type WorkerWaitRequest = z.infer<typeof workerWaitRequestSchema>;
```

  Workspace fields: `ownerRunId`, `resourceId`, `kind:'owned-isolated'`,
  `path`, `branch`, `baselineSha`. Wait fields: `id`, `workerIds`, `deadline`,
  `phase`, `outcomes`, `wakeId?`. Destroy fields: `requestedAt`, `phase`,
  `remaining`, `error?`. AgentInput fields: `id`, `source` (agent/lifecycle),
  `parentRunId`, `text`, `createdAt`, `deliveredAt?`. Roots/worker records carry
  `permissions` as a resolved operation enum array, never arbitrary strings.
- [x] Add `RunStore.commitDelegation(patches: ReadonlyArray<{id: string;
  delegation: DelegationState}>): void` and
  `RunStore.createOwnedRun(input: Parameters<RunStore['createRun']>[0],
  parentId: string, requestId: string, worker: DelegationState): RunRecord`.
  Store internals build a proposed index, synchronously atomic-write/rename it,
  then publish in-memory updates/events. Failure throws and publishes nothing.
  Creation inserts the receipt and worker in the same index write. Do not call
  existing best-effort `flush()` and treat its void return as durable success.
- [x] Test failed writes leave no receipt/worker/events; reopen the store and
  verify successful records/receipts survive. Retry the same request returns the
  same ID; changed payload under an existing request ID is rejected.
- [x] Run the new tests, store tests and contract parity. Ensure malformed
  delegation quarantines only that record's delegation authority rather than
  making the entire run index unreadable.

## Task 2: Ephemeral identity and centralized parent-only policy

**Files:** Create `packages/cezar/src/delegation/{credentials,policy}.ts` and their
`.test.ts` files. Modify `packages/cezar/src/core/agent-env.ts` and its tests.

**Interfaces:** `CredentialRegistry.issue(projectId: string, runId: string,
 generation: string): string`, `authenticate(token: string): Caller | undefined`,
`revoke(runId: string): void`, `close(): void`; `Caller` is an internal branded
object with project/run/generation, never a wire type. Export
`authorizeWorker(caller: Caller, target: RunRecord, operation: WorkerOperation,
parent: RunRecord): void` and `authorizeSpawn(caller: Caller, parent: RunRecord): void`.
`WorkerOperation` is inferred from the contract enum from task 1.

- [x] Write credential tests for independent tokens, wrong token, rotation,
  revocation and close; policy tests exercise every operation with owner,
  unrelated root, worker, invalid metadata, missing parent and wrong project.
- [x] Run `npm test -- packages/cezar/src/delegation/credentials.test.ts packages/cezar/src/delegation/policy.test.ts` red.
- [x] Implement random 32-byte base64url tokens and store only their SHA-256 keys
  in the ephemeral registry. A new generation revokes previous run credentials.
  Persist no tokens and return a frozen branded Caller only from authentication.

```ts
const token = randomBytes(32).toString('base64url');
const key = createHash('sha256').update(token).digest('hex');
```

  Policy checks project, root eligibility, exact target parent, operation set,
  target destruction phase and parent lifecycle. Reads are scoped too. Return
  one denied-scope result for unrelated and nonexistent targets. Root spawn
  limit counts persisted receipts including destroyed workers, not live rows.
- [x] Add environment tests covering both normal filtering and
  `CEZ_AGENT_ENV_FULL=1`: inherited delegation tokens/URLs never reach another
  session. Strip those two names case-insensitively from inherited env before
  merging controller-generated `spec.env`; passthrough cannot override this.
- [x] Run credential/policy and agent-env tests green. Confirm root identity
  comes from registry lookup, never `CEZ_TASK_ID` or an HTTP parent field.

## Task 3: Pinned worktree provisioning and worker-attributed diff

**Files:** Create `packages/cezar/src/delegation/workspace.ts` and
`workspace.test.ts`; modify `packages/cezar/src/workflows/run.ts`,
`packages/cezar/src/git-worktree.ts` only for reusable checked primitives.

**Interfaces:** `resolveWorkerBaseline(repoRoot: string, parentCwd: string,
 baseline: string): Promise<string>`;
`createOwnedWorkspace(repoRoot: string, workerId: string,
 baselineSha: string): Promise<WorkerWorkspace>`;
`readOwnedDiff(repoRoot: string, run: RunRecord): Promise<WorkerDiff>`.
Manager `enqueueOwnedRun(runId: string): void` accepts a durable queued record,
not caller-supplied arbitrary paths. Rebuild its quick-task input from that record.

- [x] Create temp Git tests with two commits and a dirty tracked/untracked file.
  Verify `parent-head` resolves commit two and that worker worktree contains
  committed content only. Resolve a named ref, move it before creation, and
  verify the pinned SHA stays unchanged.

```ts
const pinned = await resolveWorkerBaseline(root, parentPath, 'parent-head');
const workspace = await createOwnedWorkspace(root, workerId, pinned);
expect(workspace.baselineSha).toBe(pinned);
expect(await readFile(join(parentPath, 'tracked.txt'), 'utf8')).toBe('dirty');
expect(await readFile(join(workspace.path, 'tracked.txt'), 'utf8')).toBe('committed');
```

  Build each repository with `execFileSync('git', args, {cwd})`, local test author
  settings and `mkdtemp`; dispose only the test-owned directory.
- [x] Run `npm test -- packages/cezar/src/delegation/workspace.test.ts` red.
- [x] Resolve `parent-head` against server-known cwd, other refs against root;
  validate refs and verify `${ref}^{commit}` with bounded execFile argument arrays.
  Persist SHA before queueing. Call existing createWorktree with SHA but reject
  collisions unless persisted ownership proves this is a recovery of that run.
  Refuse non-Git and failed creation; no cwd fallback for workers.
- [x] Add a worker-only Git diff test after a parent commit and a worker commit;
  feed `baseBranch`, original `branch`, and `startedAt` into the existing
  `resolveTaskDiffBase`. Include branch checkout change and missing-resource
  failure. Return explicit truncation metadata at existing diff cap.
- [x] Run workspace tests plus `run-isolation.test.ts` and Git diff tests green.
  Prove spawn never invokes autosave; ordinary independent autosave stays intact.

## Task 4: Non-human input that cannot answer pending asks

**Files:** Create `packages/cezar/src/delegation/input.ts`, `input.test.ts`;
modify `packages/cezar/src/core/agent-runner.ts`, `claude-cli-runner.ts`,
`codex-app-server-runner.ts`, `opencode-server-runner.ts`, `pi-runner.ts`,
`workflows/run.ts`, `core/harness-parity.test.ts`, `harness-parity.testkit.ts`,
their existing four wire-faithful mocks, `AGENT_PROTOCOL.md`.

**Interfaces (controller-approved review refinement, 2026-09-07):**
`AgentSession.sendAgentMessage(content: ContentBlock[]): false | Promise<void>`.
The method synchronously reserves one submission or refuses with false. The
Promise resolves only at the backend's transport acceptance boundary; rejection
retains the same durable input for replay. False never permits sendMessage fallback.
Codex/OpenCode/Pi use their real correlated RPC/HTTP ACK; Claude uses successful
stdin write completion, which does not prove model execution. Manager checkpoints
only at ACK, merges the current queue, counts pending ACK in the 32 cap, acquires
wake capacity on reservation, and retires a wait only after ACK plus checkpoint.
Exact session/lifecycle guards reject stale ACK; finalization awaits bookkeeping.
DONE and nonfinal auto-end preserve a completed boundary while ACK is pending.
This explicitly replaces the earlier boolean-true-as-delivered interpretation;
public input/response shapes and the human API are unchanged.
Export `enqueueAgentInput(run: RunRecord, input: AgentInput): AgentInput[]` and
`nextAgentInput(queue: readonly AgentInput[], pendingHumanAsk: boolean): AgentInput | undefined`.
Manager exposes `steerWorker(runId: string, input: AgentInput): 'queued'|'delivered'`.

- [x] Write a pure queue test:

```ts
expect(nextAgentInput([input], true)).toBeUndefined();
expect(nextAgentInput([input], false)).toEqual(input);
```

  Use an input object with UUID, source `agent`, parent UUID, text and ISO timestamp.
  Add queue-cap test (32 undelivered messages per worker) and terminal rejection.
  Add a harness scenario sending non-human text during a native/marker ask and
  assert no answer is emitted until actual `sendMessage` human input arrives.
- [x] Run input tests and the narrowed new parity row red before modifying runners.
- [x] Persist attributed input before delivery and retain it on false. Never
  append `user-message` or expand registry slash skills for agent input.

```ts
export function nextAgentInput(queue: readonly AgentInput[], pendingHumanAsk: boolean) {
  return pendingHumanAsk ? undefined : queue.find(input => !input.deliveredAt);
}
```

  Track manager asks for marker and native events. Add runner guard for native
  pending questions before calling its prompt/turn path. Deliver only at safe
  turn boundaries when native steer is unavailable. Do not route through the
  existing native-question answer branch. Fresh and continuation paths share
  queue hydration and ask-state handling.
- [x] Extend parity scenarios in all four mocks from documented existing wire
  shapes. Test before/during/after ask, false/retry, queued startup, continuation,
  and restart. Add typed agent-input event with ID/source; preserve legacy events.
- [x] Run `npm test -- packages/cezar/src/delegation/input.test.ts packages/cezar/src/core/harness-parity.test.ts` and relevant runner tests green.

## Task 5: Durable worker wait, capacity admission, and restart reconciliation

**Files:** Create `packages/cezar/src/delegation/wait.ts`, `wait.test.ts`,
`packages/cezar/src/workflows/worker-wait.test.ts`;
modify `workflows/run.ts`, `runs/delegation-state.ts`.

**Interfaces:** `reconcileWorkerWait(wait: WorkerWait, outcomes: readonly WorkerOutcome[],
 now: string): WorkerWait` is pure. Manager exposes
`registerWorkerWait(parentId: string, request: WorkerWaitRequest): WorkerWait`,
`queueWorkerWake(parentId: string): void`,
`reconcileWorkerWaits(): void`.
Use private manager sets/maps for admission only; durable wait records remain truth.

- [x] Write reducer tests for pending -> wake-pending by deadline or first terminal
  outcome, stable wake ID on repeated reconciliation, terminal-before-park and
  no outcome loss. Use fake clock, not sleeps.

```ts
const expired = reconcileWorkerWait(wait, [], wait.deadline);
expect(expired.phase).toBe('wake-pending');
expect(reconcileWorkerWait(expired, [], wait.deadline).wakeId).toBe(expired.wakeId);
```

- [x] Build integration fixtures using existing `workspace-semaphore.test.ts`
  temp-repo/store/manager setup, with maxParallel=1 and wire-faithful dry-run
  runners. Parent calls register wait; assert child remains queued until parent
  yields, then starts while parent holds zero busy slots. Finish child and assert
  parent wake waits for scheduler admission, not immediate human-resume semantics.
- [x] Run `npm test -- packages/cezar/src/delegation/wait.test.ts packages/cezar/src/workflows/worker-wait.test.ts` red.
- [x] Implement wait creation with 600-second default/1800 cap, unique worker set,
  no pending ask and one outstanding wait. Reconcile at register and park.
  Persist wake ID/outcome first, queue at most one admission, send lifecycle input
  through task 4, then persist receipt. Treat crash-redelivery as same wake ID.

```ts
const finished = outcomes.some(outcome => wait.workerIds.includes(outcome.workerId));
const expired = Date.parse(now) >= Date.parse(wait.deadline);
if (!finished && !expired) return wait;
return { ...wait, phase: 'wake-pending', outcomes: [...outcomes], wakeId: wait.wakeId ?? wait.id };
```

  Integrate a worker-wait-specific slot exemption and scheduler queue entry for a
  live parked parent; admission reverses the exemption before delivery. Do not
  change the existing human-message exemption. Deadline for registered intents
  cannot exempt a still-executing parent. Worker waits override generic
  monitoring/autonomous turn-end behavior, never a pending ask.
- [x] Test all terminal outcomes (review/done/failed/cancelled), human wait
  withdrawal, timeout without child cancellation, all selected-worker statuses,
  parent cancel/terminal cascade, and controller shutdown without cascade.
- [x] Reopen store with registered/parked/wake-pending records. Reconcile before
  generic `recover()` waiting-success settlement, rebuild timers, queue resumed
  children/parents fairly, and preserve asks. Test duplicate recovery and both
  execute/continuation turn-end handlers. Run old monitoring/recovery/semaphore
  suites alongside new tests green.

## Task 6: Termination barriers and verified retryable destruction

**Files:** Extend `delegation/workspace.ts` and its tests; create
`packages/cezar/src/workflows/worker-destroy.test.ts`;
modify `workflows/run.ts`, `runs/retention.ts`, `runs/store.ts`,
`git-worktree.ts`, server deletion/continuation/worktree routes in `server.ts`.

**Interfaces:** Manager `awaitRunTermination(runId: string, timeoutMs: number): Promise<boolean>`
and `requestWorkerStop(runId: string): WorkerStopResult`;
workspace `removeOwnedWorkspace(repoRoot: string, workspace: WorkerWorkspace): Promise<WorkerDestroyResult>`.
Service in task 7 serializes destroy and persists its phases. All manager launch
and continuation entry points consult persisted destruction state.

- [x] Add tests for queued, starting-before-ActiveRun, live, parked, terminal,
  concurrent stop/destroy and ignored SIGTERM. Confirm no deletion before session
  result/process termination and workflow finalization. Timeout yields incomplete.
- [x] Run `npm test -- packages/cezar/src/workflows/worker-destroy.test.ts packages/cezar/src/delegation/workspace.test.ts` red.
- [x] Track an execution completion promise from before dequeue through final
  cleanup; resolve it in finalization for every path, including failed startup.
  Cancellation during `starting` must leave durable intent checked before launch.

```ts
const terminated = await manager.awaitRunTermination(workerId, 30_000);
if (!terminated) return { complete: false, remaining: ['termination'] } as const;
```

  Returned result above conforms to task 1 schema. Use bounded timers and clear
  them on settle/dispose. Restart without proven termination preserves incomplete
  state; never signal a PID solely because a stale record contains it.
- [x] Verify recorded path with lstat/realpath, full resource ID and Git worktree
  registration; reject symlink substitutions, moved resources, changed ownership,
  unowned checked-out branches and branch collisions. Check each Git command and
  postcondition. No fallback recursive rm, no deletion of inferred branch names.
  If only part was removed, retain exact remaining resources for a later retry.
- [x] Exclude worker ownership/invalid ownership from generic retention; block
  rematerialization and continuation during/after destruction. Human delete and
  worktree delete must retain ownership evidence until verified cleanup and no
  live descendants. Preserve tombstone/events after successful worker destroy.
- [x] Run retention/rematerialization/orphan/deletion tests with new worker cases
  and ordinary-run guards. Restart after each destruction phase; repeat destroy
  and assert resources are not claimed from unrelated paths. Run green.

## Task 7: Shared service, chained routes, CLI and per-session provisioning

**Files:** Create `packages/cezar/src/delegation/{service,routes,transport,provision,cli}.ts`
and matching tests; modify `index.ts`, `server/project-context.ts`,
`workflows/run.ts`, `.env.example`, `README.md`, `BACKWARD_COMPATIBILITY.md`.
Add `packages/cezar/src/server/contract-parity.delegation.test.ts` and
`packages/cezar/test/e2e/delegation.test.ts`.

**Interfaces:** `DelegationService` exposes async methods `spawn`, `inspect`,
`steer`, `stop`, `destroy`, `diff`, `wait`; every method takes a task-2 Caller
first and task-1 input shapes. `spawn` returns `{workerId, baselineSha}`.
`createDelegationRoutes(service: DelegationService, credentials: CredentialRegistry)`
returns the chained Hono family. `startDelegationTransport(app)` returns
`Promise<{url: string; close(): Promise<void>}>` using inferred app type.
`runWorkerCommand(argv: string[], env: NodeJS.ProcessEnv): Promise<number>` handles
JSON output and exit code. `provisionDelegationSession` returns controller-built
`env`, instruction text and a revocation callback; share it across manager starts.

- [x] Write HTTP tests for every operation and failure shape, wrong project/token,
  forged identity fields, all unrelated read/control routes, denied workers,
  disabled service, origin/Host guard and token absence in responses/events.
  Keep the listener loopback-only even when cockpit hosted mode is enabled.
- [x] Run new service/route/CLI tests red.
- [x] Compose service operations from tasks 1–6. Spawn: authorize -> parent-scoped
  serialized receipt/limit check -> resolve settings/SHA -> durable owned record
  and receipt -> enqueue -> bounded response. Destroy: per-worker serialization
  -> durable intent -> cancel/barrier -> verified removal -> durable result.
  Recheck permissions/state inside serialization to close concurrent operation races.
- [x] Implement chained route definitions under `/api/v1/delegation`, with token
  auth middleware before operation dispatch and strict validators:

```ts
return new Hono()
  .use('*', authenticateDelegation)
  .post('/spawn', jsonZodValidator(workerSpawnRequestSchema), async c =>
    c.json(await service.spawn(c.get('caller'), c.req.valid('json')), 201));
```

  Define `authenticateDelegation` locally with typed Hono Variables containing
  `caller: Caller`; it uses the task-2 registry and the existing origin/Host guard
  helper. Chain inspect/steer/stop/destroy/diff/wait similarly, validating params
  with `paramZodValidator`. Return contract-checked error codes; never invent a
  second policy implementation in route handlers. Export route type for typed
  tests; inventory listener routes as well as cockpit relationship routes.
- [x] Bind only `127.0.0.1` with port 0, in the existing controller process. Close
  on headless finish/cockpit shutdown. Register boot and lazy project contexts
  before their recovery launches sessions. Failure records unavailable once and
  leaves ordinary run execution working. Disabled boot opens no listener.
- [x] Parse CLI operation before global parseArgs. CLI reads only provisioned
  endpoint/token, validates numeric bounds and server responses, disallows redirects
  and non-loopback URLs, returns bounded JSON and nonzero on operation failure.

```ts
const response = await fetch(url, {
  method: 'POST', redirect: 'error',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body), signal: AbortSignal.timeout(45_000),
});
```

  `url`, `token`, `body` are the validated CLI request variables, not caller IDs.
  Reject supplied origin/auth override flags. Instructions use `process.execPath`
  and the absolute current installation CLI entry point with safe shell quoting;
  the packaged test runs from a cwd without `cez` on PATH.
- [x] Wire session-specific env/instructions and revocation in execute and
  runContinuation; never inherit parent's credential. Test all four runner env
  builders, continuation after rotation and service-off restart reconciliation.
- [x] Add docs for `CEZ_DELEGATION`, generated `CEZ_DELEGATION_URL/TOKEN`, CLI
  examples, 32-worker cap, 32-message queue cap, wait semantics, cleanup retries,
  headless support and cooperative trust limits. No token examples contain a real secret.
- [x] Run new tests, typed-body/contract/route inventory tests and CLI argument
  regression tests green. Package integration runs only after build in task 9.

## Task 8: Relationships and agent attribution in existing cockpit views

**Files:** Create `packages/web/src/routes/task-thread/run-relationships.tsx` and
`.test.tsx`; modify `run-header.tsx`, `session-transcript.tsx`, `thread-state.ts`,
`packages/web/src/lib/task-columns.ts`, `lib/attention.ts`, `api/client.ts`,
`api/queries.ts`, `api/global-events.tsx`; add/extend nearby tests.
Modify `packages/cezar/src/server/server.ts` for human relationship read route.

**Interfaces:** `GET /api/v1/p/:projectId/runs/:id/relationships` and its boot alias
return task-1 `RunRelationships`, containing optional parent reference and up to
32 worker references. `useRunRelationships(runId: string)` uses scoped query keys.
`RunRelationshipsPanel({run}: {run: ApiRun})` renders known context plus query state.
No arbitrary per-agent credential is exposed to the browser.

- [x] Write component tests for parent navigation, worker links/statuses, context
  retained while loading/error/offline, unknown/deleted parent and ordinary-run
  no-op. Test all four run-header tabs and project scoping.

```tsx
expect(screen.getByRole('link', { name: /parent task/i })).toHaveAttribute(
  'href', `/p/${projectId}/tasks/${parentId}`,
);
expect(screen.queryByText('No workers')).not.toBeInTheDocument();
```

  Use the existing RunHeader test fixture and scoped router wrappers; error case
  must not render an empty-list message. Ordinary roots without metadata render
  no relationship section.
- [x] Run `npm test -- packages/web/src/routes/task-thread/run-relationships.test.tsx` red.
- [x] Chain the human read route with middleware and exact contract response.
  Query the store by relationship, not a paginated/filtered cockpit list. Render
  a small status/link list with `min-h-11`, accessible names, wrapping and retry.
  Use existing project `Link`; do not create a new route/dashboard.
- [x] Invalidate/patch relationship keys from existing run updates, deletion and
  reconnect; reuse the global stream and no refetchInterval. Add worker label to
  existing list cell without nested anchors or restructuring groups.
- [x] Add attributed transcript handling; agent input never resolves ask cards.
  Add worker-wait status context to attention derivation without treating it as
  a human question. Show incomplete cleanup explicitly. Test old events/records.
- [x] Run scoped UI and server contract/route tests green. Browser observations
  are recorded in task 9, not fabricated from component tests.

## Task 9: Full acceptance, docs verification and draft PR

Execution notes (2026-09-07): the browser filename is `.e2e.ts` because the
existing suite discovers only that suffix. The successful package test uses an
installed release tarball, real Git/store/manager/controller and a Claude
stream-json process fixture. Review assertions explicitly enable the existing
`CEZ_REVIEW_GATE=1`; its default remains off. Current `main` through `ab6d076a`
(v0.11.10) was integrated without an agent-issued commit. The first full browser
attempt escaped its temporary fixture through ambient Git discovery; recovery
autosaved the pending merge as `3e5b6fdf`. The controller retained that tree and
incident history after containment. See the QA report for known effects and
limits. Final gates cover the integrated tree plus the shared pre-spawn fixture
guard and canonical pending-human-ask reducer. The sole monitoring conflict
preserves upstream parent-turn activity recognition for both monitoring and
owned worker waits. Publication remains controller-owned and pending.


**Files:** Extend `packages/cezar/src/delegation/service.test.ts`,
`workflows/worker-wait.test.ts`, `workflows/worker-destroy.test.ts`,
`core/harness-parity.test.ts`, `test/e2e/delegation.test.ts`;
add `packages/web/e2e/worker-relationships.e2e.ts` using the existing provider;
write `.ai/specs/2026-09-06-owned-workers-isolated-worktrees-qa.md` after observations.

- [x] Add a complete parent lifecycle test through the real provisioned CLI:
  spawn pinned worker -> wait/yield -> inspect -> steer -> diff -> stop -> destroy
  -> repeated destroy. Use real temp Git/store/manager and offline runner mocks,
  not a service whose methods only return canned results. Include lost-spawn
  response/idempotency and maxParallel=1. Assert no automatic review acceptance.
- [x] Run this test red if any cross-layer connection is missing, repair the
  smallest boundary and re-run all affected lower-layer tests green.
- [x] Review the source diff against the spec acceptance table. Explicitly check
  inherited env full/passthrough, disabled default, malformed ownership quarantine,
  shutdown vs parent termination, all construction sites, human deletion paths,
  cleanup crash ambiguity and route inventory. Fix gaps with red/green tests.
- [x] Run in order, preserving logs and actual exit codes:

```bash
npm run typecheck
npm test -- --maxWorkers=1
npm run test:unit
npm run build
npm run test:package
```

  Stop on the first failure and load systematic-debugging; no PR on red. Re-run
  affected and full gates after fixes. Do not suppress or reinterpret test output.
- [x] Read `.ai/browsers/agent-browser.md`, then run `npm run test:e2e`. Inspect
  the actual TEST_E2E_STATUS marker; skipped is not passed. Use the healthy
  fixture environment for 360×640 and desktop, light/dark, reduced-motion,
  keyboard, >=44px target checks, loading/error/offline relationships and ask
  preservation. Write observed viewport/theme/results in the QA file; stop
  the fixture environment with `.ai/scripts/test-env-down.sh` when finished.
- [x] Request review according to the selected execution protocol and review
  skill. Resolve findings with evidence. Load verification-before-completion.
- [ ] After the full gate is green, commit the logical change (including spec,
  plan and QA) with `feat(delegation): add owned workers in isolated worktrees`.
  Push `git push -u origin HEAD`.
- [ ] Read this repo's first matching PR template; map all required dev-flow
  fields into it. Include `Closes #111`, concise summary/design/spec reference,
  Experience/QA, exact command-result lines, and explicitly deferred roadmap
  stages. Open **draft**, explicitly `--base main`; never auto-merge or ready it.
- [ ] Emit the new PR reference, move board card to In review, load pr-checks
  and monitor CI/review to verdict in this session. Update rolling handoff at
  milestones. Completion requires verified implementation and CI, not this plan.

## Plan self-review

- Spec coverage: Tasks 1–2 cover persistence/identity/policy; 3 covers committed
  isolation/diffs; 4 covers attributed backend-safe input; 5 covers finite waits,
  admission and recovery; 6 covers cleanup and retention; 7 covers full CLI,
  transport/provisioning/headless and docs; 8 covers cockpit; 9 proves acceptance.
- Limits are concrete: 32 creations per parent, 32 undelivered inputs per worker,
  600-second default wait/1800 cap, 30-second destruction termination wait,
  45-second CLI request bound. Existing request/diff size caps remain load-bearing.
- Wire types are schema-inferred; branded Caller and transport internals are not
  exported API types. Named producer/consumer interfaces are consistent across tasks.
- No task bypasses TDD, ordinary-run guards, full pre-commit gates or human review.
- Spec and sequential task execution were approved. Tasks 1–8 are implemented
  and independently approved; their retained task reports record red/green and
  source-removal evidence. Task 9 implementation and scoped local verification are complete. All five
  ordered gates and eight issue-specific browser cases passed. The full browser
  aggregate retains two baseline failures tracked as #136/#137; no pass is
  inferred from those failures. Final review disposition, commit, draft PR,
  project-board update and CI remain controller-owned.


Consolidated whole-feature review correction (implemented and scoped-reviewed): strict
private execution admission rejects unknown prior generations and retains owned
scratch until proven completion; accepted private identity now requires effective
tool/Bash evidence; nonfinal agent steps use the internal all-runner auto-end veto
through admitted wake replies, preserving human attention and capacity accounting.
The final scoped review found C1/I1/I2 addressed with no introduced findings.
Corrected-source five gates passed; actual browser results are recorded in QA.
The controller approved explicit 30s outer budgets only for the two real-manager
integration suites/their cleanup and three named 32-creation cases; existing
15s state/termination assertions and product timers remain unchanged.
Per the user’s final scope direction, unrelated baseline browser failures are
filed separately as #136/#137, with no further unrelated fix or broad retry.
