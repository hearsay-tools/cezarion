import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';

import { historyPaths, readHistoryText } from './history-file.ts';
import { RunStore } from './store.ts';
import { createFixtureManager, drainFixtureManagers } from '../workflows/fixture-cleanup.testkit.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import type { AgentRunSpec } from '../core/agent-runner.ts';
import type { RunManager } from '../workflows/run.ts';

const captured = vi.hoisted(() => ({
  specs: [] as AgentRunSpec[],
  release: undefined as (() => void) | undefined,
}));
vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    backend: 'claude',
    interrupt: async () => {},
    startSession: (spec: AgentRunSpec) => {
      captured.specs.push(spec);
      return {
        result: new Promise((resolve) => {
          captured.release = () => resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 });
        }),
        sendMessage: () => true,
        discardQueuedMessages: () => {},
        end: () => {},
        interrupt: () => {},
        open: true,
      };
    },
  }),
}));

const dirs: string[] = [];
const stores: RunStore[] = [];
const roots: string[] = [];
const managers: RunManager[] = [];

afterEach(async () => {
  captured.release?.();
  captured.release = undefined;
  captured.specs.length = 0;
  for (const root of roots) await drainFixtureManagers(root);
  managers.length = 0;
  while (stores.length > 0) {
    const store = stores.pop()!;
    store.close();
    await store.historyIdle();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function openStore(): { dir: string; store: RunStore } {
  const dir = mkdtempSync(join(tmpdir(), 'cez-store-history-'));
  dirs.push(dir);
  const store = RunStore.open(dir);
  stores.push(store);
  return { dir, store };
}

function finish(store: RunStore, id: string): void {
  store.updateRun(id, { status: 'done', finishedAt: new Date().toISOString() });
}

describe('RunStore history compression', () => {
  it('archiving a finished run compresses its transcript', async () => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.appendEvent(run.id, { type: 'note', message: 'one' });
    store.appendEvent(run.id, { type: 'note', message: 'two' });
    const before = store.readEvents(run.id);
    finish(store, run.id);
    store.setArchived(run.id, true);
    await store.historyIdle();
    const { plain, compressed } = historyPaths(dir, run.id);
    expect(existsSync(compressed)).toBe(true);
    expect(existsSync(plain)).toBe(false);
    expect(store.readEvents(run.id).map((event) => ({ seq: event.seq, type: event.type, message: event.message }))).toEqual(
      before.map((event) => ({ seq: event.seq, type: event.type, message: event.message })),
    );
  });

  it('unarchiving restores the plain transcript synchronously', async () => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.appendEvent(run.id, { type: 'note', message: 'keep' });
    finish(store, run.id);
    store.setArchived(run.id, true);
    await store.historyIdle();
    store.setArchived(run.id, false);
    const { plain, compressed } = historyPaths(dir, run.id);
    expect(existsSync(plain)).toBe(true);
    expect(existsSync(compressed)).toBe(false);
    expect(readHistoryText(dir, run.id)).toContain('"message":"keep"');
  });

  it('a live run is never compressed', async () => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.appendEvent(run.id, { type: 'note', message: 'live' });
    store.updateRun(run.id, { status: 'running' });
    store.setArchived(run.id, true);
    await store.historyIdle();
    const { plain, compressed } = historyPaths(dir, run.id);
    expect(existsSync(plain)).toBe(true);
    expect(existsSync(compressed)).toBe(false);
  });

  it('deleting an archived run removes the compressed transcript', async () => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.appendEvent(run.id, { type: 'note', message: 'gone' });
    finish(store, run.id);
    store.setArchived(run.id, true);
    await store.historyIdle();
    const { plain, compressed } = historyPaths(dir, run.id);
    expect(existsSync(compressed)).toBe(true);
    expect(store.deleteRun(run.id)).toBe(true);
    store.flush();
    expect(existsSync(compressed)).toBe(false);
    expect(existsSync(plain)).toBe(false);
  });

  it('the startup sweep compresses archived runs left plain and resolves both-present leftovers', async () => {
    const { dir, store } = openStore();
    const leftPlain = store.createRun({ title: 'plain', workflow: 'w', task: 'task', steps: [] });
    store.appendEvent(leftPlain.id, { type: 'note', message: 'plain-body' });
    finish(store, leftPlain.id);
    store.setArchived(leftPlain.id, true);
    const both = store.createRun({ title: 'both', workflow: 'w', task: 'task', steps: [] });
    store.appendEvent(both.id, { type: 'note', message: 'A' });
    finish(store, both.id);
    store.setArchived(both.id, true);
    store.flush();
    await store.historyIdle();
    store.close();
    stores.pop();

    const plainLeft = historyPaths(dir, leftPlain.id);
    const original = '{"seq":1,"type":"note","message":"plain-body"}\n';
    writeFileSync(plainLeft.plain, original);
    if (existsSync(plainLeft.compressed)) rmSync(plainLeft.compressed);

    const bothPaths = historyPaths(dir, both.id);
    mkdirSync(join(dir, 'runs'), { recursive: true });
    writeFileSync(bothPaths.plain, 'A');
    writeFileSync(
      bothPaths.compressed,
      brotliCompressSync(Buffer.from('B'), { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }),
    );

    const reopened = RunStore.open(dir);
    stores.push(reopened);
    reopened.compressArchivedHistory();
    await reopened.historyIdle();
    expect(existsSync(plainLeft.plain)).toBe(false);
    expect(existsSync(plainLeft.compressed)).toBe(true);
    expect(readHistoryText(dir, leftPlain.id)).toBe(original);
    expect(existsSync(bothPaths.plain)).toBe(false);
    expect(existsSync(bothPaths.compressed)).toBe(true);
    expect(readHistoryText(dir, both.id)).toBe('A');
  });

  it('continue on an archived run appends after the old events', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-history-continue-'));
    roots.push(root);
    const store = RunStore.open(join(root, '.ai/cezar'));
    stores.push(store);
    const manager = createFixtureManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
    managers.push(manager);
    const run = store.createRun({
      title: 'task', task: 'task', workflow: 'original', worktree: false,
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateStep(run.id, 'work', { status: 'done', sessionId: 'old-session' });
    const first = store.appendEvent(run.id, { type: 'note', message: 'before' });
    store.updateRun(run.id, { status: 'done', finishedAt: new Date().toISOString() });
    store.setArchived(run.id, true);
    await store.historyIdle();
    const { plain, compressed } = historyPaths(join(root, '.ai/cezar'), run.id);
    expect(existsSync(compressed)).toBe(true);

    expect(manager.continueRun(run.id, { text: 'keep going' })).toEqual({ ok: true });
    expect(existsSync(plain)).toBe(true);
    expect(existsSync(compressed)).toBe(false);

    await vi.waitFor(() => {
      const seqs = store.readEvents(run.id).map((event) => event.seq).filter((seq): seq is number => typeof seq === 'number');
      expect(Math.max(0, ...seqs)).toBeGreaterThan(first.seq);
    });
    expect(existsSync(plain)).toBe(true);
    expect(existsSync(compressed)).toBe(false);
  });

  it('close stops the compressor', async () => {
    const started: string[] = [];
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const historyFile = await import('./history-file.ts');
    const spy = vi.spyOn(historyFile, 'compressHistory').mockImplementation(async (_dataDir, id) => {
      started.push(id);
      if (started.length === 1) await first;
      return 'skipped';
    });
    const { store } = openStore();
    const runs = Array.from({ length: 3 }, () => {
      const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
      store.appendEvent(run.id, { type: 'note', message: 'x' });
      finish(store, run.id);
      store.setArchived(run.id, true);
      return run.id;
    });
    await vi.waitFor(() => expect(started.length).toBeGreaterThanOrEqual(1));
    store.close();
    release();
    await store.historyIdle();
    expect(started.length).toBeLessThan(runs.length);
    spy.mockRestore();
  });
});
