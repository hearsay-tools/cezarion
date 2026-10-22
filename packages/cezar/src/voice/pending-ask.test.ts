import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { HumanWaitEntry } from '@open-mercato/cezar-contract/waits';
import { readPendingHumanAsk } from './pending-ask.ts';

let dir: string;
const id = 'run-1';
const questions = [{ header: 'Choice', question: 'Which implementation?', options: [{ label: 'First' }, { label: 'Second' }] }];
const ts = '2026-10-21T10:00:00.000Z';
const writeHistory = (events: object[]) =>
  writeFileSync(join(dir, 'runs', `${id}.ndjson`), events.map(event => JSON.stringify({ ts, ...event })).join('\n') + '\n');
const humanWait = (fields: Partial<HumanWaitEntry>): HumanWaitEntry => ({
  id: '00000000-0000-4000-8000-000000000001', kind: 'human', source: 'agent', via: 'cezar_ask',
  registeredAt: ts, phase: 'open', turnId: 'turn-1', ...fields,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cez-voice-pending-ask-'));
  mkdirSync(join(dir, 'runs'));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

it('reads the pending ask from history', () => {
  writeHistory([{ type: 'ask.requested', requestId: 'human-question', questions, seq: 1 }]);
  expect(readPendingHumanAsk(dir, { id })).toEqual({ requestId: 'human-question', questions });
});

it('returns undefined after the answer is delivered', () => {
  writeHistory([
    { type: 'ask.requested', requestId: 'human-question', questions, seq: 1 },
    { type: 'human-input-delivered', askSeq: 1, seq: 2 },
  ]);
  expect(readPendingHumanAsk(dir, { id })).toBeUndefined();
});

it('returns undefined when the run has no history or it cannot be read', () => {
  rmSync(join(dir, 'runs'), { recursive: true });
  expect(readPendingHumanAsk(dir, { id })).toBeUndefined();
  mkdirSync(join(dir, 'runs', `${id}.ndjson`), { recursive: true });
  expect(readPendingHumanAsk(dir, { id })).toBeUndefined();
});

it('offers the card when the open human wait names this ask', () => {
  writeHistory([{ type: 'ask.requested', requestId: 'human-question', questions, seq: 3 }]);
  expect(readPendingHumanAsk(dir, { id, waits: [humanWait({ askSeq: 3, questions })] }))
    .toEqual({ requestId: 'human-question', questions });
});

it('offers no card when the open human wait names another ask', () => {
  writeHistory([{ type: 'ask.requested', requestId: 'human-question', questions, seq: 3 }]);
  expect(readPendingHumanAsk(dir, { id, waits: [humanWait({ askSeq: 7 })] })).toBeUndefined();
});

it('offers the card a terminal run still shows: no open wait, unretired ask', () => {
  // A terminal run cancels its open waits, but the card stays answerable through Continue.
  writeHistory([{ type: 'ask.requested', requestId: 'human-question', questions, seq: 3 }]);
  const cancelled = humanWait({ askSeq: 3, phase: 'cancelled', cancelledAt: ts });
  expect(readPendingHumanAsk(dir, { id, waits: [cancelled] })).toEqual({ requestId: 'human-question', questions });
  expect(readPendingHumanAsk(dir, { id, waits: [] })).toEqual({ requestId: 'human-question', questions });
});
