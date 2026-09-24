import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  conversationMessageSchema, humanInputDeliveredEventSchema, requestOutcomeSchema,
  workerQuestionFallbackEventSchema, workerQuestionRoutedEventSchema,
} from '@open-mercato/cezar-contract';

// #505 PR B: a worker question travels as a conversation request carrying the structured ask.
const question = { questions: [{ header: 'DB', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] };
const message = (extra: Record<string, unknown>) => ({ id: randomUUID(), senderRunId: randomUUID(), recipientRunId: randomUUID(), kind: 'request',
  text: 'Which database?', createdAt: '2026-09-24T10:00:00.000Z', requestHash: 'a'.repeat(64), state: 'accepted', ...extra });

describe('worker question contract (#505)', () => {
  it('accepts a request carrying a valid question', () => {
    expect(conversationMessageSchema.safeParse(message({ question })).success).toBe(true);
  });
  it('rejects a malformed question', () => {
    const five = { questions: Array.from({ length: 5 }, (_, i) => ({ ...question.questions[0], question: `Q${i}?` })) };
    expect(conversationMessageSchema.safeParse(message({ question: five })).success).toBe(false);
  });
  it('records a human-fallback outcome', () => {
    expect(requestOutcomeSchema.safeParse({ requestId: randomUUID(), status: 'human-fallback', observedAt: '2026-09-24T10:00:00.000Z' }).success).toBe(true);
  });
  it('parses routed and fallback events, and a parent-sourced answer checkpoint', () => {
    const base = { seq: 3, ts: '2026-09-24T10:00:00.000Z' };
    expect(workerQuestionRoutedEventSchema.safeParse({ ...base, type: 'worker-question-routed', askSeq: 2, messageId: randomUUID(), parentRunId: randomUUID() }).success).toBe(true);
    expect(workerQuestionFallbackEventSchema.safeParse({ ...base, type: 'worker-question-fallback', askSeq: 2, reason: 'parent-cancelled' }).success).toBe(true);
    expect(humanInputDeliveredEventSchema.safeParse({ ...base, type: 'human-input-delivered', askSeq: 2, source: 'parent' }).data).toMatchObject({ source: 'parent' });
    // Records written before #505 carry no source.
    expect(humanInputDeliveredEventSchema.safeParse({ ...base, type: 'human-input-delivered', askSeq: 2 }).success).toBe(true);
  });
});
