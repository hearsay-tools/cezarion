import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { controlledWire, manager, parent, register, restart, root, store, until, useWorkerWaitFixture, waitOf, worker } from './worker-wait.testkit.ts';

describe('worker wait after an approved continuation (#475)', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();

  it('registers during the answer turn, then parks without prematurely checkpointing the answer', async () => {
    const release = join(root, 'release-answer');
    const wire = controlledWire({ humanAnswerGate: release });
    const p = await parent('mock:cezar-ask'); const w = await worker(p.id);
    await until(() => store.readEvents(p.id).some(event => event.type === 'ask.requested'));
    await restart();
    expect(manager.continueRun(p.id, { text: 'human answer mock:hold' }).ok).toBe(true);
    await until(() => wire.received() === 1);
    try {
      const wait = register(p.id, [w.id]);
      expect(wait.phase).toBe('registered');
      expect(store.getRun(p.id)?.status).toBe('running');
      expect(store.readEvents(p.id).filter(event => event.type === 'human-input-delivered')).toEqual([]);
      writeFileSync(release, 'go');
      await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
      expect(store.getRun(p.id)?.status).toBe('waiting');
      expect(store.readEvents(p.id).filter(event => event.type === 'human-input-delivered')).toHaveLength(1);
      // hearsay-tools/cezarion#1235: the same workers and mode return the open wait.
      expect(register(p.id, [w.id]).id).toBe(wait.id);
    } finally { writeFileSync(release, 'go'); }
  });

  // hearsay-tools/cezarion#1235: a pending human question no longer refuses a worker wait; the
  // wait opens beside it and the question stays pending.
  it('registers beside a genuinely unanswered question, which stays pending', async () => {
    const p = await parent('mock:cezar-ask'); const w = await worker(p.id);
    await until(() => store.readEvents(p.id).some(event => event.type === 'ask.requested'));
    const wait = register(p.id, [w.id]);
    expect(waitOf(store.getRun(p.id))).toMatchObject({ id: wait.id, workerIds: [w.id] });
    expect(store.getRun(p.id)).toMatchObject({ status: 'waiting', waits: expect.arrayContaining([expect.objectContaining({ kind: 'human', phase: 'open' })]) });
  });

  it('a new question during the answer turn does not refuse a worker wait', async () => {
    const release = join(root, 'release-new-ask');
    const wire = controlledWire({ humanAnswerGate: release });
    const p = await parent('mock:cezar-ask'); const w = await worker(p.id);
    await until(() => store.readEvents(p.id).some(event => event.type === 'ask.requested'));
    await restart();
    expect(manager.continueRun(p.id, { text: 'human answer mock:hold' }).ok).toBe(true);
    await until(() => wire.received() === 1);
    try {
      store.appendEvent(p.id, { type: 'ask.requested', requestId: randomUUID(), questions: [{ header: 'New', question: 'Approve another action?', options: [{ label: 'Yes' }, { label: 'No' }] }] });
      expect(register(p.id, [w.id]).phase).toBe('registered');
    } finally { writeFileSync(release, 'go'); }
  });
});
