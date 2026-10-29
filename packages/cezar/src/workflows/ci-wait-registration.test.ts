import { runInternals } from './run-internals.testkit.ts';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CiWatcherSupervisor } from '../ci-wait/supervisor.ts';
import { manager, store, root, parent, controlledWire, until, useWorkerWaitFixture } from './worker-wait.testkit.ts';
import type { RunRecord } from '../runs/store.ts';

const pr = 'https://github.com/acme/repo/pull/12';
const identity = { prUrl: pr, repository: 'acme/repo', prNumber: 12, headSha: 'a'.repeat(40) };
const ciWaitOf = (id: string) => store.getRun(id)?.waits?.find(entry => entry.kind === 'pr');
// hearsay-tools/cezarion#1233 dropped `human_ask_pending` and `human_ask_unanswered`: a wait now
// registers under a pending question, which outranks it in `waitingOn` (pinned below).
const codes = ['manager_disposed', 'capability_revoked', 'run_missing', 'run_not_running', 'run_stopping',
  'session_replaced', 'session_closed', 'run_cancelled', 'finish_requested', 'generation_mismatch',
  'worker_execution_stopped', 'root_finish_pending'] as const;

describe('CI registration guards before and after metadata lookup', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => vi.restoreAllMocks());
  it.each(codes.flatMap(code => [false, true].map(duringLookup => ({ code, duringLookup }))))
  ('$code duringLookup=$duringLookup returns its blocking state without persisting a wait', async ({ code, duringLookup }) => {
    const gate = join(root, 'end-turn');
    const wire = controlledWire({ firstResultGate: gate });
    const run = await parent(); await until(wire.initialReceived);
    const engine = manager as unknown as {
      disposed: boolean; active: Map<string, Record<string, unknown>>;
      workerExecutionStopped(id: string): boolean;
      executionBlockedByRootFinish(run: RunRecord): boolean;
    };
    const state = engine.active.get(run.id)!;
    const previous = { ...state };
    const capability = new AbortController();
    let finish!: () => void;
    const resolve = vi.spyOn(CiWatcherSupervisor.prototype, 'resolve').mockImplementation(async () => {
      if (duringLookup) await new Promise<void>(done => { finish = done; });
      return identity;
    });
    vi.spyOn(CiWatcherSupervisor.prototype, 'watch').mockReturnValue(new Promise(() => {}));
    const call = () => manager.registerWait(run.id, { kind: 'pr', pr, timeout_seconds: 30 }, 'cezar_wait', previous.ciGeneration as string, capability.signal);
    // Attach the rejection assertion before releasing the pending operation.
    const pending = duringLookup ? call() : undefined;
    const assertion = pending ? expect(pending).rejects.toMatchObject({ code }) : undefined;
    if (duringLookup) await until(() => !!finish);
    const readRun = store.getRun.bind(store);
    try {
      switch (code) {
        case 'manager_disposed': engine.disposed = true; break;
        case 'capability_revoked': capability.abort(); break;
        case 'run_missing': vi.spyOn(store, 'getRun').mockImplementation(id => id === run.id ? undefined : readRun(id)); break;
        case 'run_not_running': vi.spyOn(store, 'getRun').mockImplementation(id => id === run.id ? { ...readRun(id)!, status: 'review' } : readRun(id)); break;
        case 'run_stopping': vi.spyOn(store, 'getRun').mockImplementation(id => id === run.id ? { ...readRun(id)!, stopping: true } : readRun(id)); break;
        case 'session_replaced': engine.active.set(run.id, { ...state }); if (!duringLookup) engine.active.delete(run.id); break;
        case 'session_closed': state.session = { open: false }; break;
        case 'run_cancelled': state.cancelled = true; break;
        case 'finish_requested': state.finishRequested = true; break;
        case 'generation_mismatch': state.ciGeneration = 'replaced'; break;
        case 'worker_execution_stopped': vi.spyOn(engine, 'workerExecutionStopped').mockReturnValue(true); break;
        case 'root_finish_pending': vi.spyOn(engine, 'executionBlockedByRootFinish').mockReturnValue(true); break;
      }
      if (pending) { finish(); await assertion; }
      else await expect(call()).rejects.toMatchObject({ code });
      if (!duringLookup) expect(resolve).not.toHaveBeenCalled();
    } finally {
      engine.disposed = false;
      engine.active.set(run.id, state);
      for (const key of Object.keys(state)) if (!(key in previous)) delete state[key];
      Object.assign(state, previous);
      vi.restoreAllMocks();
      writeFileSync(gate, '');
    }
    expect(ciWaitOf(run.id)).toBeUndefined();
  });

  it('registers CI and a timer with an unanswered human question in the record', async () => {
    const gate = join(root, 'end-turn');
    const wire = controlledWire({ firstResultGate: gate });
    const run = await parent(); await until(wire.initialReceived);
    const engine = manager as unknown as { active: Map<string, Record<string, unknown>> };
    const state = engine.active.get(run.id)!;
    vi.spyOn(CiWatcherSupervisor.prototype, 'resolve').mockResolvedValue(identity);
    vi.spyOn(CiWatcherSupervisor.prototype, 'watch').mockReturnValue(new Promise(() => {}));
    store.appendEvent(run.id, { type: 'ask.requested', requestId: 'unanswered-question', questions: [{ header: 'Review', question: 'Approve?' }] });
    try {
      const ci = await manager.registerWait(run.id, { kind: 'pr', pr, timeout_seconds: 30 }, 'cezar_wait', state.ciGeneration as string);
      const timer = await manager.registerWait(run.id, { kind: 'timer', seconds: 60 }, 'cezar_wait', state.ciGeneration as string);
      expect(store.getRun(run.id)?.waits?.map(wait => wait.id)).toEqual([ci.id, timer.id]);
    } finally { vi.restoreAllMocks(); writeFileSync(gate, ''); }
  });
});

// hearsay-tools/cezarion#1425: a checks wait never stands in for a merge wait on the same PR.
describe('PR wait targets', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => vi.restoreAllMocks());
  it('opens a checks wait and a merge wait on one PR as two waits, and shares one lookup for a repeat', async () => {
    const gate = join(root, 'end-turn');
    const wire = controlledWire({ firstResultGate: gate });
    const run = await parent(); await until(wire.initialReceived);
    const state = (manager as unknown as { active: Map<string, Record<string, unknown>> }).active.get(run.id)!;
    let lookups = 0;
    let release!: () => void;
    vi.spyOn(CiWatcherSupervisor.prototype, 'resolve').mockImplementation(async () => { lookups++; await new Promise<void>(done => { release = done; }); return identity; });
    const watched: unknown[] = [];
    vi.spyOn(CiWatcherSupervisor.prototype, 'watch').mockImplementation(wait => { watched.push(wait); return new Promise(() => {}); });
    try {
      const generation = state.ciGeneration as string;
      const checks = manager.registerWait(run.id, { kind: 'pr', pr }, 'cezar_wait', generation);
      await until(() => lookups === 1); release();
      const first = await checks;
      const merges = [0, 1].map(() => manager.registerWait(run.id, { kind: 'pr', pr, until: 'merge', wake_on_conflict: false }, 'cezar_wait', generation));
      await until(() => lookups === 2); release();
      const [merge, repeat] = await Promise.all(merges);
      expect(lookups).toBe(2);
      expect(repeat!.id).toBe(merge!.id);
      expect(merge!.id).not.toBe(first.id);
      expect(store.getRun(run.id)?.waits).toEqual([
        expect.objectContaining({ id: first.id, kind: 'pr', until: 'checks', wakeOnConflict: true }),
        expect.objectContaining({ id: merge!.id, kind: 'pr', until: 'merge', wakeOnConflict: false }),
      ]);
      expect(watched).toEqual([expect.objectContaining({ until: 'checks', wakeOnConflict: true }), expect.objectContaining({ until: 'merge', wakeOnConflict: false })]);
    } finally { vi.restoreAllMocks(); writeFileSync(gate, ''); }
  });
});

describe('CI metadata lookup interruption', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => vi.restoreAllMocks());
  it.each(['registration_aborted', 'turn_changed', 'capability_revoked'] as const)
  ('reports %s even if the interrupted lookup rejects', async code => {
    const gate = join(root, 'end-turn');
    const wire = controlledWire({ firstResultGate: gate });
    const run = await parent(); await until(wire.initialReceived);
    const engine = manager as unknown as {
      active: Map<string, { ciGeneration: string; ciTurnId: string }>;
    };
    const state = engine.active.get(run.id)!;
    const previousTurn = state.ciTurnId;
    const capability = new AbortController();
    let fail!: (reason: Error) => void;
    vi.spyOn(CiWatcherSupervisor.prototype, 'resolve').mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const pending = manager.registerWait(run.id, { kind: 'pr', pr, timeout_seconds: 30 }, 'cezar_wait', state.ciGeneration, capability.signal);
    const assertion = expect(pending).rejects.toMatchObject({ code });
    try {
      // Keyed by run and normalised PR URL since hearsay-tools/cezarion#1233.
      if (code === 'registration_aborted') [...runInternals(manager).waitRegistry.ciRegistrations.values()].find(entry => entry.runId === run.id)!.abort.abort();
      else if (code === 'turn_changed') state.ciTurnId = 'next-turn';
      else capability.abort();
      fail(new Error('lookup aborted'));
      await assertion;
      expect(ciWaitOf(run.id)).toBeUndefined();
    } finally { state.ciTurnId = previousTurn; writeFileSync(gate, ''); }
  });
});
