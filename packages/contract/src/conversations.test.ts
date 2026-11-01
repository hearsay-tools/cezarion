import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { conversationCursorSchema, decodeConversationCursor, encodeConversationCursor,
  conversationSendRequestSchema, inboxReserveResultSchema, requestWaitRequestSchema,
  conversationCancelRequestSchema, conversationInspectRequestSchema, conversationInspectResultSchema, conversationSendResultSchema,
  conversationStateSchema, inboxReceiptRequestSchema, inboxReceiptResultSchema } from './conversations.ts';

const id = 'abcdef01-2345-4678-9abc-def012345678';
const other = 'abcdef01-2345-4678-9abc-def012345679';

describe('conversation history cursor', () => {
  it.each(['2026-10-30T12:34:56Z', '2026-10-30T12:34:56.123456Z'])('preserves both cursor fields for %s', createdAt => {
    const cursor = `${createdAt}~${id}`;
    expect(encodeConversationCursor({ createdAt, id })).toBe(cursor);
    expect(decodeConversationCursor(cursor)).toEqual({ createdAt, id });
    expect(conversationCursorSchema.parse(cursor)).toBe(cursor);
    expect(decodeConversationCursor(`${createdAt}~${id.toUpperCase()}`)).toEqual({ createdAt, id: id.toUpperCase() });
  });

  it.each(['', `x2026-10-30T12:34:56Z~${id}`, `2026-10-30T12:34:56Z~${id}x`,
    `2026-10-30T12:34:56~${id}`, `2026-10-30T12:34:56.Z~${id}`,
    `2026-10-30T12:34:56Z/${id}`, '2026-10-30T12:34:56Z~not-an-id'])('refuses malformed cursor %j', cursor => {
    expect(conversationCursorSchema.safeParse(cursor).success).toBe(false);
    expect(() => decodeConversationCursor(cursor)).toThrow('Not a history cursor');
  });
});

describe('conversation request rules', () => {
  const request = { id, recipientRunId: other, kind: 'request', text: 'inspect this' };

  it('defaults the request deadline and limits extended deadlines to resume requests', () => {
    expect(conversationSendRequestSchema.parse(request).timeoutSeconds).toBe(600);
    expect(conversationSendRequestSchema.safeParse({ ...request, timeoutSeconds: 1800 }).success).toBe(true);
    expect(conversationSendRequestSchema.safeParse({ ...request, timeoutSeconds: 1801 }).success).toBe(false);
    expect(conversationSendRequestSchema.safeParse({ ...request, resume: false, timeoutSeconds: 1801 }).success).toBe(false);
    expect(conversationSendRequestSchema.safeParse({ ...request, resume: true, timeoutSeconds: 86400 }).success).toBe(true);
    expect(conversationSendRequestSchema.safeParse({ ...request, resume: true, timeoutSeconds: 86401 }).success).toBe(false);
    expect(conversationSendRequestSchema.safeParse({ ...request, kind: 'progress', resume: true, timeoutSeconds: 1801 }).success).toBe(false);
  });

  it.each(['request', 'progress', 'reply', 'follow-up'])('checks request attribution and resume for %s', kind => {
    const attributed = kind === 'reply' || kind === 'follow-up';
    expect(conversationSendRequestSchema.safeParse({ ...request, kind }).success).toBe(!attributed);
    expect(conversationSendRequestSchema.safeParse({ ...request, kind, requestId: id }).success).toBe(attributed);
    const input = { ...request, kind, ...(attributed ? { requestId: id } : {}) };
    expect(conversationSendRequestSchema.safeParse({ ...input, resume: true }).success).toBe(!attributed);
    expect(conversationSendRequestSchema.safeParse({ ...input, resume: false }).success).toBe(true);
  });

  it('refuses whitespace-only messages and duplicate request wait ids', () => {
    expect(conversationSendRequestSchema.safeParse({ ...request, text: ' \n\t' }).success).toBe(false);
    expect(requestWaitRequestSchema.safeParse({ requestIds: [id, id] }).success).toBe(false);
    expect(requestWaitRequestSchema.parse({ requestIds: [id] })).toEqual({ requestIds: [id], timeoutSeconds: 600 });
    expect(requestWaitRequestSchema.safeParse({ requestIds: [id, other], mode: 'one' }).success).toBe(false);
    expect(requestWaitRequestSchema.safeParse({ requestIds: [id], mode: 'one' }).success).toBe(true);
    expect(requestWaitRequestSchema.safeParse({ requestIds: [id, other], mode: 'all' }).success).toBe(true);
  });
});

describe('inbox receipt membership', () => {
  const message = { id, senderRunId: id, recipientRunId: other, kind: 'progress', text: 'ready',
    createdAt: '2026-10-30T12:34:56Z', requestHash: 'a'.repeat(64), state: 'accepted' };
  const receipt = { receiptId: id, expiresAt: '2026-10-30T12:35:56Z' };

  it('requires both receipt fields exactly when the batch contains messages', () => {
    for (const messages of [[], [message]]) {
      expect(inboxReserveResultSchema.safeParse({ messages, outcomes: [] }).success).toBe(messages.length === 0);
      expect(inboxReserveResultSchema.safeParse({ messages, outcomes: [], ...receipt }).success).toBe(messages.length > 0);
      expect(inboxReserveResultSchema.safeParse({ messages, outcomes: [], receiptId: id }).success).toBe(false);
      expect(inboxReserveResultSchema.safeParse({ messages, outcomes: [], expiresAt: receipt.expiresAt }).success).toBe(false);
    }
  });
});

/** The schema takes the value and returns it unchanged: no field dropped, renamed or added. */
const accepts = (schema: z.ZodType, value: unknown) => expect(schema.parse(value)).toEqual(value);
const refuses = (schema: z.ZodType, value: unknown) => expect(schema.safeParse(value).success).toBe(false);
const issuesOf = (schema: z.ZodType, value: unknown) =>
  schema.safeParse(value).error?.issues.map(({ code, message, path }) => ({ code, message, path }));
/** Every listed value is accepted under `key`, and a value outside the list is refused. */
function acceptsEach(schema: z.ZodType, base: Record<string, unknown>, key: string, values: readonly unknown[]) {
  for (const value of values) accepts(schema, { ...base, [key]: value });
  refuses(schema, { ...base, [key]: 'not-a-listed-value' });
}

describe('conversation records', () => {
  const T = '2026-10-30T12:34:56Z';
  const hash = 'a'.repeat(64);
  const message = { senderRunId: id, recipientRunId: other, kind: 'reply', requestId: other, relationship: 'peer', id, text: 'done',
    createdAt: T, deadline: T, requestHash: hash, state: 'accepted', resumed: true, instruction: 'continue' };
  const outcome = { requestId: id, status: 'replied', observedAt: T, replyId: other };
  const state = { messages: [message, { ...message, id: other }], outcomes: [outcome, { ...outcome, requestId: other }] };

  it('keeps every message field and accepts each relationship and state', () => {
    accepts(conversationStateSchema, state);
    acceptsEach(conversationStateSchema, state, 'messages', [['family', 'peer'].map(relationship => ({ ...message, relationship }))]);
    acceptsEach(conversationStateSchema, state, 'messages', [['accepted', 'continuation-required', 'destroyed', 'late'].map(value => ({ ...message, state: value }))]);
    for (const bad of [{ relationship: 'parent' }, { state: 'queued' }, { resumed: false }, { instruction: 'i'.repeat(2049) }, { text: '' }]) {
      refuses(conversationStateSchema, { messages: [{ ...message, ...bad }], outcomes: [] });
    }
    accepts(conversationStateSchema, { messages: [{ ...message, instruction: 'i'.repeat(2048) }], outcomes: [] });
  });

  it('accepts only a whole 64-digit lowercase request hash', () => {
    for (const requestHash of [`g${hash}`, `${hash}g`, 'a'.repeat(63), hash.toUpperCase()]) {
      refuses(conversationStateSchema, { messages: [{ ...message, requestHash }], outcomes: [] });
    }
  });

  it('accepts every request outcome status', () => {
    const statuses = ['replied', 'replied-late', 'completed-without-reply', 'failed', 'cancelled', 'destroyed', 'timed-out',
      'sender-closed', 'human-fallback', 'deleted'];
    acceptsEach(conversationStateSchema, state, 'outcomes', [statuses.map(status => ({ ...outcome, status }))]);
    refuses(conversationStateSchema, { messages: [], outcomes: [{ ...outcome, status: 'not-a-listed-value' }] });
    refuses(conversationStateSchema, { messages: [], outcomes: [{ ...outcome, extra: true }] });
  });

  it('keeps the inspect page fields and refuses unknown ones', () => {
    accepts(conversationInspectResultSchema, { ...state, hint: 'older pages exist', nextBefore: encodeConversationCursor({ createdAt: T, id }) });
    refuses(conversationInspectResultSchema, { ...state, nextBefore: 'page-2' });
    refuses(conversationStateSchema, { ...state, hint: 'h' });
  });

  it('keeps every send result delivery', () => {
    acceptsEach(conversationSendResultSchema, { message, outcome }, 'delivery', ['queued', 'delivered', 'consumed', 'not-delivered']);
    refuses(conversationSendResultSchema, { message, delivery: 'queued', extra: true });
  });

  it('keeps the inspect, cancel and receipt requests strict', () => {
    accepts(conversationInspectRequestSchema, { recipientRunId: id, before: `${T}~${id}` });
    refuses(conversationInspectRequestSchema, { recipientRunId: id, extra: true });
    accepts(conversationCancelRequestSchema, { requestId: id });
    refuses(conversationCancelRequestSchema, { requestId: id, extra: true });
    accepts(inboxReceiptRequestSchema, { receiptId: id });
    refuses(inboxReceiptRequestSchema, { receiptId: id, extra: true });
    acceptsEach(inboxReceiptResultSchema, { receiptId: id }, 'status', ['acknowledged', 'already-acknowledged', 'released']);
  });
});

describe('conversation refusal details', () => {
  const request = { id, recipientRunId: other, kind: 'request', text: 'inspect this' };

  it('names each refused send combination at its path', () => {
    expect(issuesOf(conversationSendRequestSchema, { ...request, timeoutSeconds: 1801 })).toEqual([
      { code: 'custom', message: 'Only --resume requests accept deadlines above 1800 seconds (maximum 86400)', path: ['timeoutSeconds'] },
    ]);
    expect(issuesOf(conversationSendRequestSchema, { ...request, kind: 'reply' })).toEqual([
      { code: 'custom', message: 'Replies and follow-ups require a request ID; new messages must omit it', path: [] },
    ]);
    expect(issuesOf(conversationSendRequestSchema, { ...request, kind: 'reply', requestId: other, resume: true })).toEqual([
      { code: 'custom', message: '--resume requires a new request or progress instruction', path: [] },
    ]);
  });

  it('names the refused inbox batch and the refused one-request wait', () => {
    expect(issuesOf(inboxReserveResultSchema, { messages: [], outcomes: [], receiptId: id })).toEqual([
      { code: 'custom', message: 'A nonempty inbox batch requires a receipt and expiry', path: [] },
    ]);
    expect(issuesOf(requestWaitRequestSchema, { requestIds: [id, other], mode: 'one' })).toEqual([
      { code: 'custom', message: 'one requires exactly one request', path: [] },
    ]);
  });

  it('bounds the request wait deadline and accepts every mode', () => {
    for (const timeoutSeconds of [1, 900, 1800]) accepts(requestWaitRequestSchema, { requestIds: [id], timeoutSeconds });
    for (const timeoutSeconds of [0, 1801, 1.5]) refuses(requestWaitRequestSchema, { requestIds: [id], timeoutSeconds });
    acceptsEach(requestWaitRequestSchema, { requestIds: [id], timeoutSeconds: 600 }, 'mode', ['one', 'any', 'all']);
  });
});
