import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { fixture } from './service.testkit.ts';
import { projectConversationEvents } from './conversations.ts';
import {
  conversationInspectResultSchema, conversationStateSchema, inboxClaimSchema, inboxReceiptRequestSchema,
  inboxReceiptResultSchema, inboxReserveResultSchema,
} from '@open-mercato/cezar-contract';

describe('worker inbox contract', () => {
  const at = '2026-09-06T12:00:00.000Z';
  const message = { id: randomUUID(), senderRunId: randomUUID(), recipientRunId: randomUUID(), kind: 'request',
    text: 'Need a decision', createdAt: at, requestHash: 'a'.repeat(64), state: 'accepted' };
  const outcome = { requestId: message.id, status: 'replied', observedAt: at, replyId: randomUUID() };
  const receiptId = randomUUID();

  it('parses bounded snapshots and requires receipt fields together only for a nonempty batch', () => {
    const batch = { messages: [message], outcomes: [outcome], receiptId, expiresAt: '2026-09-06T12:02:00.000Z' };
    expect(inboxReserveResultSchema.parse(batch)).toEqual(batch);
    expect(inboxReserveResultSchema.parse({ messages: [], outcomes: [] })).toEqual({ messages: [], outcomes: [] });
    for (const invalid of [
      { messages: [], outcomes: [], receiptId, expiresAt: batch.expiresAt },
      { messages: [message], outcomes: [] },
      { messages: [message], outcomes: [], receiptId },
      { messages: [message], outcomes: [], expiresAt: batch.expiresAt },
      { ...batch, messages: Array.from({ length: 33 }, (_, n) => ({ ...message, id: randomUUID(), text: `message ${n}` })) },
      { ...batch, outcomes: Array.from({ length: 33 }, () => ({ ...outcome, requestId: randomUUID() })) },
    ]) expect(inboxReserveResultSchema.safeParse(invalid).success).toBe(false);
  });

  it('validates receipt identity, acknowledgement status and inspection hint separately from persisted state', () => {
    const claim = { receiptId, generation: randomUUID(), expiresAt: '2026-09-06T12:02:00.000Z' };
    const memberIds = [randomUUID(), randomUUID()];
    expect(inboxClaimSchema.parse(claim)).toEqual(claim);
    expect(inboxClaimSchema.parse({ ...claim, memberIds })).toEqual({ ...claim, memberIds });
    expect(inboxClaimSchema.safeParse({ ...claim, memberIds: [] }).success).toBe(false);
    expect(inboxClaimSchema.safeParse({ ...claim, memberIds: [memberIds[0], memberIds[0]] }).success).toBe(false);
    expect(inboxClaimSchema.parse({ ...claim, acknowledgedAt: at })).toEqual({ ...claim, acknowledgedAt: at });
    expect(inboxClaimSchema.safeParse({ ...claim, generation: 'bad' }).success).toBe(false);
    expect(inboxClaimSchema.safeParse({ ...claim, expiresAt: 'tomorrow' }).success).toBe(false);
    expect(inboxReceiptRequestSchema.parse({ receiptId })).toEqual({ receiptId });
    expect(inboxReceiptRequestSchema.safeParse({ receiptId, generation: claim.generation }).success).toBe(false);
    for (const status of ['acknowledged', 'already-acknowledged', 'released']) {
      expect(inboxReceiptResultSchema.parse({ receiptId, status })).toEqual({ receiptId, status });
    }
    expect(inboxReceiptResultSchema.safeParse({ receiptId, status: 'pending' }).success).toBe(false);
    const inspection = { messages: [message], outcomes: [outcome], hint: 'Run worker inbox' };
    expect(conversationInspectResultSchema.parse(inspection)).toEqual(inspection);
    expect(conversationStateSchema.safeParse(inspection).success).toBe(false);
  });
});

describe('durable conversations', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { vi.stubEnv('CEZ_DELEGATION', '1'); f = fixture(); });
  afterEach(async () => {
    for (const run of f.store.listRuns()) if (f.manager.isActive(run.id)) f.manager.cancel(run.id);
    await f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  });
  async function worker() {
    const { workerId } = await f.service.spawn(f.caller, { task: 'work', baseline: 'parent-head', requestId: randomUUID() });
    f.store.updateRun(workerId, { status: 'running' });
    return { id: workerId, caller: f.credentials.authenticate(f.credentials.issue('project', workerId, randomUUID()))! };
  }
  async function completedWorker(status: 'done' | 'review' = 'done') {
    const w = await worker();
    // This service fixture holds the scheduler; remove its original queued job
    // before publishing a completed execution with a resumable provider session.
    f.manager.cancel(w.id);
    await f.manager.awaitRunTermination(w.id, 5_000);
    f.store.updateStep(w.id, 'task', { status: 'done', sessionId: 'previous-session', backend: 'claude' });
    const generation = f.store.commitWorkerExecutionStart(w.id);
    f.store.updateRun(w.id, { status });
    f.store.commitWorkerExecutionComplete(w.id, generation);
    return w;
  }
  it('keeps provider acknowledgement time separate from a later repaired projection', async () => {
    const w = await worker();
    const message = await f.service.send(f.caller, { id: randomUUID(), recipientRunId: w.id, kind: 'progress', text: 'Result', timeoutSeconds: 600 });
    const deliveredAt = '2026-09-22T14:32:54.554Z';
    f.store.commitAgentInputs(w.id, f.store.getRun(w.id)!.agentInputs!.map(input => ({ ...input, deliveredAt })));
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-22T15:00:00.000Z'));
    try {
      projectConversationEvents(f.store, f.store.getRun(f.parent.id)!);
      for (const id of [f.parent.id, w.id]) expect(f.store.readEvents(id).find(event => event.type === 'conversation-message' && event.delivery === 'delivered'))
        .toMatchObject({ message: { id: message.message.id }, deliveredAt, ts: '2026-09-22T15:00:00.000Z' });
    } finally { vi.useRealTimers(); }
  });
  it.each(['done', 'review'] as const)('parent --resume atomically queues one attributed continuation of a %s worker', async status => {
    const w = await completedWorker(status);
    const request = { id: randomUUID(), recipientRunId: w.id, kind: 'request' as const, text: 'Correct the returned result', timeoutSeconds: 600, resume: true };
    const [a, b] = await Promise.all([f.service.send(f.caller, request), f.service.send(f.caller, request)]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ delivery: 'queued', message: { state: 'accepted', resumed: true } });
    expect(f.store.getRun(w.id)).toMatchObject({ status: 'queued', delegation: { executionRevision: 1 },
      continuationMessage: { origin: 'lifecycle', agentInputId: request.id, text: expect.stringContaining(request.text) },
      agentInputs: [{ id: request.id, conversation: { senderRunId: f.parent.id, recipientRunId: w.id } }] });
    expect(f.store.getRun(w.id)?.steps.filter(step => step.synthetic === 'continuation')).toHaveLength(1);
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    expect(reopened.getRun(w.id)?.continuationMessage).toEqual(f.store.getRun(w.id)?.continuationMessage);
    expect(reopened.getRun(f.parent.id)?.delegation).toMatchObject({ conversation: { messages: [a.message] } }); reopened.flush();
  });
  it('explains rejection with a parent-operated resume command and preserves that receipt on retry', async () => {
    const w = await completedWorker();
    const request = { id: randomUUID(), recipientRunId: w.id, kind: 'progress' as const, text: 'Correct this', timeoutSeconds: 600 };
    const rejected = await f.service.send(f.caller, request);
    expect(rejected).toMatchObject({ delivery: 'not-delivered', message: { instruction: expect.stringContaining(`worker send ${w.id}`) } });
    expect(rejected.message.instruction).toMatch(/--resume.*new.*ID/i);
    await expect(f.service.send(f.caller, { ...request, resume: true })).rejects.toMatchObject({ code: 'invalid_input' });
    await f.service.send(f.caller, { ...request, id: randomUUID(), resume: true });
    expect(await f.service.send(f.caller, request)).toEqual(rejected);
  });
  it('checkpoints the resumed opening input and retires its replay prompt atomically', async () => {
    const w = await completedWorker();
    const request = { id: randomUUID(), recipientRunId: w.id, kind: 'progress' as const, text: 'New instruction', timeoutSeconds: 600, resume: true };
    await f.service.send(f.caller, request);
    const before = structuredClone(f.store.getRun(w.id));
    const inputs = before!.agentInputs!.map(input => ({ ...input, deliveredAt: new Date().toISOString() }));
    const fault = vi.spyOn(f.store as unknown as { commitIndex(): void }, 'commitIndex').mockImplementationOnce(() => { throw Error('disk unavailable'); });
    expect(() => f.store.commitAgentInputs(w.id, inputs, request.id)).toThrow('disk unavailable');
    expect(f.store.getRun(w.id)).toEqual(before);
    fault.mockRestore();
    f.store.commitAgentInputs(w.id, inputs, request.id);
    expect(f.store.getRun(w.id)?.continuationMessage).toBeUndefined();
    expect(f.store.getRun(w.id)?.agentInputs).toEqual(inputs);
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    expect(reopened.getRun(w.id)?.continuationMessage).toBeUndefined(); reopened.flush();
  });
  it('uses the new instruction when explicitly resuming a failed continuation', async () => {
    const w = await completedWorker();
    f.store.updateRun(w.id, { status: 'failed', continuationMessage: { id: 'old', text: 'Old failed prompt', origin: 'lifecycle', createdAt: new Date().toISOString() } });
    await f.service.send(f.caller, { id: randomUUID(), recipientRunId: w.id, kind: 'progress', text: 'Correct the failed task', timeoutSeconds: 600, resume: true });
    expect(f.store.getRun(w.id)?.continuationMessage?.text).toContain('Correct the failed task');
  });
  it('accepts neither a message nor a continuation when the atomic index write fails', async () => {
    const w = await completedWorker();
    const before = structuredClone(f.store.getRun(w.id));
    vi.spyOn(f.store as unknown as { commitIndex(): void }, 'commitIndex').mockImplementationOnce(() => { throw Error('disk unavailable'); });
    await expect(f.service.send(f.caller, { id: randomUUID(), recipientRunId: w.id, kind: 'progress', text: 'Retry work', timeoutSeconds: 600, resume: true })).rejects.toThrow(/checkpoint/);
    expect(f.store.getRun(w.id)).toEqual(before);
    expect(f.store.getRun(f.parent.id)?.delegation).not.toHaveProperty('conversation');
  });
  it('does not let --resume answer a human question or allow a worker to resume its parent', async () => {
    const w = await completedWorker();
    f.store.appendEvent(w.id, { type: 'ask.requested', requestId: randomUUID(), questions: [{ header: 'Approval', question: 'May I proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }] });
    await expect(f.service.send(f.caller, { id: randomUUID(), recipientRunId: w.id, kind: 'progress', text: 'Work', timeoutSeconds: 600, resume: true })).rejects.toThrow(/human question/);
    f.store.updateRun(w.id, { status: 'running' });
    await expect(f.service.send(w.caller, { id: randomUUID(), recipientRunId: f.parent.id, kind: 'progress', text: 'Work', timeoutSeconds: 600, resume: true })).rejects.toMatchObject({ code: 'denied_scope' });
  });
  it('atomically accepts one obligation and input across concurrent retries and restart', async () => {
    const w = await worker(); const request = { id: randomUUID(), recipientRunId: w.id, kind: 'request' as const, text: 'Which file?', timeoutSeconds: 600 };
    const [a, b] = await Promise.all([f.service.send(f.caller, request), f.service.send(f.caller, request)]);
    expect(a).toEqual(b); expect(f.store.getRun(w.id)?.agentInputs).toHaveLength(1);
    await expect(f.service.send(f.caller, { ...request, text: 'changed' })).rejects.toMatchObject({ code: 'invalid_input' });
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    expect(reopened.getRun(f.parent.id)?.delegation).toMatchObject({ conversation: { messages: [a.message], outcomes: [] } });
    expect(reopened.getRun(w.id)?.agentInputs?.[0]).toMatchObject({ id: request.id, conversation: { senderRunId: f.parent.id, recipientRunId: w.id, kind: 'request' } }); reopened.flush();
  });
  it('allows worker request, parent follow-up and reply, preserving first settlement and late replies', async () => {
    const w = await worker(); const req = await f.service.send(w.caller, { id: randomUUID(), recipientRunId: f.parent.id, kind: 'request', text: 'Approve approach?', timeoutSeconds: 600 });
    await f.service.followUp(w.caller, { id: randomUUID(), recipientRunId: f.parent.id, requestId: req.message.id, kind: 'follow-up', text: 'More context', timeoutSeconds: 600 });
    const reply = { id: randomUUID(), recipientRunId: w.id, requestId: req.message.id, kind: 'reply' as const, text: 'Yes', timeoutSeconds: 600 };
    expect(await f.service.reply(f.caller, reply)).toMatchObject({ outcome: { status: 'replied', replyId: reply.id } });
    expect(await f.service.reply(f.caller, reply)).toMatchObject({ outcome: { status: 'replied', replyId: reply.id } });
    expect(await f.service.reply(f.caller, { ...reply, id: randomUUID() })).toMatchObject({ message: { state: 'late' }, outcome: { replyId: reply.id } });
    expect((await f.service.conversation(w.caller, { recipientRunId: f.parent.id })).outcomes).toHaveLength(1);
  });
  it('rejects peer routes, forged callers, secrets and unrelated correlation before accepting', async () => {
    const a = await worker(); const b = await worker();
    const req = { id: randomUUID(), recipientRunId: b.id, kind: 'request' as const, text: 'hello', timeoutSeconds: 600 };
    await expect(f.service.send(a.caller, req)).rejects.toMatchObject({ code: 'denied_scope' });
    await expect(f.service.send({ ...f.caller }, req)).rejects.toMatchObject({ code: 'denied_scope' });
    f.store.registerSessionSecret(f.token);
    await expect(f.service.send(f.caller, { ...req, text: f.token })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(f.service.reply(f.caller, { ...req, kind: 'reply', requestId: randomUUID() })).rejects.toMatchObject({ code: 'denied_scope' });
    expect(f.store.getRun(b.id)?.agentInputs ?? []).toEqual([]);
  });
  it('records rejected terminal delivery without creating an obligation', async () => {
    const w = await worker(); f.store.updateRun(w.id, { status: 'review' });
    const sent = await f.service.send(f.caller, { id: randomUUID(), recipientRunId: w.id, kind: 'request', text: 'question', timeoutSeconds: 600 });
    expect(sent).toMatchObject({ delivery: 'not-delivered', message: { state: 'continuation-required' } });
    expect(f.store.getRun(w.id)?.agentInputs ?? []).toEqual([]);
    expect(sent.message.deadline).toBeUndefined();
    await expect(f.service.cancelRequest(f.caller, { requestId: sent.message.id })).rejects.toMatchObject({ code: 'denied_scope' });
  });
  it('publishes neither ledger nor input when atomic persistence fails', async () => {
    const w = await worker();
    vi.spyOn(f.store as unknown as { commitIndex(): void }, 'commitIndex').mockImplementationOnce(() => { throw Error('disk unavailable'); });
    await expect(f.service.send(f.caller, { id: randomUUID(), recipientRunId: w.id, kind: 'request', text: 'question', timeoutSeconds: 600 })).rejects.toThrow('disk unavailable');
    expect(f.store.getRun(f.parent.id)?.delegation).not.toHaveProperty('conversation');
    expect(f.store.getRun(w.id)?.agentInputs ?? []).toEqual([]);
  });
  it('cancels an accepted worker request and its wait without granting child management', async () => {
    const w = await worker();
    const sent = await f.service.send(w.caller, { id: randomUUID(), recipientRunId: f.parent.id, kind: 'request', text: 'question', timeoutSeconds: 600 });
    const cancelled = await f.service.cancelRequest(w.caller, { requestId: sent.message.id });
    expect(cancelled.status).toBe('cancelled');
    expect(await f.service.cancelRequest(w.caller, { requestId: sent.message.id })).toEqual(cancelled);
    const run = f.store.getRun(w.id)!;
    if (run.delegation?.role !== 'worker') throw Error('fixture');
    const waitId = randomUUID();
    f.store.commitDelegation([{ id: w.id, delegation: { ...run.delegation, wait: { id: waitId, workerIds: [], requestIds: [sent.message.id], phase: 'registered', outcomes: [], deadline: new Date(Date.now() + 600000).toISOString() } } }]);
    expect(await f.service.cancelWait(w.caller, { waitId })).toMatchObject({ wait: { id: waitId } });
    await expect(f.service.stop(w.caller, { workerId: w.id })).rejects.toMatchObject({ code: 'denied_scope' });
  });
  it('keeps rejected receipts rejected after Continue and replays event projections without extra inputs', async () => {
    const w = await worker(); f.store.updateRun(w.id, { status: 'review' });
    const request = { id: randomUUID(), recipientRunId: w.id, kind: 'request' as const, text: 'question', timeoutSeconds: 600 };
    const first = await f.service.send(f.caller, request);
    f.store.updateRun(w.id, { status: 'running' });
    expect(await f.service.send(f.caller, request)).toEqual(first);
    expect(f.store.getRun(w.id)?.agentInputs ?? []).toEqual([]);
    expect(f.store.readEvents(w.id).filter(event => event.type === 'conversation-message')).toHaveLength(1);
    expect(await f.service.send(f.caller, { ...request, id: randomUUID() })).toMatchObject({ message: { state: 'accepted' }, delivery: 'queued' });
  });
  it('caps undelivered inputs without evicting receipts', async () => {
    const w = await worker();
    const request = { id: randomUUID(), recipientRunId: w.id, kind: 'progress' as const, text: 'update', timeoutSeconds: 600 };
    for (let i = 0; i < 32; i++) await f.service.send(f.caller, { ...request, id: i ? randomUUID() : request.id });
    await expect(f.service.send(f.caller, { ...request, id: randomUUID() })).rejects.toMatchObject({ code: 'capacity_limit' });
    expect(await f.service.send(f.caller, request)).toMatchObject({ message: { id: request.id } });
    expect(f.store.getRun(w.id)?.agentInputs).toHaveLength(32);
  });

  it('records a late worker reply after parent Finish without waking the terminal parent', async () => {
    const w = await worker();
    const sent = await f.service.send(f.caller, { id: randomUUID(), recipientRunId: w.id, kind: 'request', text: 'question', timeoutSeconds: 600 });
    const parent = f.store.getRun(f.parent.id)!;
    if (parent.delegation?.role !== 'root') throw Error('fixture');
    // Hold lifecycle cancellation at its boundary to exercise a still-active worker reply.
    vi.spyOn(f.manager, 'cancel').mockReturnValue(true);
    f.store.updateRun(parent.id, { status: 'done', delegation: { ...parent.delegation, finishRequestedAt: new Date().toISOString() } });
    const reply = await f.service.reply(w.caller, { id: randomUUID(), recipientRunId: parent.id, kind: 'reply', requestId: sent.message.id, text: 'answer', timeoutSeconds: 600 });
    expect(reply).toMatchObject({ message: { state: 'late' }, delivery: 'not-delivered', outcome: { status: 'sender-closed' } });
    expect(f.store.getRun(parent.id)?.agentInputs ?? []).toEqual([]);
  });

  it('redacts recognizable secrets before the ledger, queue, receipts, inspection, disk and event projections', async () => {
    vi.stubEnv('CEZ_REDACT_SECRETS', '1');
    const w = await worker(); const token = 'ghp_' + 'syntheticTokenForRedaction'.repeat(2);
    const request = { id: randomUUID(), recipientRunId: w.id, kind: 'request' as const, text: `Inspect ${token}`, timeoutSeconds: 600 };
    const sent = await f.service.send(f.caller, request);
    expect(sent.message.text).toBe('Inspect [REDACTED]');
    expect(await f.service.send(f.caller, request)).toEqual(sent);
    await expect(f.service.send(f.caller, { ...request, text: 'Inspect [REDACTED]' })).rejects.toMatchObject({ code: 'invalid_input' });
    const inspected = await f.service.conversation(f.caller, { recipientRunId: w.id });
    expect(inspected.messages[0]?.text).toBe('Inspect [REDACTED]');
    expect(f.store.getRun(w.id)?.agentInputs?.[0]?.text).toBe('Inspect [REDACTED]');
    const surfaces = [f.store.getRun(f.parent.id)?.delegation, f.store.getRun(w.id)?.agentInputs, sent, inspected,
      f.store.readEvents(f.parent.id), f.store.readEvents(w.id), readFileSync(join(f.root, '.ai/cezar/runs.json'), 'utf8')];
    for (const surface of surfaces) { expect(JSON.stringify(surface)).not.toContain(token); expect(JSON.stringify(surface)).toContain('[REDACTED]'); }
  });

  it('repairs projection failure on accepted send retry and notifies delivery without another input', async () => {
    const w = await worker();
    const request = { id: randomUUID(), recipientRunId: w.id, kind: 'progress' as const, text: 'update', timeoutSeconds: 600 };
    const notify = vi.spyOn(f.manager, 'deliverConversationInput');
    vi.spyOn(f.store, 'appendEvent').mockImplementationOnce(() => { throw Error('projection unavailable'); });
    await expect(f.service.send(f.caller, request)).rejects.toThrow('projection unavailable');
    expect(f.store.getRun(w.id)?.agentInputs).toHaveLength(1); expect(notify).not.toHaveBeenCalled();
    expect(await f.service.send(f.caller, request)).toMatchObject({ delivery: 'queued' });
    expect(notify).toHaveBeenCalledWith(w.id);
    expect(f.store.getRun(w.id)?.agentInputs).toHaveLength(1);
    expect(f.store.readEvents(w.id).filter(event => event.type === 'conversation-message')).toHaveLength(1);
  });
  it('repairs cancellation projection and wake reconciliation on retry without another settlement', async () => {
    const w = await worker();
    const sent = await f.service.send(f.caller, { id: randomUUID(), recipientRunId: w.id, kind: 'request', text: 'question', timeoutSeconds: 600 });
    const reconcile = vi.spyOn(f.manager, 'reconcileWorkerWaits');
    vi.spyOn(f.store, 'appendEvent').mockImplementationOnce(() => { throw Error('projection unavailable'); });
    await expect(f.service.cancelRequest(f.caller, { requestId: sent.message.id })).rejects.toThrow('projection unavailable');
    reconcile.mockClear();
    const outcome = await f.service.cancelRequest(f.caller, { requestId: sent.message.id });
    expect(outcome.status).toBe('cancelled'); expect(reconcile).toHaveBeenCalled();
    expect(f.store.readEvents(w.id).filter(event => event.type === 'request-outcome')).toHaveLength(1);
    expect((await f.service.conversation(f.caller, { recipientRunId: w.id })).outcomes).toHaveLength(1);
  });

});
