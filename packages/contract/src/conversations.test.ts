import { describe, expect, it } from 'vitest';
import { conversationCursorSchema, decodeConversationCursor, encodeConversationCursor,
  conversationSendRequestSchema, inboxReserveResultSchema, requestWaitRequestSchema } from './conversations.ts';

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
