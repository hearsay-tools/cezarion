import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ConversationMessage, Wait } from '@open-mercato/cezar-contract';
import { conversationMessageSchema } from '@open-mercato/cezar-contract/conversations';
import type { RunEvent } from '../runs/store.ts';
import { PARK_NOTICE_EXCERPT_MAX, formatParkNoticeText, messagedParentSince, parkNoticeExcerpt, parkNoticeId, parkNoticeMessage, parkNoticeWait, parkingTurn } from './park-notice.ts';

const worker = randomUUID();
const parent = randomUUID();
const wait = randomUUID();
const timer: Extract<Wait, { kind: 'timer' }> = { id: randomUUID(), kind: 'timer', source: 'agent', via: 'monitoring-line', registeredAt: '2026-10-20T12:13:00.000Z',
  seconds: 600, deadline: '2026-10-20T12:23:00.000Z', phase: 'open', turnId: 'monitoring', note: 'Opened by CEZ:MONITORING.' };
let seq = 0;
const event = (type: string, fields: Record<string, unknown> = {}): RunEvent => ({ seq: ++seq, ts: `2026-10-20T12:${String(10 + seq).padStart(2, '0')}:00.000Z`, type, ...fields });

describe('park notices (hearsay-tools/cezarion#1327)', () => {
  it('derives one ID per worker and parent wait', () => {
    expect(parkNoticeId(worker, wait)).toBe(parkNoticeId(worker, wait));
    expect(parkNoticeId(worker, randomUUID())).not.toBe(parkNoticeId(worker, wait));
    expect(parkNoticeId(randomUUID(), wait)).not.toBe(parkNoticeId(worker, wait));
  });

  const message = (fields: Partial<ConversationMessage>): ConversationMessage => ({ id: randomUUID(), senderRunId: parent, recipientRunId: worker,
    kind: 'request', text: 'check', createdAt: '2026-10-20T12:13:00.000Z', requestHash: 'hash', state: 'accepted', ...fields } as ConversationMessage);
  const workerWait = (fields: Record<string, unknown>): Wait => ({ id: randomUUID(), kind: 'worker', source: 'agent', via: 'cezar_wait',
    registeredAt: '2026-10-20T12:13:00.000Z', deadline: '2026-10-20T12:23:00.000Z', phase: 'open', ...fields } as Wait);

  it('picks the first open wait that selects the worker, by its ID or by a request to it, with no notice from it yet', () => {
    const request = randomUUID();
    const byId = workerWait({ workerIds: [worker] });
    const byRequest = workerWait({ requestIds: [request] });
    const waits = [timer, workerWait({ workerIds: [worker], phase: 'delivered' }), workerWait({ workerIds: [randomUUID()] }), byId, byRequest];
    const messages = [message({ id: request })];
    expect(parkNoticeWait(worker, waits, messages)).toBe(byId);
    expect(parkNoticeWait(worker, waits, [...messages, message({ id: parkNoticeId(worker, byId.id) })])).toBe(byRequest);
    // A request to another worker does not select this one.
    expect(parkNoticeWait(worker, [byRequest], [message({ id: request, recipientRunId: randomUUID() })])).toBeUndefined();
  });

  it('knows whether the parking turn already messaged the parent', () => {
    const since = '2026-10-20T12:13:00.000Z';
    const sent = (createdAt: string, recipientRunId = parent) => [message({ senderRunId: worker, recipientRunId, kind: 'progress', createdAt })];
    expect(messagedParentSince(sent(since), worker, parent, since)).toBe(true);
    expect(messagedParentSince(sent('2026-10-20T12:12:59.000Z'), worker, parent, since)).toBe(false);
    expect(messagedParentSince(sent(since, randomUUID()), worker, parent, since)).toBe(false);
    expect(messagedParentSince(sent(since), worker, parent, undefined)).toBe(false);
  });

  it('reads the parking turn: its start and its last top-level assistant text, not a subagent\'s or an earlier turn\'s', () => {
    const events = [
      event('text', { text: 'earlier turn' }),
      event('turn.started', { turnId: 't2' }),
      event('item.completed', { item: { kind: 'message', role: 'assistant', text: 'Squeal is still pending.' } }),
      event('item.completed', { item: { kind: 'message', role: 'assistant', text: 'nested', parentItemId: 'p' } }),
      event('text', { text: 'subagent', parentItemId: 'p' }),
      event('tool-call', { tool: 'Bash' }),
    ];
    expect(parkingTurn(events)).toEqual({ startedAt: events[1]!.ts, text: 'Squeal is still pending.' });
    expect(parkingTurn(events.slice(0, 1))).toEqual({ text: 'earlier turn' });
    expect(parkingTurn([event('turn.started')])).toEqual({ startedAt: expect.any(String) });
    expect(parkingTurn([])).toEqual({});
  });

  it('quotes the worker without Cezar control lines, and cuts a long message', () => {
    expect(parkNoticeExcerpt('Waiting on Squeal.\nCEZ:MONITORING')).toBe('Waiting on Squeal.');
    expect(parkNoticeExcerpt('  CEZ:DONE\nCEZ:TITLE=x')).toBeUndefined();
    const long = parkNoticeExcerpt('x'.repeat(PARK_NOTICE_EXCERPT_MAX + 5))!;
    expect(long).toHaveLength(PARK_NOTICE_EXCERPT_MAX + 1);
    expect(long.endsWith('…')).toBe(true);
  });

  it('names what the worker waits on, what it last said, and how to reach it', () => {
    const text = formatParkNoticeText({ workerRunId: worker, waitId: wait, waits: [timer], lastText: 'Squeal times out harness-parity.test.ts.\nCEZ:MONITORING' });
    expect(text).toContain(`Cezar notice: your worker ${worker} parked before finishing. Your wait ${wait} stays open`);
    expect(text).toContain(`It waits on: timer ${timer.id} at ${timer.deadline} (Opened by CEZ:MONITORING.).`);
    expect(text).toContain('Its last message:\nSqueal times out harness-parity.test.ts.');
    expect(text).not.toContain('\nCEZ:MONITORING');
    expect(text).toContain(`worker inspect ${worker}`);
    expect(text).toContain(`message request ${worker} '<instruction>'`);
  });

  it('says a worker with no open wait waits for its parent, and leaves out settled waits and a missing message', () => {
    const settled: Wait = { ...timer, id: randomUUID(), phase: 'delivered' } as Wait;
    const text = formatParkNoticeText({ workerRunId: worker, waitId: wait, waits: [settled] });
    expect(text).toContain('It has no open wait: it waits for a message from you.');
    expect(text).not.toContain(settled.id);
    expect(text).not.toContain('Its last message');
  });

  it('is a valid progress message from the worker to its parent, redacted', () => {
    const message = parkNoticeMessage({ workerRunId: worker, parentRunId: parent, waitId: wait, waits: [timer], lastText: 'token SECRET here',
      now: '2026-10-20T12:13:00.000Z', redact: text => text.replaceAll('SECRET', '[redacted]') });
    expect(conversationMessageSchema.parse(message)).toEqual(message);
    expect(message).toMatchObject({ id: parkNoticeId(worker, wait), senderRunId: worker, recipientRunId: parent, kind: 'progress', state: 'accepted' });
    expect(message.text).toContain('token [redacted] here');
    expect(message).not.toHaveProperty('deadline');
    expect(message).not.toHaveProperty('question');
  });
});
