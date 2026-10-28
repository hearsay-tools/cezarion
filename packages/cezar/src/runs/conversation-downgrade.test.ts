import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { makeRunRecord, WAIT_SOURCE } from '@open-mercato/cezar-contract/test-factories.testkit';
import { decodeRunRow, parseRunRecords } from './store.ts';

// Model the schemas before hearsay-tools/cezarion#1990, as peer-wait-downgrade.test.ts
// does for waits. Keep the real store path: bad ledger data quarantines delegation;
// bad input data rejects the row. Neither becomes family or human input.
vi.mock('@open-mercato/cezar-contract/delegation', async importOriginal => {
  const actual = await importOriginal<typeof import('@open-mercato/cezar-contract/delegation')>();
  const conversation = await import('@open-mercato/cezar-contract/conversations');
  const { z } = await import('zod');
  const attribution = conversation.conversationAttributionSchema.omit({ relationship: true });
  const message = conversation.conversationMessageSchema.omit({ relationship: true });
  const outcome = conversation.requestOutcomeSchema.extend({ status: conversation.requestOutcomeSchema.shape.status.exclude(['deleted']) });
  const ledger = z.object({ messages: z.array(message).max(1024), outcomes: z.array(outcome).max(1024) }).strict();
  const [root, worker, invalid] = actual.delegationStateSchema.options;
  return { ...actual,
    delegationStateSchema: z.discriminatedUnion('role', [root.extend({ conversation: ledger.optional() }), worker, invalid]),
    agentInputSchema: actual.agentInputSchema.omit({ requestHash: true, deadline: true }).extend({ conversation: attribution.optional() }),
  };
});

const senderRunId = randomUUID();
const recipientRunId = randomUUID();
const id = randomUUID();
const createdAt = '2026-10-28T10:00:00.000Z';
const requestHash = 'a'.repeat(64);
const attribution = { senderRunId, recipientRunId, kind: 'request' as const };
const message = { ...attribution, id, text: 'Check this', createdAt, requestHash, state: 'accepted' as const };
const input = { id, parentRunId: senderRunId, source: WAIT_SOURCE.agent, text: message.text, createdAt, conversation: attribution };
const family = () => makeRunRecord({ id: senderRunId, agentInputs: [input], delegation: {
  role: 'root', permissions: [], receipts: [], conversation: { messages: [message], outcomes: [] },
} });

describe('an older cezar reading stored task conversations', () => {
  it('still reads a family ledger and input with no new fields', () => {
    const record = family();
    expect(parseRunRecords([record]).success).toBe(true);
    expect(decodeRunRow(JSON.stringify(record))?.run).toEqual(record);
  });

  it.each([
    ['peer message', { ...message, relationship: 'peer' }],
    ['explicit family message', { ...message, relationship: 'family' }],
  ])('quarantines delegation for %s attribution', (_name, storedMessage) => {
    const record = family();
    const raw = { ...record, delegation: { ...record.delegation, conversation: { messages: [storedMessage], outcomes: [] } } };
    expect(parseRunRecords([raw]).success).toBe(true);
    expect(decodeRunRow(JSON.stringify(raw))?.run.delegation).toEqual({ role: 'invalid' });
    expect(decodeRunRow(JSON.stringify(family()))).toBeDefined();
  });

  it('quarantines delegation for a deleted request outcome', () => {
    const record = family();
    const raw = { ...record, delegation: { ...record.delegation, conversation: {
      messages: [message], outcomes: [{ requestId: id, status: 'deleted', observedAt: createdAt }],
    } } };
    expect(parseRunRecords([raw]).success).toBe(true);
    expect(decodeRunRow(JSON.stringify(raw))?.run.delegation).toEqual({ role: 'invalid' });
  });

  it.each([
    ['relationship', { ...input, conversation: { ...attribution, relationship: 'peer' } }],
    ['requestHash', { ...input, requestHash }],
    ['deadline', { ...input, deadline: createdAt }],
  ])('rejects the containing row for an input with %s', (_name, storedInput) => {
    const raw = { ...family(), agentInputs: [storedInput] };
    expect(parseRunRecords([raw]).success).toBe(false);
    expect(decodeRunRow(JSON.stringify(raw))).toBeUndefined();
  });
});
