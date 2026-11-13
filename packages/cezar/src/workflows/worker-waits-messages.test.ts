import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { WAIT_KIND, WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';
import * as processes from '../core/process-usage.ts';
import { hasPendingAsk } from '../runs/run-store.testkit.ts';
import { COMPLETION_NUDGE_NOTE } from './run.ts';
import { gate, thenSay, toolCall } from './waits-parity.testkit.ts';
import { delegatingParent, manager, restart, root, store, until, useWorkerWaitFixture, waitOf, worker, work } from './worker-wait.testkit.ts';

import { entryOf, inputOf } from './worker-waits-shared.testkit.ts';
import { productName } from '../home/display.ts';

describe('messages wake without being waits', { timeout: 45_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => vi.restoreAllMocks());

  const pids = new Map<string, number>();
  beforeEach(() => {
    pids.clear();
    const register = processes.registerRunProcess;
    vi.spyOn(processes, 'registerRunProcess').mockImplementation((id, pid) => { pids.set(id, pid); register(id, pid); });
    const replace = processes.replaceRunProcess;
    vi.spyOn(processes, 'replaceRunProcess').mockImplementation((id, pid) => { pids.set(id, pid); replace(id, pid); });
  });
  const sessionOf = (runId: string) => {
    const session = [...work.liveSessions].find(session => session.pid === pids.get(runId));
    if (!session) throw new Error(`No owned session for ${runId}`);
    return session;
  };
  const eventsOf = (runId: string, type: string) => store.readEvents(runId).filter(event => event.type === type);
  const answered = (runId: string) => eventsOf(runId, 'human-input-delivered').filter(event => event.source === 'parent');
  const delivered = (runId: string, id: string) => !!inputOf(runId, id)?.deliveredAt;

  /** A steering parent and a parked worker, with a service to message between them. */
  async function conversing(parentTask = 'mock:hold', workerTask = 'mock:hold') {
    const { p, service, callerFor } = await delegatingParent({ task: parentTask, permissions: ['spawn', 'wait', 'steer'] });
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const w = await worker(p.id, workerTask);
    manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === 'waiting');
    return { p, w, service, parentCaller: callerFor(p.id), workerCaller: callerFor(w.id) };
  }
  const say = (f: Awaited<ReturnType<typeof conversing>>, from: 'parent' | 'worker', to: string, kind: 'progress' | 'request', text: string, id = randomUUID()) =>
    f.service.send(from === 'parent' ? f.parentCaller : f.workerCaller, { id, recipientRunId: to, kind, text, timeoutSeconds: 600 }).then(() => id);

  /** The parent parked on an agent worker wait for `f.w`. */
  async function parkedOnWorker(f: Awaited<ReturnType<typeof conversing>>) {
    const entry = manager.registerWorkerListWait(f.p.id, { workerIds: [f.w.id], timeoutSeconds: 600 }, 'cezar_wait');
    await until(() => waitOf(store.getRun(f.p.id))?.phase === 'parked');
    return entry;
  }

  // Ticket criterion 2.
  it('a worker message wakes the parent and the worker wait stays open', async () => {
    const f = await conversing();
    const entry = await parkedOnWorker(f);
    const send = vi.spyOn(sessionOf(f.p.id), 'sendAgentMessage');
    const id = await say(f, 'worker', f.p.id, 'progress', 'Still working mock:hold');
    await until(() => delivered(f.p.id, id));
    // The wake turn lists the wait that stays open.
    expect(JSON.stringify(send.mock.calls)).toContain(`Still open: worker wait ${entry.id}`);
    await until(() => store.getRun(f.p.id)?.status === 'waiting');
    expect(entryOf(f.p.id, entry.id)).toMatchObject({ kind: WAIT_KIND.worker, phase: WAIT_PHASE.open, workerIds: [f.w.id] });
  });

  // Review Focus 2: a reply resolves only the request wait that names it.
  it('an unrelated reply wakes and the request wait stays open', async () => {
    const f = await conversing();
    const awaited = await say(f, 'parent', f.w.id, 'request', 'First check mock:hold');
    const other = await say(f, 'parent', f.w.id, 'request', 'Second check mock:hold');
    const entry = manager.registerWorkerListWait(f.p.id, { requestIds: [awaited], timeoutSeconds: 600 }, 'cezar_wait');
    await until(() => waitOf(store.getRun(f.p.id))?.phase === 'parked');
    const reply = randomUUID();
    await f.service.send(f.workerCaller, { id: reply, recipientRunId: f.p.id, kind: 'reply', requestId: other, text: 'Second result mock:hold', timeoutSeconds: 600 });
    await until(() => delivered(f.p.id, reply));
    await until(() => store.getRun(f.p.id)?.status === 'waiting');
    expect(entryOf(f.p.id, entry.id)).toMatchObject({ phase: WAIT_PHASE.open, requestIds: [awaited] });
  });

  it("the parent's answer to a worker question leaves the worker's earlier wait open", async () => {
    const f = await conversing('mock:hold', 'mock:cezar-ask');
    await until(() => eventsOf(f.w.id, 'worker-question-routed').length === 1 && store.getRun(f.w.id)?.status === 'waiting');
    const question = String(eventsOf(f.w.id, 'worker-question-routed')[0]!.messageId);
    const own = await say(f, 'worker', f.p.id, 'request', 'Which module? mock:hold');
    const entry = manager.registerWorkerListWait(f.w.id, { requestIds: [own], timeoutSeconds: 600 }, 'cezar_wait');
    await f.service.send(f.parentCaller, { id: randomUUID(), recipientRunId: f.w.id, kind: 'reply', requestId: question, text: 'mock:agent-echo Use the parser', timeoutSeconds: 600 });
    await until(() => answered(f.w.id).length === 1);
    await until(() => store.readEvents(f.w.id).some(event => event.type === 'text' && String(event.text).includes('Use the parser')));
    expect(entryOf(f.w.id, entry.id)).toMatchObject({ phase: WAIT_PHASE.open, requestIds: [own] });
  });

  it('a human message leaves an agent worker wait open', async () => {
    const f = await conversing();
    const entry = await parkedOnWorker(f);
    expect(manager.sendMessage(f.p.id, [{ type: 'text', text: 'mock:agent-echo human update' }])).toBe(true);
    await until(() => store.readEvents(f.p.id).some(event => event.type === 'text' && String(event.text).includes('human update')));
    await until(() => store.getRun(f.p.id)?.status === 'waiting');
    expect(entryOf(f.p.id, entry.id)).toMatchObject({ phase: WAIT_PHASE.open, workerIds: [f.w.id] });
  });

  it('a worker message reaches a parent with a pending cezar_ask card beside it; the card stays answerable', async () => {
    const f = await conversing('mock:cezar-ask');
    await until(() => hasPendingAsk(store, f.p.id) === true);
    const askSeq = eventsOf(f.p.id, 'ask.requested')[0]!.seq;
    const send = vi.spyOn(sessionOf(f.p.id), 'sendAgentMessage');
    const id = await say(f, 'worker', f.p.id, 'progress', 'Still working');
    await until(() => delivered(f.p.id, id));
    expect(send.mock.calls.some(call => call[1]?.includes(id))).toBe(true);
    // The card is still the one the human answers, with its askSeq.
    await until(() => hasPendingAsk(store, f.p.id) === true && store.getRun(f.p.id)?.status === 'waiting');
    expect(eventsOf(f.p.id, 'ask.requested')).toHaveLength(1);
    expect(manager.sendMessage(f.p.id, [{ type: 'text', text: 'Vitest' }])).toBe(true);
    await until(() => eventsOf(f.p.id, 'human-input-delivered').some(event => event.askSeq === askSeq));
  });

  it('a worker with a routed question receives an unrelated parent message beside it', async () => {
    const f = await conversing('mock:hold', 'mock:cezar-ask');
    await until(() => eventsOf(f.w.id, 'worker-question-routed').length === 1 && store.getRun(f.w.id)?.status === 'waiting');
    const question = String(eventsOf(f.w.id, 'worker-question-routed')[0]!.messageId);
    const send = vi.spyOn(sessionOf(f.w.id), 'sendAgentMessage');
    const id = await say(f, 'parent', f.w.id, 'progress', 'Also lint');
    await until(() => delivered(f.w.id, id));
    expect(send.mock.calls.some(call => call[1]?.includes(id))).toBe(true);
    // A message is not the answer: the question is still the parent's to answer.
    expect(answered(f.w.id)).toEqual([]);
    await until(() => store.getRun(f.w.id)?.status === 'waiting');
    await f.service.send(f.parentCaller, { id: randomUUID(), recipientRunId: f.w.id, kind: 'reply', requestId: question, text: 'mock:agent-echo Use the parser', timeoutSeconds: 600 });
    await until(() => answered(f.w.id).length === 1);
  });

  it('a message to a closed-session parked parent reopens it through the scheduler continuation', async () => {
    const f = await conversing();
    // A worker that never starts: a restart neither settles it nor its wait (the live one is settled).
    const idle = await worker(f.p.id);
    const entry = manager.registerWorkerListWait(f.p.id, { workerIds: [idle.id], timeoutSeconds: 600 }, 'cezar_wait');
    await until(() => waitOf(store.getRun(f.p.id))?.phase === 'parked');
    await restart();
    await until(() => store.getRun(f.p.id)?.status === 'waiting' && !manager.isActive(f.p.id));
    const resumed = vi.spyOn(manager, 'continueRun');
    // A message from the idle worker, committed as `DelegationService.send` commits one.
    const id = randomUUID(); const now = new Date().toISOString();
    const delegation = store.getRun(f.p.id)!.delegation;
    if (delegation?.role !== 'root') throw Error('root fixture');
    const conversation = delegation.conversation ?? { messages: [], outcomes: [] };
    store.commitConversation(f.p.id, { ...conversation, messages: [...conversation.messages, { id, senderRunId: idle.id, recipientRunId: f.p.id,
      kind: 'progress', text: 'Still working mock:hold', createdAt: now, requestHash: 'b'.repeat(64), state: 'accepted' }] }, { recipientRunId: f.p.id,
      input: { id, source: agentInputSchema.shape.source.enum.agent, parentRunId: f.p.id, text: 'Still working mock:hold', createdAt: now, conversation: { senderRunId: idle.id, recipientRunId: f.p.id, kind: 'progress' } } });
    manager.deliverConversationInput(f.p.id);
    await until(() => delivered(f.p.id, id));
    expect(resumed).toHaveBeenCalledWith(f.p.id, { text: `Resume to receive queued messages. End this opening turn so ${productName('Cezar')} can deliver them.`, waitWake: true }, true);
    await until(() => store.getRun(f.p.id)?.status === 'waiting');
    expect(entryOf(f.p.id, entry.id)).toMatchObject({ phase: WAIT_PHASE.open, workerIds: [idle.id] });
  });

  // hearsay-tools/cezarion#1301: a blocked done opens no completion wait, so a worker's request to
  // the nudged parent is ordinary input: delivered, with no wait to end.
  // hearsay-tools/cezarion#2397: the tool refuses a done a live worker blocks, so the turn end's
  // refusal nudge comes from a done the tool accepted before the worker was spawned in that turn.
  it('a parent nudged at a blocked done: a worker request is delivered with no completion wait to end', async () => {
    const { p, service, callerFor } = await delegatingParent({ task: 'mock:hold', permissions: ['spawn', 'wait', 'steer'] });
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const opened = join(root, `gate-${randomUUID()}`);
    const done = vi.spyOn(manager, 'acceptDone');
    expect(manager.sendMessage(p.id, [{ type: 'text', text: `${toolCall('cezar_done', {})} ${gate(opened)} ${thenSay('All done.')}` }])).toBe(true);
    await until(() => done.mock.calls.some(([id], index) => id === p.id && done.mock.results[index]?.value?.ok === true));
    const w = await worker(p.id);
    writeFileSync(opened, '');
    const f = { p, w, service, parentCaller: callerFor(p.id), workerCaller: callerFor(w.id) };
    await until(() => store.readEvents(f.p.id).some(event => event.type === 'note' && String(event.message).startsWith(COMPLETION_NUDGE_NOTE)) &&
      store.getRun(f.p.id)?.status === 'waiting');
    expect(waitOf(store.getRun(f.p.id))).toBeUndefined();
    manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === 'waiting');
    const id = await say(f, 'worker', f.p.id, 'request', 'Need a decision mock:hold');
    await until(() => delivered(f.p.id, id));
  });
});
