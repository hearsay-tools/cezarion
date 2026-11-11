import { testHome } from '../home/test-home.testkit.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CredentialRegistry } from '../delegation/credentials.ts';
import { DelegationService } from '../delegation/service.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { eventCheckpoint, manager, restart, root, semaphore, store, until, waitOf, work } from './worker-wait-claude.testkit.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { requestOutcomeSchema } from '@open-mercato/cezar-contract/conversations';
import { conversationOf, eventsOf, closedAs, noHumanCard, askedPair, answered, said, useWorkerQuestionsFixture } from './worker-questions.testkit.ts';

describe("worker questions route to the parent (hearsay-tools/cezarion#505)", { timeout: 45_000 }, () => {
  useWorkerQuestionsFixture();

// A Stop that takes its time still ends the parent's ability to answer: the question closes while
  // the parent is stopping, not when its status settles.
  it('closes a routed question while its parent is stopping', async () => {
    const f = await askedPair();
    // The fixture launches the parent before its worker; both sessions are fixture-owned.
    const session = [...work.liveSessions][0]!;
    const interrupt = session.interrupt.bind(session);
    const heldInterrupt = vi.spyOn(session, 'interrupt').mockImplementation(() => {});
    try {
      expect(manager.cancel(f.p.id)).toBe(true);
      expect(store.getRun(f.p.id)).toMatchObject({ stopping: true, status: expect.stringMatching(/^(running|waiting)$/) });
      manager.reconcileWorkerWaits();
      await until(() => closedAs(f.w.id).length === 1);
      expect(closedAs(f.w.id)).toEqual(['parent-stopped']);
      expect(conversationOf(f.p.id)?.outcomes).toEqual([expect.objectContaining({ requestId: f.questionId, status: requestOutcomeSchema.shape.status.enum.cancelled })]);
      expect(store.getRun(f.p.id)?.stopping).toBe(true);
      noHumanCard(f.w.id);
    } finally {
      heldInterrupt.mockRestore();
      interrupt();
      f.close();
    }
  });

it("waits for capacity before a parent's answer resumes the worker", async () => {
    const f = await askedPair();
    try {
      const blocker = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:slow', runner: 'claude' });
      await until(() => store.getRun(blocker.id)?.status === 'running' && semaphore.busy() === 1);
      let peak = 0;
      const sample = setInterval(() => { peak = Math.max(peak, semaphore.busy()); }, 5);
      try {
        await f.reply('mock:agent-echo Use the parser');
        // Another message while the answer waits for admission must not deliver it early.
        await f.service.send(f.parentCaller, { id: randomUUID(), recipientRunId: f.w.id, kind: 'progress', text: 'mock:agent-echo Still here', timeoutSeconds: 600 });
        // The send queued an admission pump. Observe that pump's completion with the slot held.
        await semaphore.release();
        await Promise.all([...work.pending].filter(([, label]) => label === 'pump').map(([task]) => task));
        expect(store.getRun(f.w.id)?.agentInputs?.filter(input => !input.deliveredAt)).toEqual(
          expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('Use the parser') })]));
        expect(answered(f.w.id)).toEqual([]);
        // Freeing the slot admits the worker, and the held answer goes in.
        manager.cancel(blocker.id);
        await until(() => answered(f.w.id).length === 1);
      } finally { clearInterval(sample); }
      expect(peak).toBeLessThanOrEqual(1);
    } finally { f.close(); }
  });

it('records the routing on recovery when the crash fell between the question and its event', async () => {
    const f = await askedPair();
    f.close();
    // Drop the routing event from the checkpoint; the committed question stays.
    const events = eventCheckpoint();
    for (const [path, content] of events) events.set(path, content.split('\n').filter(line => !line.includes('"worker-question-routed"')).join('\n'));
    await restart(false, undefined, events);
    await until(() => eventsOf(f.w.id, 'worker-question-routed').length === 1);
    expect(eventsOf(f.w.id, 'worker-question-routed')[0]).toMatchObject({ messageId: f.questionId });
    const credentials = new CredentialRegistry();
    try {
      const parentCaller = credentials.authenticate(credentials.issue('project', f.p.id, randomUUID()))!;
      const service = new DelegationService();
      service.registerProject({ home: testHome(), id: 'project', root, store, manager });
      await until(() => ['running', 'waiting'].includes(store.getRun(f.p.id)?.status ?? '') && store.getRun(f.w.id)?.status === 'waiting');
      await service.send(parentCaller, { id: randomUUID(), recipientRunId: f.w.id, kind: 'reply', requestId: f.questionId, text: 'mock:agent-echo Use the parser', timeoutSeconds: 600 });
      await until(() => answered(f.w.id).length === 1);
    } finally { credentials.close(); }
  });

it('routes the question on recovery when the crash fell before it reached the parent', async () => {
    const f = await askedPair();
    f.close();
    const events = eventCheckpoint();
    for (const [path, content] of events) events.set(path, content.split('\n').filter(line => !line.includes('"worker-question-routed"')).join('\n'));
    type DiskRun = { id: string; agentInputs?: Array<{ id: string }> | undefined; delegation?: { conversation?: { messages: Array<{ id: string }> } } };
    const disk = readPersistedRuns(join(root, '.ai/cezar')) as DiskRun[];
    for (const run of disk) if (run.id === f.p.id) {
      run.agentInputs = run.agentInputs?.filter(input => input.id !== f.questionId);
      const conversation = run.delegation?.conversation;
      if (conversation) conversation.messages = conversation.messages.filter(message => message.id !== f.questionId);
    }
    await restart(false, disk, events);
    await until(() => eventsOf(f.w.id, 'worker-question-routed').length === 1);
    expect(eventsOf(f.w.id, 'worker-question-routed')[0]).toMatchObject({ messageId: f.questionId });
    expect(conversationOf(f.p.id)?.messages.some(message => message.id === f.questionId)).toBe(true);
    expect(eventsOf(f.w.id, 'worker-question-fallback')).toEqual([]);
  });

it('answers a worker that registered a request wait before asking', async () => {
    const f = await askedPair();
    try {
      const request = randomUUID();
      await f.service.send(f.workerCaller, { id: request, recipientRunId: f.p.id, kind: 'request', text: 'Which module? mock:hold', timeoutSeconds: 600 });
      // The wait a turn registered before its ask: a list entry since hearsay-tools/cezarion#1235,
      // which the answer leaves open.
      const wait = manager.registerRequestWait(f.w.id, { requestIds: [request], timeoutSeconds: 600 });
      await f.reply('mock:agent-echo Use the parser');
      await until(() => answered(f.w.id).length === 1);
      await until(() => said(f.w.id, 'Use the parser'));
      expect(waitOf(store.getRun(f.w.id))).toMatchObject({ id: wait.id, requestIds: [request] });
    } finally { f.close(); }
  });
});
