import { fireCapturedTimer } from './waits.testkit.ts';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WAIT_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { RunStore } from '../runs/store.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { manager, parent, restart, root, store, until, useWorkerWaitFixture, worker } from './worker-wait.testkit.ts';

import { handlers, entryOf, settledOf } from './worker-waits-shared.testkit.ts';

/**
 * A human message beside an owed wait of any kind (hearsay-tools/cezarion#1235): withdrawing
 * nothing, it is accepted durably, and on a queued wake continuation it becomes the human's opening
 * while the wake's text stays, so the owed result still reaches the agent.
 */
describe('human messages beside an owed timer wait', { timeout: 45_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => vi.restoreAllMocks());

  /** A parent whose timer comes due after a restart, queued behind a worker that holds the one slot.
   *  The timer fires once the worker has the slot: a wake already in the line would go ahead of a
   *  worker that has not started (hearsay-tools/cezarion#1236). */
  async function queuedTimerWake() {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const blocker = await worker(p.id, 'mock:slow');
    const answer = (await handlers(p.id).registerWait({ kind: WAIT_KIND.timer, seconds: 60, note: 'owed' }, 'cezar_wait', new AbortController().signal)).answer;
    if (!answer.ok) throw Error('refused');
    const timer = entryOf(p.id, answer.wait_id)!;
    if (timer.kind === 'human') throw Error('unexpected human wait');
    await restart();
    await until(() => {
      return (manager as unknown as { active: Map<string, { liveSession: { sessionEverOpened?: boolean; };  }> }).active.get(blocker.id)?.liveSession.sessionEverOpened === true;
    });
    fireCapturedTimer(timer.id);
    await until(() => store.getRun(p.id)?.status === 'queued');
    expect(entryOf(p.id, timer.id)?.phase).toBe('resolved');
    return { p, blocker, timer };
  }

  it('a queued human message opens the timer wake as the human\'s, durably, and the timer result still arrives', async () => {
    const { p, blocker, timer } = await queuedTimerWake();
    const opening = store.getRun(p.id)?.continuationMessage;
    expect(opening).toMatchObject({ origin: 'lifecycle' });
    expect(manager.enqueueMessage(p.id, [{ type: 'text', text: 'human update beside the timer' }])).toBeTruthy();
    expect(store.getRun(p.id)?.continuationMessage).toMatchObject({ origin: 'human', text: opening!.text });
    expect(entryOf(p.id, timer.id)?.phase).toBe('resolved');
    store.flush();
    const reopened = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    expect(reopened.getRun(p.id)?.queuedMessages?.at(-1)?.text).toBe('human update beside the timer');
    expect(reopened.getRun(p.id)?.continuationMessage?.origin).toBe('human'); reopened.flush();
    manager.cancel(blocker.id);
    await until(() => store.readEvents(p.id).some(event => event.type === 'user-message' && String(event.text).includes('human update beside the timer')));
    await until(() => settledOf(p.id, timer.id)?.phase === 'delivered');
  });

  it('a startup human message beside an owed timer wait survives a crash before its delivery', async () => {
    const { p, blocker, timer } = await queuedTimerWake();
    const engine = manager as unknown as { agentEnvForStep(id: string, ...args: unknown[]): Promise<unknown> };
    const real = engine.agentEnvForStep.bind(manager);
    let release!: () => void; let entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    engine.agentEnvForStep = async (id, ...args) => {
      if (id === p.id) { entered = true; await gate; }
      return real(id, ...args);
    };
    manager.cancel(blocker.id); await until(() => entered);
    let checkpoint: unknown[];
    try {
      expect(manager.deferMessage(p.id, [{ type: 'text', text: 'startup update beside the timer' }])).toBe(true);
      expect(entryOf(p.id, timer.id)?.phase).toBe('resolved');
      expect(store.getRun(p.id)?.queuedMessages?.at(-1)?.text).toBe('startup update beside the timer');
      store.flush(); checkpoint = readPersistedRuns(join(root, '.ai/cezar'));
    } finally { release(); }
    await until(() => store.readEvents(p.id).some(event => event.type === 'user-message' && String(event.text).includes('startup update beside the timer')));
    const eventStart = store.readEvents(p.id).length;
    await restart(false, checkpoint!);
    // Replayed exactly once from the durable record.
    await until(() => store.readEvents(p.id).slice(eventStart).some(event => event.type === 'user-message' && String(event.text).includes('startup update beside the timer')));
    expect(store.readEvents(p.id).slice(eventStart).filter(event => event.type === 'user-message')
      .flatMap(event => String(event.text).match(/startup update beside the timer/g) ?? [])).toHaveLength(1);
  });
});
