import { describe, expect, it, onTestFinished } from 'vitest';
import { makeRunRecord, makeTimerWait, RUN_STATUS, WAIT_KIND, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunStore } from '../runs/store.ts';
import type { RunManager } from './run.ts';
import { unused } from './fixture-no-runner.testkit.ts';
import { fireCapturedTimer, observeWaitTimers } from './waits.testkit.ts';

describe('owned wait timer identity', () => {
  it('binds a later identical registration to the returned wait instead of the earlier turn', async () => {
    const now = Date.now();
    const earlier = makeTimerWait({ id: 'earlier', seconds: 120, note: 'check', turnId: 'turn-1', deadline: new Date(now + 60_000).toISOString() });
    const later = makeTimerWait({ id: 'later', seconds: 120, note: 'check', turnId: 'turn-2', deadline: new Date(now + 120_000).toISOString() });
    const run = makeRunRecord({ waits: [earlier] });
    const fired: string[] = [];
    const manager = unused<RunManager>('manager', {
      registerWait: async () => {
        later.deadline = new Date(Date.now() + later.seconds * 1000).toISOString();
        run.waits!.push(later);
        const persistence = setTimeout(() => {}, 300);
        onTestFinished(() => clearTimeout(persistence));
        setTimeout(() => fired.push(later.id), Date.parse(later.deadline) - Date.now());
        return later;
      },
      recover: async () => {},
    });
    const store = unused<RunStore>('store', { getRun: () => run });
    observeWaitTimers(manager, store);
    const registered = await manager.registerWait(run.id, { kind: WAIT_KIND.timer, seconds: 120, note: 'check' }, WAIT_VIA.cezar_wait, 'generation');
    expect(registered.id).toBe(later.id);
    fireCapturedTimer(registered.id);
    expect(fired).toEqual([later.id]);
  });

  it('rejects two matching delays in one registration instead of choosing one', async () => {
    const wait = makeTimerWait({ seconds: 120 });
    const manager = unused<RunManager>('manager', {
      registerWait: async () => {
        setTimeout(() => {}, 120_000);
        setTimeout(() => {}, 120_000);
        return wait;
      },
      recover: async () => {},
    });
    observeWaitTimers(manager, unused<RunStore>('store'));
    await expect(manager.registerWait('run', { kind: WAIT_KIND.timer, seconds: 120 }, WAIT_VIA.cezar_wait, 'generation'))
      .rejects.toThrow('ambiguous wait timer');
  });

  it('rejects equal recovery deadlines before enumeration can bind the wrong timer', async () => {
    const deadline = new Date(Date.now() + 120_000).toISOString();
    const a = makeTimerWait({ id: 'wait-A', deadline });
    const b = makeTimerWait({ id: 'wait-B', deadline });
    const runs = [makeRunRecord({ id: 'A', status: RUN_STATUS.waiting, waits: [a] }), makeRunRecord({ id: 'B', status: RUN_STATUS.waiting, waits: [b] })];
    let recoveries = 0;
    const manager = unused<RunManager>('manager', {
      registerWait: async () => a,
      recover: async () => {
        recoveries++;
        for (const wait of [b, a]) setTimeout(() => {}, Date.parse(wait.deadline) - Date.now());
      },
    });
    const store = unused<RunStore>('store', { listRunIds: () => ['A', 'B'], getRun: id => runs.find(run => run.id === id) });
    observeWaitTimers(manager, store);
    await expect(manager.recover()).rejects.toThrow('ambiguous recovered timer: give recovered waits distinct deadlines');
    expect(recoveries).toBe(0);
  });

  it('binds distinct recovery deadlines independently of the store enumeration order', async () => {
    const now = Date.now();
    const a = makeTimerWait({ id: 'wait-A', deadline: new Date(now + 120_000).toISOString() });
    const b = makeTimerWait({ id: 'wait-B', deadline: new Date(now + 180_000).toISOString() });
    const runs = [makeRunRecord({ id: 'A', status: RUN_STATUS.waiting, waits: [a] }), makeRunRecord({ id: 'B', status: RUN_STATUS.waiting, waits: [b] })];
    const fired: string[] = [];
    const manager = unused<RunManager>('manager', {
      registerWait: async () => a,
      recover: async () => {
        for (const wait of [b, a]) setTimeout(() => fired.push(wait.id), Date.parse(wait.deadline) - Date.now());
      },
    });
    const store = unused<RunStore>('store', { listRunIds: () => ['A', 'B'], getRun: id => runs.find(run => run.id === id) });
    observeWaitTimers(manager, store);
    await manager.recover();
    fireCapturedTimer(a.id);
    expect(fired).toEqual([a.id]);
    fireCapturedTimer(b.id);
    expect(fired).toEqual([a.id, b.id]);
  });
});
