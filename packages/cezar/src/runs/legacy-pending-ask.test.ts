import {
  RUN_STATUS,
  WAIT_KIND,
  WAIT_PHASE,
  WAIT_SOURCE,
  WAIT_VIA,
} from '@open-mercato/cezar-contract/test-factories.testkit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { toRunSummary } from '@open-mercato/cezar-contract/runs';
import { RunStore } from './store.ts';
import { readRunIndexFromDisk } from './run-index.ts';
import { setRunStatus, readPersistedRuns, seedRuns } from './run-store.testkit.ts';

/**
 * Phase 4b (hearsay-tools/cezarion#1236): a pending question is an open human wait. The record no
 * longer carries the `hasPendingHumanAsk` summary; a stored one is read into the wait list once.
 */
let dir: string, store: RunStore, id: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cez-legacy-ask-'));
  store = RunStore.open(dir);
  id = store.createRun({ title: 'Root', task: 'task', workflow: 'quick-task', steps: [] }).id;
  setRunStatus(store, id, RUN_STATUS.waiting);
  store.close();
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

/** Rewrite the stored row as an older Squawk left it, then reopen. */
function reopenWith(patch: Record<string, unknown>): RunStore {
  const [row] = readPersistedRuns(dir);
  seedRuns(dir, [{ ...row, ...patch }]);
  store = RunStore.open(dir, { keepLive: true });
  return store;
}

const human = (record: { waits?: ReadonlyArray<{ kind: string; phase: string }> | undefined } | undefined) =>
  (record?.waits ?? []).filter((wait) => wait.kind === 'human' && wait.phase === 'open');

it('reads a waiting run\'s stored pending question into one open human wait and drops the summary', () => {
  const run = reopenWith({ hasPendingHumanAsk: true }).getRun(id);
  expect(human(run)).toEqual([expect.objectContaining({ kind: WAIT_KIND.human, source: WAIT_SOURCE.agent, via: WAIT_VIA['ask-line'], phase: WAIT_PHASE.open, turnId: 'legacy' })]);
  expect(human(run)[0]).not.toHaveProperty('askSeq');
  expect(run).not.toHaveProperty('hasPendingHumanAsk');
  expect(toRunSummary(run!).waitingOn).toEqual({ kind: WAIT_KIND.human });
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
  expect(cold?.waitingOn).toEqual({ kind: WAIT_KIND.human });
  expect(cold).not.toHaveProperty('hasPendingHumanAsk');
});

it('the cold index reads an un-upgraded row as waiting on the user', () => {
  const [row] = readPersistedRuns(dir);
  seedRuns(dir, [{ ...row, hasPendingHumanAsk: true }]);
  const cold = readRunIndexFromDisk(dir).runs[0];
  expect(cold?.waitingOn).toEqual({ kind: WAIT_KIND.human });
  expect(cold).not.toHaveProperty('hasPendingHumanAsk');
  store = RunStore.open(dir, { keepLive: true });
});

it('adds no second wait beside an open human wait', () => {
  const wait = { id: '0b8f4c7e-8a43-4f1e-9a3e-1d2f3a4b5c6d', kind: WAIT_KIND.human, source: WAIT_SOURCE.agent, via: WAIT_VIA.cezar_ask,
    registeredAt: new Date().toISOString(), phase: WAIT_PHASE.open, turnId: 'turn', askSeq: 3 };
  expect(human(reopenWith({ hasPendingHumanAsk: true, waits: [wait] }).getRun(id))).toEqual([wait]);
});

it.each([
  ['a false summary on a waiting run', { hasPendingHumanAsk: false }],
  ['a true summary on a finished run', { hasPendingHumanAsk: true, status: RUN_STATUS.done, finishedAt: new Date().toISOString() }],
])('drops %s without opening a wait', (_name, patch) => {
  const run = reopenWith(patch).getRun(id);
  expect(human(run)).toEqual([]);
  expect(run).not.toHaveProperty('hasPendingHumanAsk');
});

