import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { apiRunSchema, runIndexEntrySchema, toRunSummary } from '@open-mercato/cezar-contract/runs';
import { RunStore } from './store.ts';
import { readRunIndexFromDisk } from './run-index.ts';
import { readPersistedRuns, seedRuns } from './run-store.testkit.ts';

/**
 * Phase 4b (hearsay-tools/cezarion#1236): a pending question is an open human wait. The record no
 * longer carries the `hasPendingHumanAsk` summary; a stored one is read into the wait list once.
 */
let dir: string, store: RunStore, id: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cez-legacy-ask-'));
  store = RunStore.open(dir);
  id = store.createRun({ title: 'Root', task: 'task', workflow: 'quick-task', steps: [] }).id;
  store.updateRun(id, { status: 'waiting' });
  store.close();
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

/** Rewrite the stored row as an older cezar left it, then reopen. */
function reopenWith(patch: Record<string, unknown>): RunStore {
  const [row] = readPersistedRuns(dir);
  seedRuns(dir, [{ ...row, ...patch }]);
  store = RunStore.open(dir, { keepLive: true });
  return store;
}

const human = (record: { waits?: ReadonlyArray<{ kind: string; phase: string }> } | undefined) =>
  (record?.waits ?? []).filter((wait) => wait.kind === 'human' && wait.phase === 'open');

it('reads a waiting run\'s stored pending question into one open human wait and drops the summary', () => {
  const run = reopenWith({ hasPendingHumanAsk: true }).getRun(id);
  expect(human(run)).toEqual([expect.objectContaining({ kind: 'human', source: 'agent', via: 'ask-line', phase: 'open', turnId: 'legacy' })]);
  expect(human(run)[0]).not.toHaveProperty('askSeq');
  expect(run).not.toHaveProperty('hasPendingHumanAsk');
  expect(toRunSummary(run!).waitingOn).toEqual({ kind: 'human' });
  store.flush();
  // The committed row holds the wait and no summary, so a later read does not upgrade again.
  expect(readPersistedRuns(dir)[0]).not.toHaveProperty('hasPendingHumanAsk');
  expect(human(readPersistedRuns(dir)[0])).toHaveLength(1);
});

it('upgrades to the same wait on every read', () => {
  const first = human(reopenWith({ hasPendingHumanAsk: true }).getRun(id))[0];
  store.close();
  const cold = readRunIndexFromDisk(dir).runs[0];
  store = RunStore.open(dir, { keepLive: true });
  expect(human(store.getRun(id))).toEqual([first]);
  expect(cold?.waitingOn).toEqual({ kind: 'human' });
  expect(cold).not.toHaveProperty('hasPendingHumanAsk');
});

it('the cold index reads an un-upgraded row as waiting on the user', () => {
  const [row] = readPersistedRuns(dir);
  seedRuns(dir, [{ ...row, hasPendingHumanAsk: true }]);
  const cold = readRunIndexFromDisk(dir).runs[0];
  expect(cold?.waitingOn).toEqual({ kind: 'human' });
  expect(cold).not.toHaveProperty('hasPendingHumanAsk');
  store = RunStore.open(dir, { keepLive: true });
});

it('adds no second wait beside an open human wait', () => {
  const wait = { id: '0b8f4c7e-8a43-4f1e-9a3e-1d2f3a4b5c6d', kind: 'human', source: 'agent', via: 'cezar_ask',
    registeredAt: new Date().toISOString(), phase: 'open', turnId: 'turn', askSeq: 3 };
  expect(human(reopenWith({ hasPendingHumanAsk: true, waits: [wait] }).getRun(id))).toEqual([wait]);
});

it.each([
  ['a false summary on a waiting run', { hasPendingHumanAsk: false }],
  ['a true summary on a finished run', { hasPendingHumanAsk: true, status: 'done', finishedAt: new Date().toISOString() }],
])('drops %s without opening a wait', (_name, patch) => {
  const run = reopenWith(patch).getRun(id);
  expect(human(run)).toEqual([]);
  expect(run).not.toHaveProperty('hasPendingHumanAsk');
});

it('the contract no longer carries the summary or the monitoring activity', () => {
  const run = { ...reopenWith({}).getRun(id)!, hasPendingHumanAsk: true, activity: 'monitoring' };
  expect(apiRunSchema.parse(run)).not.toHaveProperty('hasPendingHumanAsk');
  expect(apiRunSchema.parse(run)).not.toHaveProperty('activity');
  const entry = runIndexEntrySchema.parse({ ...toRunSummary(run), projectId: 'project' });
  expect(entry).not.toHaveProperty('hasPendingHumanAsk');
  expect(entry).not.toHaveProperty('activity');
});
