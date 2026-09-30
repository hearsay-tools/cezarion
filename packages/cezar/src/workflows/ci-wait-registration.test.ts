import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CiWatcherSupervisor } from '../ci-wait/supervisor.ts';
import { manager, store, root, parent, controlledWire, until, useWorkerWaitFixture } from './worker-wait.testkit.ts';
import type { RunRecord } from '../runs/store.ts';

const pr = 'https://github.com/acme/repo/pull/12';
const identity = { prUrl: pr, repository: 'acme/repo', prNumber: 12, headSha: 'a'.repeat(40) };
const codes = ['manager_disposed', 'capability_revoked', 'run_missing', 'run_not_running', 'run_stopping',
  'session_replaced', 'session_closed', 'run_cancelled', 'finish_requested', 'generation_mismatch',
  'human_ask_pending', 'human_ask_unanswered', 'worker_execution_stopped', 'root_finish_pending'] as const;

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
      hasUnansweredHumanAsk(id: string): boolean; workerExecutionStopped(id: string): boolean;
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
    const call = () => manager.registerCiWait(run.id, { pr, timeout_seconds: 30 }, previous.ciGeneration as string, capability.signal);
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
        case 'human_ask_pending': state.pendingHumanAsk = true; break;
        case 'human_ask_unanswered': vi.spyOn(engine, 'hasUnansweredHumanAsk').mockReturnValue(true); break;
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
    expect(store.getRun(run.id)?.ciWait).toBeUndefined();
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
      ciRegistrations: Map<string, { abort: AbortController }>;
    };
    const state = engine.active.get(run.id)!;
    const previousTurn = state.ciTurnId;
    const capability = new AbortController();
    let fail!: (reason: Error) => void;
    vi.spyOn(CiWatcherSupervisor.prototype, 'resolve').mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const pending = manager.registerCiWait(run.id, { pr, timeout_seconds: 30 }, state.ciGeneration, capability.signal);
    const assertion = expect(pending).rejects.toMatchObject({ code });
    try {
      if (code === 'registration_aborted') engine.ciRegistrations.get(run.id)!.abort.abort();
      else if (code === 'turn_changed') state.ciTurnId = 'next-turn';
      else capability.abort();
      fail(new Error('lookup aborted'));
      await assertion;
      expect(store.getRun(run.id)?.ciWait).toBeUndefined();
    } finally { state.ciTurnId = previousTurn; writeFileSync(gate, ''); }
  });
});
