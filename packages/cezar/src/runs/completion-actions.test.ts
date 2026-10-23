import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { historyPaths } from './history-file.ts';
import { RunStore } from './store.ts';
import { blockRunWrites, readPersistedRuns } from './run-store.testkit.ts';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function setup(options: { archiveWhenDone?: boolean; autoMergePr?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cez-completion-'));
  const store = RunStore.open(dir, { keepLive: true });
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const run = store.createRun({ title: 'task', task: 'task', workflow: 'quick-task', steps: [], ...options });
  store.flush();
  return { store, id: run.id, dir };
}

describe('task completion options', () => {
  it('commits Done and its archive together, without a live manager or session', () => {
    const { store, id, dir } = setup({ archiveWhenDone: true });
    store.updateRun(id, { status: 'done' });
    expect(readPersistedRuns(dir).find(run => run.id === id)).toMatchObject({ status: 'done', archived: true });
  });

  it.each(['review', 'failed', 'cancelled', 'waiting'] as const)('does not archive %s', status => {
    const { store, id } = setup({ archiveWhenDone: true });
    store.updateRun(id, { status });
    expect(store.getRun(id)?.archived).toBe(false);
  });

  it('keeps the default off', () => {
    const { store, id } = setup();
    store.updateRun(id, { status: 'done' });
    expect(store.getRun(id)?.archived).toBe(false);
  });

  it('keeps a manually restored task visible across unrelated writes and restart', () => {
    const { store, id, dir } = setup({ archiveWhenDone: true });
    store.updateRun(id, { status: 'done' });
    expect(store.getRun(id)?.archived).toBe(true);
    store.setArchived(id, false);
    store.updateRun(id, { title: 'restored' });
    store.flush();
    const reopened = RunStore.open(dir, { keepLive: true });
    try { expect(reopened.getRun(id)?.archived).toBe(false); } finally { reopened.close(); }
  });

  it('restores on Continue and archives the next completion', () => {
    const { store, id } = setup({ archiveWhenDone: true });
    store.updateRun(id, { status: 'done' });
    store.updateRun(id, { status: 'queued', archived: false });
    expect(store.getRun(id)?.archived).toBe(false);
    store.updateRun(id, { status: 'done' });
    expect(store.getRun(id)?.archived).toBe(true);
  });

  it('waits for merge before archiving when both options are enabled', () => {
    const { store, id, dir } = setup({ archiveWhenDone: true, autoMergePr: true });
    store.updateRun(id, { status: 'done' });
    expect(readPersistedRuns(dir).find(run => run.id === id)).toMatchObject({ status: 'done', archived: false,
      completionAction: { phase: 'pending' } });
  });
});

it('commits deferred root Finish and its archive before exposing success', () => {
  const { store, id, dir } = setup({ archiveWhenDone: true });
  store.updateRun(id, { status: 'waiting', delegation: { role: 'root', permissions: [], receipts: [] } });
  store.commitRootFinishIntent(id);
  const rows: unknown[] = [];
  store.on('run', run => { if (run.status === 'done') rows.push(readPersistedRuns(dir)[0]); });
  expect(store.commitRootFinishSuccess(id, 'done')).toBe(true);
  expect(rows).toEqual([expect.objectContaining({ status: 'done', archived: true })]);
});
it('publishes neither Done nor archive if their transaction fails', () => {
  const { store, id, dir } = setup({ archiveWhenDone: true });
  const release = blockRunWrites(dir);
  try { expect(() => store.updateRun(id, { status: 'done' })).toThrow(); } finally { release(); }
  expect(store.getRun(id)).toMatchObject({ status: 'queued', archived: false });
  expect(readPersistedRuns(dir)[0]).toMatchObject({ status: 'queued', archived: false });
});
it('retires pending merge work on explicit unarchive and creates new intent after a later completion', () => {
  const { store, id } = setup({ archiveWhenDone: true, autoMergePr: true });
  store.updateRun(id, { status: 'done' });
  const token = store.getRun(id)!.completionAction!.id;
  store.setArchived(id, true); store.setArchived(id, false);
  expect(store.completeAction(id, token, 'complete')).toBe(false);
  store.updateRun(id, { status: 'queued' }); store.updateRun(id, { status: 'done' });
  expect(store.getRun(id)?.completionAction?.id).not.toBe(token);
  expect(store.completeAction(id, token, 'complete')).toBe(false);
});

it('keeps completion visible when transcript facts have not been loaded', () => {
  const { store, id, dir } = setup({ archiveWhenDone: true });
  mkdirSync(join(dir, 'runs'), { recursive: true });
  writeFileSync(historyPaths(dir, id).plain, '{"seq":1,"type":"note","message":"unread history"}\n');
  store.updateRun(id, { status: 'done' });
  expect(readPersistedRuns(dir)[0]).toMatchObject({ status: 'done', archived: false, completionAction: { phase: 'blocked' } });
});
