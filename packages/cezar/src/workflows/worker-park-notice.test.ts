import { setRunStatus } from '../runs/run-store.testkit.ts';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage } from '@open-mercato/cezar-contract';
import { RUN_STATUS, WAIT_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { parkNoticeId } from '../delegation/park-notice.ts';
import { messagesPrompt } from './monitoring-turn.testkit.ts';
import { thenSay, toolCall } from './waits-parity.testkit.ts';
import { delegatingParent, eventCheckpoint, fixtureUpdateRun, manager, register, restart, semaphore, spendWorkerBudget, store, timeline, until, useWorkerWaitFixture, worker } from './worker-wait.testkit.ts';
import { productName } from '../home/display.ts';

/** hearsay-tools/cezarion#1327: the single-runner paths of the park notice. The RUNNER_IDS cells
 *  U3n, U3r and U3d (`waits-parity-mixed-cells.testkit.ts`) pin it on every native wire. */
describe('a parked worker tells its waiting parent why (hearsay-tools/cezarion#1327)', { timeout: 45_000 }, () => {
  afterEach(() => vi.restoreAllMocks());
  useWorkerWaitFixture();
  const conversationOf = (id: string): ConversationMessage[] => {
    const delegation = store.getRun(id)?.delegation;
    return delegation?.role === 'root' ? delegation.conversation?.messages ?? [] : [];
  };
  const notices = (parentId: string, workerId: string) => conversationOf(parentId).filter(message =>
    message.senderRunId === workerId && message.kind === 'progress' && message.text.startsWith(`${productName('Cezar')} notice: `));
  const parked = (id: string) => store.getRun(id)?.status === 'waiting';
  const turnEnds = (id: string) => store.readEvents(id).filter(event => event.type === 'turn-end').length;
  /** A root parent, parked, that may message its workers, with a delegation service for both. */
  async function family() {
    const { p, service, callerFor } = await delegatingParent({ permissions: ['spawn', 'wait', 'steer'] });
    await until(() => parked(p.id));
    return { p, service, callerOf: callerFor };
  }
  /** A worker whose opening turn says `text` and plain-parks, as a spent budget makes it. */
  async function parkedWorker(parentId: string, text: string) {
    const w = await worker(parentId, messagesPrompt('claude', [text]));
    spendWorkerBudget(w.id);
    manager.enqueueOwnedRun(w.id);
    await until(() => parked(w.id) && turnEnds(w.id) > 0, () => timeline(w.id));
    return w;
  }

  it('posts the notice a crash lost before its commit when recovery runs, with no live session', async () => {
    const { p } = await family();
    const w = await worker(p.id, `${toolCall('cezar_wait', { kind: WAIT_KIND.timer, seconds: 600, note: 'Re-check the load run.' })} ${thenSay('Waiting on the load run.')}`);
    const wait = register(p.id, [w.id]);
    // The crash: the worker parks, and its notice is never committed.
    const commit = store.commitConversation.bind(store);
    const lostNotice = vi.spyOn(store, 'commitConversation').mockImplementation((...args) => {
      if (args[2]?.input.text.startsWith(`${productName('Cezar')} notice: `)) return;
      return commit(...args);
    });
    manager.enqueueOwnedRun(w.id);
    await until(() => parked(w.id) && (store.getRun(w.id)?.waits ?? []).some(entry => entry.kind === 'timer' && entry.phase === 'open'), () => timeline(w.id));
    expect(notices(p.id, w.id)).toEqual([]);
    expect(lostNotice.mock.calls.some(args => args[2]?.input.conversation?.senderRunId === w.id)).toBe(true);
    // Without a live controller, recovery finalizes the parked worker's execution and then posts no
    // notice (hearsay-tools/squawk#3502).
    await restart(false, undefined, eventCheckpoint(), { liveController: true });
    await until(() => notices(p.id, w.id).length > 0, () => timeline(w.id));
    const [notice, ...more] = notices(p.id, w.id);
    expect(more).toEqual([]);
    expect(notice).toMatchObject({ id: parkNoticeId(w.id, wait.id), recipientRunId: p.id, state: 'accepted' });
    expect(notice!.text).toMatch(/It waits on: timer [0-9a-f-]+ at \S+ \(Re-check the load run\.\)/);
    expect(notice!.text).toContain('Its last message:\n');
    // The mock emits the tool envelope as assistant text before thenSay. Its additive
    // receipt now fills the bounded excerpt; recovery must retain that last message.
    expect(notice!.text).toContain('Registered. End your turn to wait');
    expect(notice!.text).toContain('…');
    // The parent's input commits with the message.
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === notice!.id)).toEqual([
      expect.objectContaining({ conversation: { senderRunId: w.id, recipientRunId: p.id, kind: 'progress' } })]);
    // Recovery again finds the same message and posts nothing more.
    await restart();
    expect(notices(p.id, w.id)).toHaveLength(1);
  });

  it('sends no notice when the turn that parked already messaged the parent', async () => {
    const { p, service, callerOf } = await family();
    const w = await parkedWorker(p.id, 'Parked after reporting.');
    const own = randomUUID();
    await service.send(callerOf(w.id), { id: own, recipientRunId: p.id, kind: 'progress', text: 'I wait on the CI run of PR 12.', timeoutSeconds: 600 });
    register(p.id, [w.id]);
    expect(conversationOf(p.id).filter(message => message.senderRunId === w.id).map(message => message.id)).toEqual([own]);
  });

  it('a request wait on a reply from a parked worker gets the notice', async () => {
    const { p, service, callerOf } = await family();
    const w = await parkedWorker(p.id, 'Parked before the request.');
    const request = randomUUID();
    const turns = turnEnds(w.id);
    await service.send(callerOf(p.id), { id: request, recipientRunId: w.id, kind: 'request', text: messagesPrompt('claude', ['Read it; still blocked.']), timeoutSeconds: 600 });
    // The request runs as the worker's next turn, which parks again without a reply.
    await until(() => turnEnds(w.id) > turns && parked(w.id), () => timeline(w.id));
    expect(notices(p.id, w.id)).toEqual([]);
    const wait = manager.registerWorkerListWait(p.id, { requestIds: [request], timeoutSeconds: 600 }, 'cez-worker-wait');
    const [notice, ...more] = notices(p.id, w.id);
    expect(more).toEqual([]);
    expect(notice).toMatchObject({ id: parkNoticeId(w.id, wait.id) });
    expect(notice!.text).toContain('Its last message:\nRead it; still blocked.');
  });

  it('a worker with queued input sends no notice when the wait opens, and the turn that takes the input sends it at its park', async () => {
    const { p, service, callerOf } = await family();
    const w = await parkedWorker(p.id, 'Parked before the request.');
    // The scheduler holds the request, so it stays queued on the parked worker.
    const cap = vi.spyOn(semaphore, 'maxParallel').mockReturnValue(0);
    const projectCap = vi.spyOn(semaphore, 'projectMaxParallel').mockReturnValue(0);
    const request = randomUUID();
    await service.send(callerOf(p.id), { id: request, recipientRunId: w.id, kind: 'request', text: messagesPrompt('claude', ['Took the request; still blocked.']), timeoutSeconds: 600 });
    const wait = manager.registerWorkerListWait(p.id, { requestIds: [request], timeoutSeconds: 600 }, 'cez-worker-wait');
    expect(notices(p.id, w.id)).toEqual([]);
    expect(store.getRun(w.id)?.agentInputs?.some(input => input.id === request && !input.deliveredAt)).toBe(true);
    cap.mockRestore(); projectCap.mockRestore();
    await semaphore.release();
    await until(() => notices(p.id, w.id).length > 0 && parked(w.id), () => timeline(w.id));
    const [notice, ...more] = notices(p.id, w.id);
    expect(more).toEqual([]);
    expect(notice).toMatchObject({ id: parkNoticeId(w.id, wait.id) });
    expect(notice!.text).toContain('Its last message:\nTook the request; still blocked.');
  });

  // hearsay-tools/cezarion#1990 review: a peer that sends first under the notice's deterministic ID.
  it('a peer message that took the notice ID first sends no notice and notes it on the worker once', async () => {
    const { p, service, callerOf } = await family();
    const commit = store.commitConversation.bind(store);
    const notify = vi.spyOn(store, 'commitConversation').mockImplementation((...args) => {
      if (args[2]?.input.text.startsWith(`${productName('Cezar')} notice: `)) return;
      return commit(...args);
    });
    const w = await parkedWorker(p.id, 'Parked behind a peer.');
    const wait = register(p.id, [w.id]);
    const id = parkNoticeId(w.id, wait.id);
    const peer = store.createRun({ title: 'peer', task: 'peer', workflow: 'quick-task', runner: 'claude', steps: [] });
    setRunStatus(store, peer.id, RUN_STATUS.running, { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    await service.send(callerOf(peer.id), { id, recipientRunId: p.id, kind: 'progress', text: 'Peer progress first', timeoutSeconds: 600 });
    expect(notify.mock.calls.some(args => args[2]?.input.conversation?.senderRunId === w.id)).toBe(true);
    notify.mockRestore();
    register(p.id, [(await worker(p.id)).id]);
    register(p.id, [(await worker(p.id)).id]);
    expect(notices(p.id, w.id)).toEqual([]);
    expect(store.readEvents(w.id).filter(event => event.type === 'note' && String(event.message).includes('park notice ID is already in use'))).toHaveLength(1);
    expect(store.getRun(p.id)?.agentInputs?.filter(input => input.id === id)).toEqual([
      expect.objectContaining({ text: 'Peer progress first', conversation: expect.objectContaining({ senderRunId: peer.id, relationship: 'peer' }) })]);
  });

  it('an open peer request holding the parent\'s last inbox slot sends no notice, and the peer\'s reply still fits', async () => {
    const { p, service, callerOf } = await family();
    const now = new Date().toISOString();
    fixtureUpdateRun(p.id, { agentInputs: Array.from({ length: 31 }, () => ({ id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId: p.id, text: 'queued', createdAt: now })) });
    const peer = store.createRun({ title: 'peer', task: 'peer', workflow: 'quick-task', runner: 'claude', steps: [] });
    setRunStatus(store, peer.id, RUN_STATUS.running, { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    const request = await service.send(callerOf(p.id), { id: randomUUID(), recipientRunId: peer.id, kind: 'request', text: 'Which versions?', timeoutSeconds: 600 });
    const w = await parkedWorker(p.id, 'Parked beside a held slot.');
    register(p.id, [w.id]);
    expect(notices(p.id, w.id)).toEqual([]);
    expect(store.readEvents(w.id).filter(event => event.type === 'note' && String(event.message).includes('no park notice was sent'))).toHaveLength(1);
    const reply = await service.send(callerOf(peer.id), { id: randomUUID(), recipientRunId: p.id, kind: 'reply', requestId: request.message.id, text: 'zod 4', timeoutSeconds: 600 });
    expect(reply.outcome).toMatchObject({ status: 'replied' });
    expect(store.getRun(p.id)?.agentInputs?.filter(input => !input.deliveredAt)).toHaveLength(32);
  });

  it('a full parent inbox sends no notice and notes it on the worker once', async () => {
    const { p } = await family();
    const now = new Date().toISOString();
    // 32 undelivered plain inputs fill the parent's inbox; nothing wakes it.
    fixtureUpdateRun(p.id, { agentInputs: Array.from({ length: 32 }, () => ({ id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId: p.id, text: 'queued', createdAt: now })) });
    const w = await parkedWorker(p.id, 'Parked with a full inbox.');
    const wait = register(p.id, [w.id]);
    // Another registration sweeps the family again, and the same wait finds the inbox still full.
    register(p.id, [(await worker(p.id)).id]);
    expect(store.getRun(p.id)?.waits?.find(entry => entry.id === wait.id)?.phase).toBe('open');
    expect(notices(p.id, w.id)).toEqual([]);
    expect(store.readEvents(w.id).filter(event => event.type === 'note' && String(event.message).includes('no park notice was sent'))).toHaveLength(1);
  });
});
