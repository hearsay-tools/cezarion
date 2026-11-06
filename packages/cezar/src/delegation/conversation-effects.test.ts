import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { setRunStatus, runPersistence } from '../runs/run-store.testkit.ts';
import { fixture } from './service.testkit.ts';

describe('committed message effects', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { f = fixture(); });
  afterEach(async () => { vi.restoreAllMocks(); await f.close(); vi.unstubAllEnvs(); });

  async function worker() {
    const { workerId } = await f.service.spawn(f.caller, { task: 'work', baseline: 'parent-head', requestId: randomUUID() });
    setRunStatus(f.store, workerId, RUN_STATUS.running);
    vi.spyOn(f.manager, 'deliverConversationInput').mockImplementation(() => {});
    return workerId;
  }
  const faultAt = (step: 'projection' | 'reconcile' | 'delivery') => {
    const fault = () => { throw Error(`${step} failed`); };
    if (step === 'projection') return vi.spyOn(f.store, 'appendEvent').mockImplementation(fault);
    if (step === 'reconcile') return vi.spyOn(f.manager, 'reconcileWorkerWaits').mockImplementation(fault);
    return vi.mocked(f.manager.deliverConversationInput).mockImplementation(fault);
  };

  for (const retry of [false, true]) {
    it.each(['projection', 'reconcile', 'delivery'] as const)(`returns the committed receipt after %s fails on ${retry ? 'an exact retry' : 'a fresh send'}`, async step => {
      const recipientRunId = await worker();
      const request = { id: randomUUID(), recipientRunId, kind: 'request' as const, text: 'Question', timeoutSeconds: 600 };
      if (retry) {
        // Leave a committed message without projections, as a failed first repair would.
        const blocked = step === 'projection' ? vi.spyOn(f.store, 'appendEvent').mockImplementation(() => { throw Error('initial projection failed'); }) : undefined;
        await f.service.send(f.caller, request).catch(error => { if (!blocked) throw error; });
        blocked?.mockRestore();
      }
      const fault = faultAt(step);
      const receipt = await f.service.send(f.caller, request);
      expect(fault).toHaveBeenCalled();
      expect(receipt).toMatchObject({ effect: retry ? 'unchanged' : 'applied', delivery: 'queued', message: { id: request.id, state: 'accepted' } });
      expect(receipt.outcome).toBeUndefined();
      const ledger = f.store.getRun(f.parent.id)?.delegation;
      expect(ledger).toMatchObject({ conversation: { messages: [receipt.message], outcomes: [] } });
      expect(f.store.getRun(recipientRunId)?.agentInputs).toMatchObject([{ id: request.id }]);
      expect(f.store.getRun(recipientRunId)?.agentInputs).toHaveLength(1);
      const deliveries = vi.mocked(f.manager.deliverConversationInput);
      expect(deliveries).toHaveBeenCalledTimes((retry && step !== 'projection' ? 1 : 0) + (step === 'delivery' ? 1 : 0));
      fault.mockRestore();
      vi.spyOn(f.manager, 'deliverConversationInput').mockImplementation(() => {});
      expect(await f.service.send(f.caller, request)).toEqual({ ...receipt, effect: 'unchanged' });
      expect(f.store.getRun(recipientRunId)?.agentInputs).toHaveLength(1);
      expect(f.store.readEvents(recipientRunId).filter(event => event.type === 'conversation-message')).toHaveLength(1);
    });
  }

  it('keeps a committed refusal and never attempts delivery during repair', async () => {
    const recipientRunId = await worker();
    setRunStatus(f.store, recipientRunId, RUN_STATUS.review);
    const fault = faultAt('reconcile');
    const request = { id: randomUUID(), recipientRunId, kind: 'request' as const, text: 'Question', timeoutSeconds: 600 };
    const refused = await f.service.send(f.caller, request);
    expect(refused).toMatchObject({ effect: 'refused', delivery: 'not-delivered', message: { state: 'continuation-required' } });
    expect(await f.service.send(f.caller, request)).toEqual({ ...refused, effect: 'unchanged' });
    expect(f.manager.deliverConversationInput).not.toHaveBeenCalled();
    expect(f.store.getRun(recipientRunId)?.agentInputs ?? []).toEqual([]);
    fault.mockRestore();
  });

  it('reports committed delivery after a delivery callback writes its acknowledgement then throws', async () => {
    const recipientRunId = await worker();
    const request = { id: randomUUID(), recipientRunId, kind: 'request' as const, text: 'Question', timeoutSeconds: 600 };
    const at = new Date().toISOString();
    const delivery = vi.mocked(f.manager.deliverConversationInput).mockImplementation(() => {
      f.store.commitOutcome(recipientRunId, { kind: 'delivered', inputIds: [request.id], at });
      throw Error('after acknowledgement');
    });
    const receipt = await f.service.send(f.caller, request);
    expect(receipt).toMatchObject({ effect: 'applied', delivery: 'delivered' });
    expect(await f.service.send(f.caller, request)).toEqual({ ...receipt, effect: 'unchanged' });
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(f.store.getRun(recipientRunId)?.agentInputs).toHaveLength(1);
  });

  it('returns the committed reply outcome when wait reconciliation fails', async () => {
    const workerId = await worker();
    const request = await f.service.send(f.caller, { id: randomUUID(), recipientRunId: workerId, kind: 'request', text: 'Question', timeoutSeconds: 600 });
    const caller = f.credentials.authenticate(f.credentials.issue('project', workerId, randomUUID()))!;
    faultAt('reconcile');
    const reply = { id: randomUUID(), recipientRunId: f.parent.id, kind: 'reply' as const, requestId: request.message.id, text: 'Answer', timeoutSeconds: 600 };
    const receipt = await f.service.reply(caller, reply);
    expect(receipt).toMatchObject({ effect: 'applied', delivery: 'queued', outcome: { requestId: request.message.id, replyId: reply.id, status: 'replied' } });
    expect(await f.service.reply(caller, reply)).toEqual({ ...receipt, effect: 'unchanged' });
    expect(f.store.getRun(f.parent.id)?.agentInputs).toMatchObject([{ id: reply.id }]);
    expect(f.store.getRun(f.parent.id)?.agentInputs).toHaveLength(1);
  });

  it('propagates a precommit failure without accepting a message', async () => {
    const recipientRunId = await worker();
    vi.spyOn(runPersistence(f.store), 'persist').mockImplementationOnce(() => { throw Error('disk unavailable'); });
    await expect(f.service.send(f.caller, { id: randomUUID(), recipientRunId, kind: 'request', text: 'Question', timeoutSeconds: 600 })).rejects.toThrow('disk unavailable');
    expect(f.store.getRun(f.parent.id)?.delegation).not.toHaveProperty('conversation');
    expect(f.store.getRun(recipientRunId)?.agentInputs ?? []).toEqual([]);
    expect(f.manager.deliverConversationInput).not.toHaveBeenCalled();
  });

  it('gives executable follow-up and new-request commands for an outgoing reply', async () => {
    const recipientRunId = await worker();
    const request = { id: randomUUID(), recipientRunId, kind: 'request' as const, text: 'Question', timeoutSeconds: 600 };
    await f.service.send(f.caller, request);
    const reply = { ...request, id: randomUUID(), kind: 'reply' as const, requestId: request.id };
    const refusal = f.service.reply(f.caller, reply);
    await expect(refusal).rejects.toMatchObject({ code: 'incompatible_state', message: expect.stringContaining(`cez message follow-up ${recipientRunId} "<text>" --id <new-message-UUID> --request-id ${request.id}`) });
    await expect(refusal).rejects.toThrow(`cez message request ${recipientRunId} "<text>" --id <new-message-UUID>`);
    expect(f.store.getRun(f.parent.id)?.delegation).toMatchObject({ conversation: { messages: [expect.objectContaining({ id: request.id })], outcomes: [] } });
    expect(f.store.getRun(recipientRunId)?.agentInputs).toHaveLength(1);
  });
});
