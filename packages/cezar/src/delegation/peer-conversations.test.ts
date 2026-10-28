import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONVERSATION_PAGE_MESSAGES,
  conversationInspectRequestSchema,
  conversationInspectResultSchema,
  type ConversationMessage,
  type ConversationSendRequest,
} from '@open-mercato/cezar-contract/conversations';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunRecord } from '../runs/store.ts';
import { RunStore } from '../runs/store.ts';
import { fixture } from './service.testkit.ts';
import { projectConversationEvents } from './conversations.ts';

// Messages between root tasks (hearsay-tools/cezarion#1990): spec
// 2026-10-27-task-communication-protocol § 2, § 4, § 5 and § 13.
describe('peer conversations', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { vi.stubEnv('CEZ_DELEGATION', '1'); f = fixture(); });
  afterEach(async () => {
    for (const run of f.store.listRuns()) if (f.manager.isActive(run.id)) f.manager.cancel(run.id);
    await f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  });
  const permissions = ['spawn', 'inspect', 'steer', 'stop', 'destroy', 'diff', 'wait'] as const;
  /** Another root task of the project. `provisioned: false` is a top-level run that never opened a session. */
  function peer(status: RunRecord['status'] = RUN_STATUS.running, provisioned = true) {
    const run = f.store.createRun({ title: 'peer', task: 'peer', workflow: 'quick-task', runner: 'claude', steps: [] });
    f.store.updateRun(run.id, { status, ...(provisioned ? { delegation: { role: 'root', permissions: [...permissions], receipts: [] } } : {}) });
    return { id: run.id, caller: f.credentials.authenticate(f.credentials.issue('project', run.id, randomUUID()))! };
  }
  async function worker(parent = f.caller) {
    const { workerId } = await f.service.spawn(parent, { task: 'work', baseline: 'parent-head', requestId: randomUUID() });
    f.store.updateRun(workerId, { status: RUN_STATUS.running });
    return { id: workerId, caller: f.credentials.authenticate(f.credentials.issue('project', workerId, randomUUID()))! };
  }
  const message = (recipientRunId: string, kind: ConversationSendRequest['kind'] = 'request', extra: Partial<ConversationSendRequest> = {}): ConversationSendRequest =>
    ({ id: randomUUID(), recipientRunId, kind, text: `${kind} text`, timeoutSeconds: 600, ...extra });
  const ledger = (id: string) => { const run = f.store.getRun(id); return run?.delegation?.role === 'root' ? run.delegation.conversation : undefined; };
  const projections = (id: string) => f.store.readEvents(id).filter(event => event.type === 'conversation-message' || event.type === 'request-outcome').map(event => String(event.projectionId));

  it('R7 a root requests a peer, the peer replies, and the request settles replied in the requester\'s ledger', async () => {
    const b = peer();
    const request = await f.service.send(f.caller, message(b.id));
    expect(request).toMatchObject({ delivery: 'queued', message: { relationship: 'peer', state: 'accepted', senderRunId: f.parent.id, recipientRunId: b.id } });
    expect(f.store.getRun(b.id)?.agentInputs).toEqual([expect.objectContaining({ id: request.message.id, parentRunId: f.parent.id,
      conversation: expect.objectContaining({ senderRunId: f.parent.id, relationship: 'peer' }) })]);
    const reply = await f.service.reply(b.caller, message(f.parent.id, 'reply', { requestId: request.message.id }));
    expect(reply).toMatchObject({ message: { relationship: 'peer', state: 'accepted' }, outcome: { requestId: request.message.id, status: 'replied', replyId: reply.message.id } });
    // Request and reply stay together where the requester waits; the recipient's ledger is unchanged.
    expect(ledger(f.parent.id)?.messages.map(entry => entry.id)).toEqual([request.message.id, reply.message.id]);
    expect(ledger(b.id)).toBeUndefined();
    expect(f.store.getRun(f.parent.id)?.agentInputs?.map(input => input.id)).toEqual([reply.message.id]);
    // Restart: the ledger reloads, and replaying projections adds no input and no event.
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    expect(reopened.getRun(f.parent.id)?.delegation).toMatchObject({ conversation: { messages: [request.message, reply.message], outcomes: [reply.outcome] } });
    reopened.flush();
    const before = { a: projections(f.parent.id), b: projections(b.id) };
    projectConversationEvents(f.store, f.store.getRun(f.parent.id)!);
    expect({ a: projections(f.parent.id), b: projections(b.id) }).toEqual(before);
    expect(f.store.getRun(b.id)?.agentInputs).toHaveLength(1);
    expect(f.store.getRun(f.parent.id)?.agentInputs).toHaveLength(1);
  });

  it('R1 a peer message is agent input: it reaches a task with an open question and answers nothing', async () => {
    const b = peer(RUN_STATUS.waiting);
    f.store.appendEvent(b.id, { type: 'ask.requested', requestId: randomUUID(), questions: [{ question: 'Ignored file?', header: 'Ignored', options: [{ label: 'Yes' }, { label: 'No' }] }] });
    const askSeq = f.store.transcriptFacts(b.id).pendingAsk?.seq;
    expect(askSeq).toBeDefined();
    const sent = await f.service.send(f.caller, message(b.id, 'progress', { text: 'Coordinator continues wave 2' }));
    expect(f.store.getRun(b.id)?.agentInputs).toEqual([expect.objectContaining({ id: sent.message.id, source: agentInputSchema.shape.source.enum.agent })]);
    expect(f.store.readEvents(b.id).filter(event => event.type === 'user-message' || event.type === 'human-input-delivered')).toEqual([]);
    expect(f.store.transcriptFacts(b.id).pendingAsk?.seq).toBe(askSeq);
  });

  it('R4 R5 R6 refuses every pair outside a family or a peer pair with one text, and family pairs still work', async () => {
    const b = peer();
    const w = await worker();
    const other = await worker(b.caller);
    const unrelated = async (send: Promise<unknown>) => { await expect(send).rejects.toMatchObject({ code: 'denied_scope', message: 'Worker scope denied' }); };
    await unrelated(f.service.send(w.caller, message(b.id, 'progress')));            // worker → peer root
    await unrelated(f.service.send(f.caller, message(other.id, 'progress')));        // root → another family's worker
    await unrelated(f.service.send(w.caller, message(other.id, 'progress')));        // worker → another family's worker
    await unrelated(f.service.send(f.caller, message(randomUUID(), 'progress')));    // forged recipient ID
    await unrelated(f.service.send(f.caller, message(f.parent.id, 'progress')));     // itself
    // R6: a worker's routed question in this family; a peer cannot reply to it.
    const question = await f.service.send(w.caller, message(f.parent.id));
    await unrelated(f.service.reply(b.caller, message(f.parent.id, 'reply', { requestId: question.message.id })));
    await unrelated(f.service.reply(b.caller, message(w.id, 'reply', { requestId: question.message.id })));
    expect(ledger(f.parent.id)?.outcomes).toEqual([]);
    expect((await f.service.send(f.caller, message(w.id, 'progress'))).message).not.toHaveProperty('relationship');
    expect((await f.service.reply(f.caller, message(w.id, 'reply', { requestId: question.message.id }))).outcome).toMatchObject({ status: 'replied' });
    // Another project's credential (issued last: it replaces this run's own).
    const foreign = f.credentials.authenticate(f.credentials.issue('other', f.parent.id, randomUUID()))!;
    await unrelated(f.service.send(foreign, message(b.id, 'progress')));
  });

  it('R8 a peer recipient that has not opened a session becomes a root task with its first message', async () => {
    const b = peer(RUN_STATUS.queued, false);
    const sent = await f.service.send(f.caller, message(b.id, 'progress'));
    expect(sent).toMatchObject({ delivery: 'queued', message: { state: 'accepted' } });
    expect(f.store.getRun(b.id)?.delegation).toEqual({ role: 'root', permissions: [...permissions], receipts: [] });
    expect(f.store.getRun(b.id)?.agentInputs?.map(input => input.id)).toEqual([sent.message.id]);
  });

  it.each(['queued', 'running', 'waiting'] as const)('R8 a %s peer accepts a request and holds it open', async status => {
    const b = peer(status);
    const sent = await f.service.send(f.caller, message(b.id));
    expect(sent).toMatchObject({ delivery: 'queued', message: { state: 'accepted', deadline: expect.any(String) } });
    expect(sent).not.toHaveProperty('outcome');
  });

  it.each(['review', 'done', 'failed', 'cancelled'] as const)('R8 a %s peer is not delivered: only its human can continue it', async status => {
    const b = peer(status);
    const sent = await f.service.send(f.caller, message(b.id));
    expect(sent).toMatchObject({ delivery: 'not-delivered', message: { state: 'continuation-required', instruction: `Not delivered: task is ${status}. Only its human can continue it.` } });
    expect(sent.message).not.toHaveProperty('deadline');
    expect(f.store.getRun(b.id)?.agentInputs ?? []).toEqual([]);
    await expect(f.service.send(f.caller, message(b.id, 'request', { resume: true }))).rejects.toMatchObject({ code: 'denied_scope' });
  });

  it.each([['review', 'completed-without-reply'], ['done', 'completed-without-reply'], ['failed', 'failed'], ['cancelled', 'cancelled']] as const)(
    'R8 R17 an open request to a peer that settles at %s settles %s at once', async (status, outcome) => {
      const b = peer();
      const sent = await f.service.send(f.caller, message(b.id));
      f.store.updateRun(b.id, { status });
      expect((await f.service.conversation(f.caller, { recipientRunId: b.id })).outcomes).toEqual([expect.objectContaining({ requestId: sent.message.id, status: outcome })]);
      // A reply after a human continues the peer is recorded late and reopens nothing.
      f.store.updateRun(b.id, { status: RUN_STATUS.running });
      const late = await f.service.reply(b.caller, message(f.parent.id, 'reply', { requestId: sent.message.id }));
      expect(late).toMatchObject({ message: { state: 'late' }, outcome: { status: outcome } });
    });

  it('R8 a pending history deletion on the peer\'s family refuses new sends but keeps the open request pending', async () => {
    const b = peer();
    const sent = await f.service.send(f.caller, message(b.id));
    f.store.commitDelegation([{ id: b.id, delegation: { role: 'root', permissions: [...permissions], receipts: [], historyDeletion: 'pending' } }]);
    await expect(f.service.send(f.caller, message(b.id, 'progress'))).rejects.toMatchObject({ code: 'denied_scope', message: 'Worker scope denied' });
    const history = await f.service.conversation(f.caller, { recipientRunId: b.id });
    expect(history.messages.map(entry => entry.id)).toEqual([sent.message.id]);
    expect(history.outcomes).toEqual([]);
  });

  it('R8 a history read projects nothing from a peer ledger whose history deletion is pending', async () => {
    const b = peer();
    await f.service.send(f.caller, message(b.id, 'progress'));
    // A message in B's ledger that no projection has reached yet, as a crash can leave one.
    const unprojected: ConversationMessage = { id: randomUUID(), senderRunId: b.id, recipientRunId: f.parent.id, kind: 'progress', relationship: 'peer',
      text: 'never projected', createdAt: new Date().toISOString(), requestHash: 'a'.repeat(64), state: 'accepted' };
    f.store.commitConversation(b.id, { messages: [unprojected], outcomes: [] });
    // B's deletion stopped after it marked the family and removed B's events.
    f.store.commitDelegation([{ id: b.id, delegation: { role: 'root', permissions: [...permissions], receipts: [], conversation: { messages: [unprojected], outcomes: [] }, historyDeletion: 'pending' } }]);
    const before = { a: projections(f.parent.id), b: projections(b.id) };
    const history = await f.service.conversation(f.caller, { recipientRunId: b.id });
    expect(history.messages.map(entry => entry.id)).toContain(unprojected.id);
    expect({ a: projections(f.parent.id), b: projections(b.id) }).toEqual(before);
    expect(projections(b.id).some(id => id.includes(unprojected.id))).toBe(false);
  });

  it.each(['B first', 'C first', 'concurrent'] as const)('R14 two peers sending one message ID to one recipient: the second is refused and writes nothing (%s)', async order => {
    const b = peer(); const c = peer();
    const id = randomUUID();
    const fromB = message(f.parent.id, 'progress', { id, text: 'from B' });
    const fromC = message(f.parent.id, 'progress', { id, text: 'from C' });
    const [first, second] = order === 'C first' ? [{ caller: c.caller, request: fromC, ledger: c.id }, { caller: b.caller, request: fromB, ledger: b.id }]
      : [{ caller: b.caller, request: fromB, ledger: b.id }, { caller: c.caller, request: fromC, ledger: c.id }];
    let receipt;
    if (order === 'concurrent') {
      const results = await Promise.allSettled([f.service.send(first.caller, first.request), f.service.send(second.caller, second.request)]);
      expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
      receipt = (results[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof f.service.send>>>).value;
      expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ code: 'invalid_input', message: 'Message ID already in use; use a new message ID' });
    } else {
      receipt = await f.service.send(first.caller, first.request);
      await expect(f.service.send(second.caller, second.request)).rejects.toMatchObject({ code: 'invalid_input', message: 'Message ID already in use; use a new message ID' });
    }
    expect(ledger(second.ledger)?.messages ?? []).toEqual([]);
    expect(f.store.getRun(f.parent.id)?.agentInputs).toEqual([expect.objectContaining({ id, text: first.request.text, conversation: expect.objectContaining({ senderRunId: first.ledger }) })]);
    expect(projections(f.parent.id).filter(projection => projection.startsWith(`conversation-message:${id}:`))).toEqual([`conversation-message:${id}:queued`]);
    // An exact retry of the first returns its receipt.
    expect(await f.service.send(first.caller, first.request)).toEqual(receipt);
  });

  it('R14 a message ID already projected on the recipient is refused even when the recipient never queued it', async () => {
    const b = peer(RUN_STATUS.review); const c = peer();
    const id = randomUUID();
    expect((await f.service.send(f.caller, message(b.id, 'progress', { id }))).delivery).toBe('not-delivered');
    f.store.updateRun(b.id, { status: RUN_STATUS.running });
    await expect(f.service.send(c.caller, message(b.id, 'progress', { id }))).rejects.toMatchObject({ code: 'invalid_input' });
    expect(ledger(c.id)).toBeUndefined();
  });

  it('R15 after a peer\'s deletion the requester\'s history, wait and cancel still work, and its request settles deleted', async () => {
    const b = peer();
    const progress = await f.service.send(f.caller, message(b.id, 'progress'));
    const open = await f.service.send(f.caller, message(b.id));
    f.store.updateRun(b.id, { status: RUN_STATUS.done });
    expect(f.store.deleteRun(b.id)).toBe(true);
    // The deletion itself reconciles the live ledgers: no read is needed to settle it.
    expect(ledger(f.parent.id)?.outcomes).toEqual([expect.objectContaining({ requestId: open.message.id, status: 'deleted' })]);
    const history = await f.service.conversation(f.caller, { recipientRunId: b.id });
    expect(history.messages.map(entry => entry.id)).toEqual([progress.message.id, open.message.id]);
    expect(history.outcomes).toEqual([expect.objectContaining({ requestId: open.message.id, status: 'deleted' })]);
    const register = vi.spyOn(f.manager, 'registerRequestWait').mockReturnValue({ id: randomUUID(), workerIds: [], requestIds: [open.message.id], deadline: new Date(Date.now() + 600_000).toISOString(), phase: 'registered', outcomes: [] });
    await f.service.waitRequests(f.caller, { requestIds: [open.message.id], timeoutSeconds: 600 });
    expect(register).toHaveBeenCalledOnce();
    expect(await f.service.cancelRequest(f.caller, { requestId: open.message.id })).toMatchObject({ status: 'deleted' });
    await expect(f.service.send(f.caller, message(b.id, 'progress'))).rejects.toMatchObject({ code: 'denied_scope' });
  });

  it('R15 a conversation held only in the peer\'s ledger stays readable while its history deletion is pending and after it', async () => {
    const b = peer();
    const sent = await f.service.send(b.caller, message(f.parent.id, 'progress', { text: 'from B only' }));
    expect(ledger(f.parent.id)).toBeUndefined();
    const delegation = f.store.getRun(b.id)!.delegation!;
    if (delegation.role !== 'root') throw Error('missing root');
    f.store.commitDelegation([{ id: b.id, delegation: { ...delegation, historyDeletion: 'pending' } }]);
    expect((await f.service.conversation(f.caller, { recipientRunId: b.id })).messages.map(entry => entry.id)).toEqual([sent.message.id]);
    expect(f.store.deleteRun(b.id)).toBe(true);
    // B's ledger went with it; A's own input from B still makes A a participant.
    expect(await f.service.conversation(f.caller, { recipientRunId: b.id })).toMatchObject({ messages: [], outcomes: [] });
    await expect(f.service.conversation(f.caller, { recipientRunId: randomUUID() })).rejects.toMatchObject({ code: 'denied_scope' });
  });

  it('R15 a requester resting at review, out of memory, settles its request deleted when the peer is deleted, with no read', async () => {
    const b = peer();
    const open = await f.service.send(f.caller, message(b.id));
    f.store.updateRun(f.parent.id, { status: RUN_STATUS.review });
    // The requester has left the live set the run manager's global pass reads.
    vi.spyOn(f.store, 'listRuns').mockReturnValue([]);
    expect(f.store.deleteRun(b.id)).toBe(true);
    expect(ledger(f.parent.id)?.outcomes).toEqual([expect.objectContaining({ requestId: open.message.id, status: 'deleted' })]);
    expect(projections(f.parent.id)).toContain(`request-outcome:${open.message.id}`);
  });

  it('R15 a sender deleted before the first inbox reserve, or between reserve and acknowledge, leaves the recipient\'s batch whole', async () => {
    const b = peer(); const c = peer();
    const fromB = await f.service.send(b.caller, message(f.parent.id, 'progress', { text: 'from B' }));
    f.store.updateRun(b.id, { status: RUN_STATUS.done });
    expect(f.store.deleteRun(b.id)).toBe(true);
    const fromC = await f.service.send(c.caller, message(f.parent.id, 'progress', { text: 'from C' }));
    const batch = await f.service.inbox(f.caller);
    expect(batch.messages.map(entry => [entry.id, entry.text])).toEqual([[fromB.message.id, 'from B'], [fromC.message.id, 'from C']]);
    expect(batch.receiptId).toBeDefined();
    f.store.updateRun(c.id, { status: RUN_STATUS.done });
    expect(f.store.deleteRun(c.id)).toBe(true);
    expect(await f.service.ackInbox(f.caller, { receiptId: batch.receiptId! })).toEqual({ receiptId: batch.receiptId, status: 'acknowledged' });
    expect(f.store.getRun(f.parent.id)?.agentInputs?.every(input => !!input.deliveredAt)).toBe(true);
  });

  it('R15 a reply to a deleted sender\'s request is refused', async () => {
    const b = peer();
    const request = await f.service.send(b.caller, message(f.parent.id));
    f.store.updateRun(b.id, { status: RUN_STATUS.done });
    expect(f.store.deleteRun(b.id)).toBe(true);
    await expect(f.service.reply(f.caller, message(b.id, 'reply', { requestId: request.message.id }))).rejects.toMatchObject({ code: 'denied_scope' });
  });

  it('R16 pages two full ledgers newest first, with no message skipped or repeated at a shared createdAt', async () => {
    const b = peer();
    const base = Date.parse('2026-10-27T10:00:00.000Z');
    // Seven messages share each millisecond, so page boundaries fall inside a tie.
    const fill = (sender: string, recipient: string, offset: number): ConversationMessage[] => Array.from({ length: CONVERSATION_PAGE_MESSAGES }, (_, n) => ({
      id: randomUUID(), senderRunId: sender, recipientRunId: recipient, kind: 'progress', relationship: 'peer', text: `m${offset + n}`,
      createdAt: new Date(base + Math.floor((offset + n) / 7)).toISOString(), requestHash: 'a'.repeat(64), state: 'accepted' }));
    const mine = fill(f.parent.id, b.id, 0).filter((_, n) => n % 2 === 0).concat(fill(f.parent.id, b.id, 1).filter((_, n) => n % 2 === 0));
    const theirs = fill(b.id, f.parent.id, 0).filter((_, n) => n % 2 === 1).concat(fill(b.id, f.parent.id, 1).filter((_, n) => n % 2 === 1));
    f.store.commitConversation(f.parent.id, { messages: mine, outcomes: [] });
    f.store.commitConversation(b.id, { messages: theirs, outcomes: [] });
    expect(mine).toHaveLength(CONVERSATION_PAGE_MESSAGES);
    expect(theirs).toHaveLength(CONVERSATION_PAGE_MESSAGES);
    const seen: string[] = [];
    let before: string | undefined;
    let pages = 0;
    do {
      const page = conversationInspectResultSchema.parse(await f.service.conversation(f.caller, conversationInspectRequestSchema.parse({ recipientRunId: b.id, ...(before ? { before } : {}) })));
      expect(page.messages.length).toBeLessThanOrEqual(CONVERSATION_PAGE_MESSAGES);
      seen.unshift(...page.messages.map(entry => entry.id));
      before = page.nextBefore;
      pages++;
    } while (before);
    expect(pages).toBe(2);
    const all = [...mine, ...theirs].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map(entry => entry.id);
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(2 * CONVERSATION_PAGE_MESSAGES);
    expect(conversationInspectRequestSchema.safeParse({ recipientRunId: b.id, before: 'not-a-cursor' }).success).toBe(false);
  });
});
