import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { apiRunSchema, runIndexEntrySchema } from '@open-mercato/cezar-contract';
import { RunStore } from './store.ts';
import { readRunIndexFromDisk } from './run-index.ts';

let dir: string, store: RunStore, id: string;
const questions = [{ header: 'Choice', question: 'Which implementation?', options: [{ label: 'First' }, { label: 'Second' }] }];
const ask = () => ({ type: 'ask.requested', requestId: 'human-question', questions });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cez-human-summary-'));
  store = RunStore.open(dir);
  const run = store.createRun({ title: 'Root', task: 'task', workflow: 'quick-task', steps: [] });
  id = run.id;
  store.updateRun(id, { status: 'waiting', delegation: { role: 'root', permissions: [], receipts: [], wait: {
    id, workerIds: [id], deadline: '2026-09-09T00:00:00.000Z', phase: 'parked', outcomes: [],
  } } });
});
afterEach(() => { store.flush(); rmSync(dir, { recursive: true, force: true }); });

it('keeps the pending-human summary in full and slim contracts', () => {
  const run = { ...store.getRun(id)!, hasPendingHumanAsk: true };
  expect(apiRunSchema.parse(run)).toHaveProperty('hasPendingHumanAsk', true);
  expect(runIndexEntrySchema.parse({ ...run, projectId: 'project' })).toHaveProperty('hasPendingHumanAsk', true);
});

it('publishes and persists human attention without changing a parked worker wait', () => {
  const news: unknown[] = [];
  store.on('run', run => news.push({ ...run }));
  store.appendEvent(id, ask());
  expect(store.getRun(id)).toHaveProperty('hasPendingHumanAsk', true);
  expect(news.at(-1)).toMatchObject({ status: 'waiting', hasPendingHumanAsk: true, delegation: { wait: { phase: 'parked' } } });
  store.flush();
  expect(JSON.parse(readFileSync(join(dir, 'runs.json'), 'utf8'))[0]).toHaveProperty('hasPendingHumanAsk', true);
});

it('only matching delivered human input retires the latest valid question', () => {
  const first = store.appendEvent(id, ask());
  const latest = store.appendEvent(id, { ...ask(), requestId: 'newer-question' });
  store.appendEvent(id, { type: 'ask.requested', requestId: 'invalid', questions: [] });
  for (const event of [
    { type: 'human-input-delivered', askSeq: first.seq },
    { type: 'human-input-delivered', askSeq: 'invalid' },
    { type: 'user-message', text: 'a failed answer attempt' },
    { type: 'agent-input', text: 'worker reply' },
    { type: 'lifecycle', message: 'session closed by user' },
  ]) store.appendEvent(id, event);
  expect(store.getRun(id)).toHaveProperty('hasPendingHumanAsk', true);
  store.appendEvent(id, { type: 'human-input-delivered', askSeq: latest.seq });
  expect(store.getRun(id)).toHaveProperty('hasPendingHumanAsk', false);
});

it.each([undefined, false])('reconstructs a pending question after a legacy/crash scalar %s without writing cold state', scalar => {
  store.flush();
  const index = JSON.parse(readFileSync(join(dir, 'runs.json'), 'utf8'));
  if (scalar !== undefined) index[0].hasPendingHumanAsk = scalar;
  const bytes = JSON.stringify(index);
  writeFileSync(join(dir, 'runs.json'), bytes);
  writeFileSync(join(dir, 'runs', `${id}.ndjson`), JSON.stringify({ ...ask(), seq: 1, ts: new Date().toISOString() }) + '\n');
  expect(RunStore.open(dir, { keepLive: true }).getRun(id)).toHaveProperty('hasPendingHumanAsk', true);
  expect(readRunIndexFromDisk(dir)[0]).toHaveProperty('hasPendingHumanAsk', true);
  expect(readFileSync(join(dir, 'runs.json'), 'utf8')).toBe(bytes);
});

it('reconciles a stale true summary from a matching durable answer', () => {
  store.flush();
  const index = JSON.parse(readFileSync(join(dir, 'runs.json'), 'utf8')); index[0].hasPendingHumanAsk = true;
  writeFileSync(join(dir, 'runs.json'), JSON.stringify(index));
  writeFileSync(join(dir, 'runs', `${id}.ndjson`), [
    { ...ask(), seq: 1, ts: new Date().toISOString() },
    { type: 'human-input-delivered', askSeq: 1, seq: 2, ts: new Date().toISOString() },
  ].map(event => JSON.stringify(event)).join('\n') + '\n');
  expect(RunStore.open(dir, { keepLive: true }).getRun(id)).toHaveProperty('hasPendingHumanAsk', false);
  expect(readRunIndexFromDisk(dir)[0]).toHaveProperty('hasPendingHumanAsk', false);
});

it.each([undefined, false, true])('requests human attention when history is unreadable and the saved summary is %s', scalar => {
  store.flush();
  const index = JSON.parse(readFileSync(join(dir, 'runs.json'), 'utf8')); index[0].hasPendingHumanAsk = scalar;
  writeFileSync(join(dir, 'runs.json'), JSON.stringify(index));
  const events = join(dir, 'runs', `${id}.ndjson`); rmSync(events, { force: true }); mkdirSync(events);
  expect(RunStore.open(dir, { keepLive: true }).getRun(id)).toHaveProperty('hasPendingHumanAsk', true);
  expect(readRunIndexFromDisk(dir)[0]).toHaveProperty('hasPendingHumanAsk', true);
});

it('keeps legacy pure worker waits free of human attention when no history exists', () => {
  store.flush();
  expect(RunStore.open(dir, { keepLive: true }).getRun(id)).toHaveProperty('hasPendingHumanAsk', false);
  expect(readRunIndexFromDisk(dir)[0]).toHaveProperty('hasPendingHumanAsk', false);
});

it('recovers human attention for a running root with a durable worker wait before manager recovery parks it', () => {
  store.updateRun(id, { status: 'running', hasPendingHumanAsk: false });
  store.flush();
  writeFileSync(join(dir, 'runs', `${id}.ndjson`), JSON.stringify({ ...ask(), seq: 1, ts: new Date().toISOString() }) + '\n');
  expect(RunStore.open(dir, { keepLive: true }).getRun(id)).toMatchObject({ status: 'running', hasPendingHumanAsk: true });
  expect(readRunIndexFromDisk(dir)[0]).toMatchObject({ status: 'failed', hasPendingHumanAsk: true });
});
