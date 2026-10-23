import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { conversationMessageSchema } from '@open-mercato/cezar-contract/conversations';
import type { AgentInput, AskRequest } from '@open-mercato/cezar-contract';
import { answersQuestion, formatQuestionText, questionMessage } from './questions.ts';

const W = randomUUID(); const P = randomUUID();
const request: AskRequest = { questions: [{ header: 'DB', question: 'Which database?', options: [{ label: 'Postgres', description: 'Managed' }, { label: 'SQLite' }] }] };
const base = { workerRunId: W, parentRunId: P, askSeq: 7, request };

describe('parent-routed worker questions (#505)', () => {
  it('builds a schema-valid request that carries the question and no deadline', () => {
    const message = questionMessage({ ...base, now: '2026-09-24T10:00:00.000Z' });
    expect(conversationMessageSchema.parse(message)).toMatchObject({ kind: 'request', senderRunId: W, recipientRunId: P, question: request, state: 'accepted' });
    expect(message.deadline).toBeUndefined();
  });
  it('is deterministic per worker ask, so a restart reuses the same message', () => {
    expect(questionMessage({ ...base, now: 'a' }).id).toBe(questionMessage({ ...base, now: 'b' }).id);
    expect(questionMessage({ ...base, askSeq: 8, now: 'a' }).id).not.toBe(questionMessage({ ...base, now: 'a' }).id);
  });
  it('formats every question, its options and the exact reply command', () => {
    const id = randomUUID();
    const text = formatQuestionText(W, id, request);
    expect(text).toContain('Which database?');
    expect(text).toContain('Postgres');
    expect(text).toContain('Managed');
    expect(text).toContain(`worker reply ${W} '<answer>' --id <new-message-UUID> --request-id ${id}`);
    expect(text).toContain('ask the human with your own question');
    // The reply reaches the worker verbatim, so it asks for the lines a native answer parses.
    for (const question of request.questions) expect(text).toContain(`\n${question.header}: <option>`);
  });
  // hearsay-tools/cezarion#1234: a question without options takes the parent's own words.
  it('asks for the parent\'s own words on an open question', () => {
    const open: AskRequest = { questions: [...request.questions, { header: 'Name', question: 'What should the table be called?' }] };
    const text = formatQuestionText(W, randomUUID(), open);
    expect(text).toContain('2. [Name] What should the table be called? (open question: answer in your own words)');
    expect(text).toContain('\nDB: <option>\nName: <your answer>\n');
  });
  // hearsay-tools/cezarion#1458: the parent reads the worker's context above the questions.
  it('prints the context before the questions, and nothing for a question without one', () => {
    const text = formatQuestionText(W, randomUUID(), { ...request, context: '## Findings\n\n- the index is stale' });
    expect(text).toContain(`Your worker ${W} is waiting for your answer:\nContext:\n## Findings\n\n- the index is stale\n\n1. [DB] Which database?`);
    expect(formatQuestionText(W, 'id', request)).toContain(`Your worker ${W} is waiting for your answer:\n1. [DB] Which database?`);
  });
  it('treats only a reply to that question as its answer', () => {
    const message = questionMessage({ ...base, now: '2026-09-24T10:00:00.000Z' });
    const input = (kind: 'reply' | 'progress' | 'follow-up', requestId?: string): AgentInput => ({ id: randomUUID(), source: 'agent', parentRunId: P,
      text: 'Postgres', createdAt: '2026-09-24T10:01:00.000Z', conversation: { senderRunId: P, recipientRunId: W, kind, ...(requestId ? { requestId } : {}) } });
    expect(answersQuestion(message, input('reply', message.id))).toBe(true);
    expect(answersQuestion(message, input('progress'))).toBe(false);
    expect(answersQuestion(message, input('follow-up', message.id))).toBe(false);
    expect(answersQuestion(message, input('reply', randomUUID()))).toBe(false);
    expect(answersQuestion({ ...message, question: undefined }, input('reply', message.id))).toBe(false);
  });
});
