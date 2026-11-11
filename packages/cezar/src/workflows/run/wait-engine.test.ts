import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CiWaitResult } from '@open-mercato/cezar-contract/ci-wait';
import type { ProcessWaitResult, Wait } from '@open-mercato/cezar-contract/waits';
import { makeHumanWait, makePeerWait, makePrWait, makeProcessWait, makeSubagentWait, makeTimerWait, makeWorkerWait, RUN_STATUS, STEP_KIND, WAIT_PHASE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import { RunStore } from '../../runs/store.ts';
import { WaitCapacityError } from '../../runs/wait-capacity.ts';
import { createActiveRun } from '../active-run.ts';
import { unused } from '../fixture-no-runner.testkit.ts';
import type { RunModuleContext } from './types.ts';
import { WaitEngine } from './wait-engine.ts';
import { WAIT_KINDS } from './wait-kinds.ts';

const DEADLINE_MS = 60_000;
type Kind = Wait['kind'];
type Fixture = ReturnType<typeof fixture>;

/** A pending watch the test settles: the CI and process supervisors answer through these. */
function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>(resolve => { settle = resolve; });
  return { promise, settle };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cez-wait-engine-'));
  const store = RunStore.open(join(root, '.ai/cezar'));
  const run = store.createRun({ title: 'engine', task: 'work', workflow: 'quick-task', steps: [{ id: 'step', name: 'Step', kind: STEP_KIND.agent }] });
  store.move(run.id, 'start');
  // A live peer: a peer wait on it stays open until its deadline.
  const peer = store.createRun({ title: 'peer', task: 'work', workflow: 'quick-task', steps: [] });
  store.move(peer.id, 'start');
  const ci = deferred<CiWaitResult>();
  const processExit = deferred<ProcessWaitResult>();
  const watchSignals: AbortSignal[] = [];
  const wakes = { count: 0 };
  const context = unused<RunModuleContext>('context', { store, repoRoot: root, dataDir: join(root, '.ai/cezar'), disposed: () => false });
  const host = unused<ConstructorParameters<typeof WaitEngine>[1]>('engine host', {
    active: () => undefined,
    canProceedWithRun: (_id, record): record is NonNullable<typeof record> => record?.status === RUN_STATUS.running,
    ciSupervisor: () => unused<ReturnType<ConstructorParameters<typeof WaitEngine>[1]['ciSupervisor']>>('ci supervisor', { watch: (_request, signal) => { watchSignals.push(signal); return ci.promise; } }),
    // The family reconcile, reduced to what it asks the engine: arm an open worker wait, or
    // resolve it with `timeout` once its deadline passed.
    reconcileWorkerWaits: () => {
      for (const wait of WAIT_KINDS.worker.selectOpen(store.getRun(run.id)?.waits ?? [])) {
        if (Date.parse(wait.deadline!) <= Date.now()) engine.resolveWorkerWait(run.id, wait, { ...wait, result: { reason: 'timeout' } });
        else engine.refresh(run.id, wait, wait);
      }
    },
    noticeParkedWorkers: vi.fn(),
    withdrawCezarHumanWaits: vi.fn(),
    isParked: vi.fn(() => false),
    parkOnWaits: vi.fn(),
    subagentSessionLive: () => true,
    countAutomaticWakes: () => wakes.count,
    wakeCapReached: vi.fn(),
    queueWaitWake: vi.fn(),
    abortRegistrations: vi.fn(),
    forgetWakes: vi.fn(),
  });
  const supervisor = unused<ConstructorParameters<typeof WaitEngine>[3] & object>('process supervisor', { watch: (_request, signal) => { watchSignals.push(signal); return processExit.promise; }, close: () => {} });
  const engine = new WaitEngine(context, host, 10, supervisor);
  return { root, store, run, peer, host, engine, ci, processExit, watchSignals, wakes };
}

/** Each kind's entry, and how its own watch resolves it. A new kind fails typecheck here. */
const KINDS: { readonly [K in Kind]: { entry: (f: Fixture) => Wait; resolve: (f: Fixture, wait: Wait) => Promise<void> } } = {
  pr: { entry: () => makePrWait({ deadline: deadline() }),
    resolve: async (f, wait) => { f.ci.settle({ outcome: 'passed', headSha: (wait as ReturnType<typeof makePrWait>).headSha, observedAt: new Date().toISOString(), checks: [], totalChecks: 0, truncated: false }); await vi.advanceTimersByTimeAsync(0); } },
  timer: { entry: () => makeTimerWait({ deadline: deadline(), via: WAIT_VIA.cezar_wait }), resolve: passDeadline },
  process: { entry: () => makeProcessWait({ deadline: deadline() }),
    resolve: async f => { f.processExit.settle({ outcome: 'exited', observedAt: new Date().toISOString() }); await vi.advanceTimersByTimeAsync(0); } },
  human: { entry: () => makeHumanWait(), resolve: async (f, wait) => { f.engine.resolveWait(f.run.id, wait.id); } },
  worker: { entry: () => makeWorkerWait({ deadline: deadline() }), resolve: passDeadline },
  peer: { entry: f => makePeerWait({ deadline: deadline(), peerIds: [f.peer.id] }), resolve: passDeadline },
  subagent: { entry: () => makeSubagentWait({ deadline: deadline() }), resolve: passDeadline },
};

function deadline(): string { return new Date(Date.now() + DEADLINE_MS).toISOString(); }
async function passDeadline(): Promise<void> { await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1); }
const stored = (f: Fixture, id: string) => [...f.store.getRun(f.run.id)?.waits ?? [], ...f.store.getRun(f.run.id)?.lastWaits ?? []].find(wait => wait.id === id);

let current: Fixture | undefined;
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });
afterEach(async () => {
  vi.useRealTimers();
  if (current) { current.engine.dispose(); current.store.flush(); await current.store.factsWarmIdle(); current.store.close(); rmSync(current.root, { recursive: true, force: true }); }
  current = undefined;
});

it('has a table case for every wait kind', () => {
  expect(Object.keys(KINDS).sort()).toEqual(Object.keys(WAIT_KINDS).sort());
});

it.each(Object.keys(WAIT_KINDS) as Kind[])('%s: opens, then its watch resolves it and queues the wake', async kind => {
  const f = current = fixture();
  const wait = KINDS[kind].entry(f);
  const opened = f.engine.open(f.run.id, undefined, wait, { withdraw: false, park: false });
  expect(opened).toMatchObject({ status: 'opened', wait: { id: wait.id, kind, phase: WAIT_PHASE.open } });
  expect(stored(f, wait.id)?.phase).toBe(WAIT_PHASE.open);
  await KINDS[kind].resolve(f, wait);
  expect(stored(f, wait.id)?.phase).toBe(WAIT_PHASE.resolved);
  expect(f.host.queueWaitWake).toHaveBeenCalledWith(f.run.id);
});

it.each(Object.keys(WAIT_KINDS) as Kind[])('%s: a cancelled wait stays cancelled when its watch would have fired', async kind => {
  const f = current = fixture();
  const wait = KINDS[kind].entry(f);
  f.engine.open(f.run.id, undefined, wait, { withdraw: false, park: false });
  expect(f.engine.cancel(f.run.id, [wait.id])).toMatchObject([{ id: wait.id, phase: WAIT_PHASE.cancelled }]);
  // Cancel disarms the watch the row named: no deadline timer stays, and a watch's signal aborts.
  expect(vi.getTimerCount()).toBe(0);
  expect(f.watchSignals.every(signal => signal.aborted)).toBe(true);
  if (kind !== 'human') await KINDS[kind].resolve(f, wait);
  expect(stored(f, wait.id)?.phase).toBe(WAIT_PHASE.cancelled);
  expect(f.host.queueWaitWake).not.toHaveBeenCalled();
});

/** The open steps each registration path chooses: withdraw, receipt, park and the commit policy. */
it.each([
  { name: 'withdraw: true withdraws Cezar\'s human waits before the commit', withdraw: true },
  { name: 'withdraw: false leaves them', withdraw: false },
])('$name', ({ withdraw }) => {
  const f = current = fixture();
  const commit = vi.spyOn(f.store, 'commitWait');
  f.engine.open(f.run.id, undefined, makeTimerWait({ deadline: deadline() }), { withdraw, park: false });
  if (!withdraw) { expect(f.host.withdrawCezarHumanWaits).not.toHaveBeenCalled(); return; }
  expect(f.host.withdrawCezarHumanWaits).toHaveBeenCalledWith(f.run.id);
  expect(vi.mocked(f.host.withdrawCezarHumanWaits).mock.invocationCallOrder[0]).toBeLessThan(commit.mock.invocationCallOrder[0]!);
});

it('a receipt commits with the wait', () => {
  const f = current = fixture();
  const wait = makeTimerWait({ deadline: deadline() });
  f.engine.open(f.run.id, undefined, wait, { withdraw: false, receipt: { operationId: '6b1f2a3c-4d5e-4f60-8a71-92b3c4d5e6f7', requestHash: 'a'.repeat(64) }, park: false });
  expect(f.store.getRun(f.run.id)?.waitRegistrations).toMatchObject([{ operationId: '6b1f2a3c-4d5e-4f60-8a71-92b3c4d5e6f7', requestHash: 'a'.repeat(64), wait: { id: wait.id } }]);
});

it.each([true, false])('park: %s parks a parked run on its waits only when asked', park => {
  const f = current = fixture();
  vi.mocked(f.host.isParked).mockReturnValue(true);
  const state = createActiveRun({ cwd: f.root, pendingHumanAsk: false, autonomous: false });
  f.engine.open(f.run.id, state, makeTimerWait({ deadline: deadline() }), { withdraw: false, park });
  if (park) expect(f.host.parkOnWaits).toHaveBeenCalledWith(f.run.id, state);
  else expect(f.host.parkOnWaits).not.toHaveBeenCalled();
});

const failures = { capacity: () => new WaitCapacityError(), other: () => new Error('disk full') };
it.each([
  { policy: undefined, failure: 'other', outcome: { throws: 'disk full' } },
  { policy: 'persistence', failure: 'other', outcome: { code: 'persistence' } },
  { policy: 'persistence', failure: 'capacity', outcome: { code: 'capacity' } },
  { policy: { log: '[cez] test checkpoint failed' }, failure: 'other', outcome: { warns: '[cez] test checkpoint failed: disk full' } },
  { policy: { capacity: () => new Error('path refusal') }, failure: 'capacity', outcome: { throws: 'path refusal' } },
  { policy: { capacity: () => new Error('path refusal') }, failure: 'other', outcome: { throws: 'disk full' } },
] as const)('onCommitFailure $policy on a $failure error', ({ policy, failure, outcome }) => {
  const f = current = fixture();
  vi.spyOn(f.store, 'commitWait').mockImplementation(() => { throw failures[failure](); });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const wait = makeTimerWait({ deadline: deadline() });
  const timers = vi.getTimerCount();
  const open = () => f.engine.open(f.run.id, undefined, wait, { withdraw: false, park: false, ...(policy ? { onCommitFailure: policy } : {}) });
  if ('warns' in outcome) {
    expect(open()).toEqual({ status: 'refused' });
    expect(warn).toHaveBeenCalledWith(outcome.warns);
  } else if ('code' in outcome) expect(open).toThrow(expect.objectContaining({ code: outcome.code }));
  else expect(open).toThrow(outcome.throws);
  // A failed commit arms nothing.
  expect(vi.getTimerCount()).toBe(timers);
});

it('a wake the budget cannot pay cancels at the cap instead of queueing', async () => {
  const f = current = fixture();
  f.wakes.count = 10;
  const wait = makeTimerWait({ deadline: deadline() });
  f.engine.open(f.run.id, undefined, wait, { withdraw: false, park: false });
  await passDeadline();
  expect(f.host.wakeCapReached).toHaveBeenCalledWith(f.run.id, [expect.objectContaining({ id: wait.id, phase: WAIT_PHASE.open })], undefined);
  expect(f.host.queueWaitWake).not.toHaveBeenCalled();
});

it('refresh with a moved deadline re-arms the new deadline only', async () => {
  const f = current = fixture();
  const wait = makeSubagentWait({ deadline: deadline() });
  f.engine.open(f.run.id, undefined, wait, { withdraw: false, park: false });
  expect(f.engine.refresh(f.run.id, wait, { ...wait, deadline: new Date(Date.now() + 2 * DEADLINE_MS).toISOString() })).toBe(true);
  await passDeadline();
  expect(stored(f, wait.id)?.phase).toBe(WAIT_PHASE.open);
  await passDeadline();
  expect(stored(f, wait.id)?.phase).toBe(WAIT_PHASE.resolved);
});

it('refresh whose commit fails under a log policy keeps the saved wait and its deadline', async () => {
  const f = current = fixture();
  const wait = makeSubagentWait({ deadline: deadline() });
  f.engine.open(f.run.id, undefined, wait, { withdraw: false, park: false });
  vi.spyOn(f.store, 'commitWait').mockImplementationOnce(() => { throw new Error('disk full'); });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(f.engine.refresh(f.run.id, wait, { ...wait, deadline: new Date(Date.now() + 2 * DEADLINE_MS).toISOString() }, { log: '[cez] refresh failed' })).toBe(false);
  expect(warn).toHaveBeenCalledWith('[cez] refresh failed: disk full');
  expect(stored(f, wait.id)).toMatchObject({ deadline: wait.deadline });
  await passDeadline();
  expect(stored(f, wait.id)?.phase).toBe(WAIT_PHASE.resolved);
});

it('refresh with an unchanged deadline commits the entry and keeps the armed deadline', async () => {
  const f = current = fixture();
  const wait = makeWorkerWait({ deadline: deadline() });
  f.engine.open(f.run.id, undefined, wait, { withdraw: false, park: false });
  const timers = vi.getTimerCount();
  const next = { ...wait, revisions: [{ workerId: wait.workerIds![0]!, revision: 1 }] };
  expect(f.engine.refresh(f.run.id, wait, next)).toBe(true);
  expect(stored(f, wait.id)).toMatchObject({ revisions: next.revisions });
  expect(vi.getTimerCount()).toBe(timers);
});

it.each([
  { name: 'the result it holds', result: { outcome: 'exited', observedAt: '2026-11-10T00:00:00.000Z' } as const, expected: { outcome: 'exited' } },
  { name: 'the row default when it holds none', result: undefined, expected: { outcome: 'deadline' } },
])('open with a result resolves with $name and arms no watch', ({ result, expected }) => {
  const f = current = fixture();
  const wait = makeProcessWait({ deadline: deadline() });
  const opened = f.engine.open(f.run.id, undefined, wait, { withdraw: false, park: false, result });
  expect(opened).toMatchObject({ status: 'opened', wait: { id: wait.id, phase: WAIT_PHASE.open } });
  expect(stored(f, wait.id)).toMatchObject({ phase: WAIT_PHASE.resolved, result: expected });
  expect(f.watchSignals).toEqual([]);
  expect(f.host.queueWaitWake).toHaveBeenCalledWith(f.run.id);
});
