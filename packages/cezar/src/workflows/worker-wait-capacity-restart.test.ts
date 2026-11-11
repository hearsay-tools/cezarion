import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { manager, parent, queuedWake, restart, store, until, worker } from './worker-wait-claude.testkit.ts';
import { useWorkerCapacityFixture } from './worker-wait-capacity.testkit.ts';

describe("worker waits through RunManager", { timeout: 30_000 }, () => {
  useWorkerCapacityFixture();

// hearsay-tools/cezarion#1235: the message withdraws no wait; it makes the wake's lifecycle
  // opening the human's, keeping its text.
  it('restart preserves a queued human answer beside an owed wait that made the lifecycle opening human', async () => {
    const { p } = await queuedWake();
    store.appendEvent(p.id, { type: 'ask.requested', requestId: randomUUID(), questions: [{
      header: 'Choice', question: 'Which option?', options: [{ label: 'One' }, { label: 'Two' }],
    }] });
    manager.enqueueMessage(p.id, [{ type: 'text', text: 'queued human answer mock:hold' }]);
    expect(store.getRun(p.id)?.continuationMessage).toMatchObject({ origin: 'human',
      text: 'Resume to receive the queued worker wait result. End this opening turn so Cezar can deliver it.' });
    await restart();
    await until(() => store.readEvents(p.id).some(event => event.type === 'human-input-delivered'));
    expect(store.readEvents(p.id).filter(event => event.type === 'human-input-delivered')).toHaveLength(1);
    expect(store.readEvents(p.id).filter(event => event.type === 'user-message').at(-1)?.text).toContain('queued human answer');
  });

it('restart with an empty human-origin checkpoint preserves the ask without a synthetic answer', async () => {
    const p = await parent('mock:cezar-ask');
    await until(() => store.getRun(p.id)?.status === 'waiting');
    setRunStatus(store, p.id, RUN_STATUS.running, { continuationMessage: {
      id: randomUUID(), text: '', origin: 'human', createdAt: new Date().toISOString(),
    } });
    await restart();
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(manager.isActive(p.id)).toBe(false);
    expect(store.readEvents(p.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
  });

it('restart preserves an ordinary parked root without a wait or ask, including after children finish', async () => {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id);
    await restart();
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(store.getRun(w.id)?.status).not.toBe('cancelled');
    await until(() => store.getRun(w.id)?.status === 'waiting');
    manager.finish(w.id); await until(() => !manager.isActive(w.id));
    await restart();
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(manager.continueRun(p.id, { text: 'human follow-up mock:hold' }).ok).toBe(true);
    await until(() => store.getRun(p.id)?.status === 'waiting');
  });
});
