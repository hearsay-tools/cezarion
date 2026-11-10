import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CiWaitResult } from '@open-mercato/cezar-contract/ci-wait';
import type { ProcessWaitResult, Wait } from '@open-mercato/cezar-contract/waits';
import { makeHumanWait, makePeerWait, makePrWait, makeProcessWait, makeSubagentWait, makeTimerWait, makeWorkerWait, RUN_STATUS, STEP_KIND, WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';
import { RunStore } from '../../runs/store.ts';
import { unused } from '../fixture-cleanup.testkit.ts';
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
  const context = unused<RunModuleContext>('context', { store, repoRoot: root, dataDir: join(root, '.ai/cezar'), disposed: () => false });
  const host = unused<ConstructorParameters<typeof WaitEngine>[1]>('engine host', {
    active: () => undefined,
    canProceedWithRun: (_id, record): record is NonNullable<typeof record> => record?.status === RUN_STATUS.running,
    ciSupervisor: () => unused('ci supervisor', { watch: (_request, signal) => { watchSignals.push(signal); return ci.promise; } }),
    // The family reconcile, reduced to what it asks the engine: arm an open worker wait, or
    // resolve it with `timeout` once its deadline passed.
    reconcileWorkerWaits: () => {
      for (const wait of WAIT_KINDS.worker.selectOpen(store.getRun(run.id)?.waits ?? [])) {
        if (Date.parse(wait.deadline!) <= Date.now()) engine.resolveWorkerWait(run.id, wait, { ...wait, result: { reason: 'timeout' } });
        else engine.armWait(run.id, wait);
      }
    },
    noticeParkedWorkers: vi.fn(),
    subagentSessionLive: () => true,
    countAutomaticWakes: () => 0,
    queueWaitWake: vi.fn(),
    abortRegistrations: vi.fn(),
    forgetWakes: vi.fn(),
  });
  const supervisor = unused<ConstructorParameters<typeof WaitEngine>[3] & object>('process supervisor', { watch: (_request, signal) => { watchSignals.push(signal); return processExit.promise; }, close: () => {} });
  const engine = new WaitEngine(context, host, 10, supervisor);
  return { root, store, run, peer, host, engine, ci, processExit, watchSignals };
}

/** Each kind's entry, and how its own watch resolves it. A new kind fails typecheck here. */
const KINDS: { readonly [K in Kind]: { entry: (f: Fixture) => Wait; resolve: (f: Fixture, wait: Wait) => Promise<void> } } = {
  pr: { entry: () => makePrWait({ deadline: deadline() }),
    resolve: async (f, wait) => { f.ci.settle({ outcome: 'passed', headSha: (wait as ReturnType<typeof makePrWait>).headSha, observedAt: new Date().toISOString(), checks: [], totalChecks: 0, truncated: false }); await vi.advanceTimersByTimeAsync(0); } },
  timer: { entry: () => makeTimerWait({ deadline: deadline(), via: 'cezar_wait' }), resolve: passDeadline },
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
