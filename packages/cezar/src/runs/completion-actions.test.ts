import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore } from './store.ts';
import { readPersistedRuns } from './run-store.testkit.ts';

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
