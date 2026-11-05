import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSendRequest } from '@open-mercato/cezar-contract/conversations';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { fixture } from './service.testkit.ts';

describe('reply scope before direction guidance', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { vi.stubEnv('CEZ_DELEGATION', '1'); f = fixture(); });
  afterEach(async () => { await f.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  function ownReply(provisioned = true): ConversationSendRequest {
    const peer = f.store.createRun({ title: 'peer', task: 'peer', workflow: 'quick-task', runner: 'claude', steps: [] });
    if (provisioned) f.store.commitDelegation([{ id: peer.id, delegation: { role: 'root', permissions: [], receipts: [] } }]);
    const requestId = randomUUID();
    // Persist an outgoing request directly so an absent peer ledger stays absent.
    f.store.commitConversation(f.parent.id, { messages: [{ id: requestId, senderRunId: f.parent.id, recipientRunId: peer.id,
      kind: 'request', relationship: 'peer', text: 'Question', state: 'accepted', requestHash: 'a'.repeat(64),
      createdAt: new Date().toISOString(), deadline: new Date(Date.now() + 600_000).toISOString() }], outcomes: [] });
    return { id: randomUUID(), recipientRunId: peer.id, kind: 'reply', requestId, text: 'Answer', timeoutSeconds: 600 };
  }

  function snapshot(recipientId: string) {
    return structuredClone([f.store.getRun(f.parent.id), f.store.getRun(recipientId),
      f.store.readEvents(f.parent.id), f.store.readEvents(recipientId)]);
  }

  it('denies an unprovisioned peer ledger before offering own-request guidance', async () => {
    const reply = ownReply(false);
    const before = snapshot(reply.recipientRunId);
    await expect(f.service.reply(f.caller, reply)).rejects.toMatchObject({ code: 'denied_scope', message: 'Worker scope denied' });
    expect(snapshot(reply.recipientRunId)).toEqual(before);
  });

  it.each(['missing ledger', 'history deletion'] as const)('rechecks %s at the queue head before offering own-request guidance', async change => {
    const reply = ownReply();
    const pending = f.service.reply(f.caller, reply);
    // send queues its locked operation in a promise continuation. Change scope before it runs.
    if (change === 'missing ledger') setRunStatus(f.store, reply.recipientRunId, RUN_STATUS.queued, { delegation: undefined });
    else f.store.commitDelegation([{ id: reply.recipientRunId, delegation: { role: 'root', permissions: [], receipts: [], historyDeletion: 'pending' } }]);
    const before = snapshot(reply.recipientRunId);
    await expect(pending).rejects.toMatchObject({ code: 'denied_scope', message: 'Worker scope denied' });
    expect(snapshot(reply.recipientRunId)).toEqual(before);
  });

  it('keeps both executable commands for an authorized own-peer reply without writes', async () => {
    const reply = ownReply();
    const before = snapshot(reply.recipientRunId);
    const pending = f.service.reply(f.caller, reply);
    await expect(pending).rejects.toMatchObject({ code: 'incompatible_state',
      message: expect.stringContaining(`cez message follow-up ${reply.recipientRunId} "<text>" --id <new-message-UUID> --request-id ${reply.requestId}`) });
    await expect(pending).rejects.toThrow(`cez message request ${reply.recipientRunId} "<text>" --id <new-message-UUID>`);
    expect(snapshot(reply.recipientRunId)).toEqual(before);
  });
});
