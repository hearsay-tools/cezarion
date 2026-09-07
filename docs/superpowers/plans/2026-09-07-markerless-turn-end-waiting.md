# Markerless Turn-End Waiting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and surface `waiting` immediately when an open interactive agent session ends a markerless turn.

**Architecture:** Make each server turn-end park a synchronous persistence boundary after the run and step mutations. Keep the server authoritative in the cockpit: use the transcript's persisted `turn-end` as a stale-cache signal that invalidates run detail and list queries after the existing grace period.

**Tech Stack:** Strict TypeScript, Node 20, Vitest, React 19, TanStack Query.

**Spec:** `.ai/specs/2026-09-07-markerless-turn-end-waiting.md`

## Global Constraints

- Update both turn-end handlers in `packages/cezar/src/workflows/run.ts`.
- Markerless open-session turns become durable run and step `waiting` records before slot release.
- `CEZ:MONITORING` remains `running` with `activity: 'monitoring'`; do not change its timers, wake path, grouping, or attention behavior.
- Keep the existing `STALE_RECORD_GRACE_MS = 2_000` and invalidate both run detail and run list queries.
- The server record remains authoritative; the web healer refetches and never fabricates `waiting` in the cache.
- Add no status, API/event schema, route, environment variable, dependency, or compatibility layer.
- Follow strict TDD: run every new regression test red against the unfixed production code before implementing the corresponding fix.

---

### Task 1: Make Turn-End Parking Durable

**Files:**
- Create: `.ai/specs/2026-09-07-markerless-turn-end-waiting.md`
- Create: `docs/superpowers/plans/2026-09-07-markerless-turn-end-waiting.md`
- Modify: `packages/cezar/src/workflows/run.test.ts`
- Modify: `packages/cezar/src/workflows/run.ts:2401-2487`
- Modify: `packages/cezar/src/workflows/run.ts:3089-3152`

**Interfaces:**
- Consumes: `RunStore.updateRun`, `RunStore.updateStep`, `RunStore.flush`, and the existing `run` event.
- Produces: both turn-end paths synchronously persist a complete parked record before releasing their slot.

- [ ] **Step 1: Add test helpers that observe the real store boundary**

In the existing `CEZ:MONITORING parks as running/monitoring, not waiting (#490)` suite, add a helper that resolves only after the store publishes a run whose run and current step are both `waiting`:

```ts
const publishedWaiting = (id: string): Promise<RunRecord> =>
  new Promise((resolve) => {
    const onRun = (record: RunRecord) => {
      const current = record.steps.find((step) => step.id === record.currentStepId)
      if (record.id !== id || record.status !== 'waiting' || current?.status !== 'waiting') return
      store.off('run', onRun)
      resolve(structuredClone(record))
    }
    store.on('run', onRun)
  })

const persistedRun = (id: string): RunRecord => {
  const records = JSON.parse(readFileSync(join(repoRoot, '.ai/cezar/runs.json'), 'utf8')) as RunRecord[]
  const record = records.find((candidate) => candidate.id === id)
  if (!record) throw new Error(`persisted run ${id} missing`)
  return record
}
```

After awaiting `publishedWaiting`, yield once with `await new Promise<void>((resolve) => setImmediate(resolve))` before reading `runs.json`. This observes synchronous work that follows the event emission while remaining strictly ahead of the store's 300 ms debounce.

- [ ] **Step 2: Write initial-turn regressions for both runner paths**

Save and restore `CEZ_CODEX_BIN` with the suite's other environment variables. Parameterize a test over the bundled dry-run runner and the real Codex app-server fixture:

```ts
it.each([
  { name: 'dry-run runner', runner: undefined, task: 'plain markerless turn' },
  { name: 'Codex app-server', runner: 'codex' as const, task: 'plain markerless Codex turn' },
])('$name publishes and persists a complete waiting record before yielding', async ({ runner, task }) => {
  if (runner === 'codex') {
    process.env.CEZ_CODEX_BIN = join(import.meta.dirname, '../core/__fixtures__/codex/mock-codex-app-server.mjs')
  }
  const record = manager.startRun(SINGLE_STEP, { task, runner, worktree: false })
  currentId = record.id
  const published = await publishedWaiting(record.id)
  await new Promise<void>((resolve) => setImmediate(resolve))

  expect(published).toMatchObject({ status: 'waiting', activity: undefined })
  expect(published.steps.find((step) => step.id === published.currentStepId)?.status).toBe('waiting')
  expect(persistedRun(record.id)).toMatchObject({
    status: 'waiting',
    steps: [expect.objectContaining({ id: 'task', status: 'waiting' })],
  })
})
```

Use an omitted `runner` property rather than passing an explicit `undefined` if the strict input type requires it.

- [ ] **Step 3: Write the continuation-handler regression**

Start a dry-run markerless task and wait for its first park. Flush that known state, register `publishedWaiting`, send a `mock:hold` follow-up, and immediately flush the resumed `running` state while the mock holds its second turn for 250 ms. Then await the second published park and assert that `runs.json` contains `waiting` on both the run and current step:

```ts
const record = manager.startRun(SINGLE_STEP, { task: 'first markerless turn', worktree: false })
currentId = record.id
await waitFor(record.id, (candidate) => candidate?.status === 'waiting')
store.flush()

const published = publishedWaiting(record.id)
expect(manager.sendMessage(record.id, [{ type: 'text', text: 'mock:hold second markerless turn' }])).toBe(true)
store.flush()
await published
await new Promise<void>((resolve) => setImmediate(resolve))

expect(persistedRun(record.id)).toMatchObject({
  status: 'waiting',
  steps: [expect.objectContaining({ id: 'task', status: 'waiting' })],
})
```

- [ ] **Step 4: Run the new server tests and verify RED**

Run:

```bash
npm test -- packages/cezar/src/workflows/run.test.ts -t "publishes and persists|continuation turn persists"
```

Expected: each new persistence assertion fails because `runs.json` still contains the previously flushed `running` record. Confirm the published in-memory record assertions pass, proving the test fails at the missing durability boundary rather than runner wiring.

- [ ] **Step 5: Flush both complete park mutations before slot release**

In each markerless/ask branch, add the synchronous flush after both status mutations and before `waiting.add`, timer setup, and `releaseSlot`:

```ts
this.store.updateRun(runId, { status: 'waiting', activity: undefined })
this.store.updateStep(runId, stepId, { status: 'waiting' })
this.store.flush()
```

Use `step.id` in the initial-step handler. Do not move the flush into the monitoring branch and do not change the earlier continuation-message checkpoint.

- [ ] **Step 6: Run the focused server suite and verify GREEN**

Run:

```bash
npm test -- packages/cezar/src/workflows/run.test.ts
```

Expected: all tests pass, including the existing markerless waiting and `CEZ:MONITORING` guards.

- [ ] **Step 7: Commit the server boundary**

```bash
git add .ai/specs/2026-09-07-markerless-turn-end-waiting.md docs/superpowers/plans/2026-09-07-markerless-turn-end-waiting.md packages/cezar/src/workflows/run.test.ts packages/cezar/src/workflows/run.ts
git commit -m "fix(workflows): persist markerless turn parks"
```

---

### Task 2: Reconcile Parked Transcripts With Stale Run Records

**Files:**
- Modify: `packages/web/src/routes/task-thread/run-reconcile.test.ts`
- Modify: `packages/web/src/routes/task-thread/run-reconcile.ts`

**Interfaces:**
- Consumes: persisted v1 `turn-end`, v2 `turn.started`/`session.started`, agent `step-start`, `user-message`, `ApiRun.activity`, and existing TanStack query keys.
- Produces: `parkedTurnSeq(events: RunEvent[]): number`; the hook invalidates stale plain-running detail/list caches after the existing grace.

- [ ] **Step 1: Write pure park-boundary tests**

Import `parkedTurnSeq` and add tests proving these literal event sequences:

```ts
expect(parkedTurnSeq([line(7, 'turn.completed'), line(8, 'turn-end')])).toBe(8)
expect(parkedTurnSeq([line(8, 'turn-end'), line(9, 'turn.started')])).toBe(0)
expect(parkedTurnSeq([line(8, 'turn-end'), line(9, 'user-message')])).toBe(0)
expect(parkedTurnSeq([line(8, 'turn-end'), line(9, 'step-start', { kind: 'check' })])).toBe(8)
```

An agent `step-start` and `session.started` are also opening boundaries; a check step is not.

- [ ] **Step 2: Write hook regressions for stale, healthy, and monitoring records**

Add tests with fake timers:

```ts
it('a latest parked turn refetches a record still claiming plain running', () => {
  vi.useFakeTimers()
  const { invalidate } = renderReconcile(run(), [line(8, 'turn-end')])
  vi.advanceTimersByTime(STALE_RECORD_GRACE_MS)
  expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.runs.detail('r1') })
  expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.runs.list() })
})

it('the workspace waiting update cancels parked-turn reconciliation', () => {
  vi.useFakeTimers()
  const events = [line(8, 'turn-end')]
  const { rerender, invalidate } = renderReconcile(run(), events)
  rerender({ r: run({ status: 'waiting' }), e: events })
  vi.advanceTimersByTime(STALE_RECORD_GRACE_MS * 2)
  expect(invalidate).not.toHaveBeenCalled()
})

it('a monitoring record is already consistent with a parked turn', () => {
  vi.useFakeTimers()
  const { invalidate } = renderReconcile(run({ activity: 'monitoring' }), [line(8, 'turn-end')])
  vi.advanceTimersByTime(STALE_RECORD_GRACE_MS * 2)
  expect(invalidate).not.toHaveBeenCalled()
})
```

Also rerender a pending stale case with a later `turn.started` and prove the timer is cancelled.

- [ ] **Step 3: Run the new web tests and verify RED**

Run:

```bash
npm test -- packages/web/src/routes/task-thread/run-reconcile.test.ts
```

Expected: the new import fails because `parkedTurnSeq` does not exist. After adding only a temporary test-local declaration if needed to isolate the hook failure, the stale markerless case must still fail because the current hook observes only `session.ended`.

- [ ] **Step 4: Implement the persisted park boundary**

Add the pure helper next to `settledSessionSeq`:

```ts
export function parkedTurnSeq(events: RunEvent[]): number {
  let lastEnd = 0
  let lastOpen = 0
  for (const event of events) {
    if (typeof event.seq !== 'number') continue
    if (event.type === 'turn-end' && event.seq > lastEnd) lastEnd = event.seq
    if (
      (event.type === 'turn.started' ||
        event.type === 'session.started' ||
        event.type === 'user-message' ||
        (event.type === 'step-start' && event.kind === 'agent')) &&
      event.seq > lastOpen
    ) {
      lastOpen = event.seq
    }
  }
  return lastEnd > lastOpen ? lastEnd : 0
}
```

Do not count check steps as session openings.

- [ ] **Step 5: Extend the hook without guessing browser state**

Memoize `parkedTurnSeq(events)`, read `run?.activity`, and schedule the existing invalidations when either condition is true:

```ts
const staleSettled = settledSeq !== 0 && (status === 'running' || status === 'waiting')
const stalePark = parkedSeq !== 0 && status === 'running' && activity !== 'monitoring'
if ((!staleSettled && !stalePark) || runId === undefined) return
```

Use `Math.max(settledSeq, parkedSeq)` or both sequence values in the effect dependency list so a later opening boundary cancels the timer. Keep the timeout and both invalidations unchanged.

- [ ] **Step 6: Run focused web and server guard tests**

Run:

```bash
npm test -- packages/web/src/routes/task-thread/run-reconcile.test.ts packages/cezar/src/workflows/run.test.ts
```

Expected: all tests pass. The server guards prove `CEZ:MONITORING` still parks as running/monitoring; the web tests prove such a record does not enter the stale markerless reconciliation path.

- [ ] **Step 7: Commit the web healer**

```bash
git add packages/web/src/routes/task-thread/run-reconcile.test.ts packages/web/src/routes/task-thread/run-reconcile.ts
git commit -m "fix(web): reconcile markerless parked turns"
```
