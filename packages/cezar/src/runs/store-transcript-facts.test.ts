import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { historyPaths } from './history-file.ts';
import { RunStore } from './store.ts';
import { countTranscriptReads, restoreTranscriptReads } from './transcript-reads.testkit.ts';

const questions = [{ header: 'Pick', question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }];
const dirs: string[] = [];
const stores: RunStore[] = [];

function openStore(dir = mkdtempSync(join(tmpdir(), 'cez-store-facts-'))): { dir: string; store: RunStore } {
  if (!dirs.includes(dir)) dirs.push(dir);
  const store = RunStore.open(dir);
  stores.push(store);
  return { dir, store };
}

afterEach(() => {
  restoreTranscriptReads();
  while (stores.length > 0) stores.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('RunStore transcript facts (#880)', () => {
  it('appendEvent keeps hasPendingHumanAsk without re-reading the transcript', () => {
    const { store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    for (let i = 0; i < 200; i++) store.appendEvent(run.id, { type: 'text', text: `token ${i}` });
    const reads = countTranscriptReads();
    const ask = store.appendEvent(run.id, { type: 'ask.requested', requestId: 'q', questions });
    expect(store.getRun(run.id)?.hasPendingHumanAsk).toBe(true);
    store.appendEvent(run.id, { type: 'human-input-delivered', askSeq: ask.seq });
    expect(store.getRun(run.id)?.hasPendingHumanAsk).toBe(false);
    expect(reads.counts.files).toEqual([]);
    expect(store.transcriptFacts(run.id).pendingAsk).toBeUndefined();
  });

  it('answers projection lookups from the index', () => {
    const { store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.appendEvent(run.id, { type: 'conversation-message', projectionId: 'conversation-message:m:queued' });
    expect(store.hasProjection(run.id, 'conversation-message:m:queued')).toBe(true);
    expect(store.hasProjection(run.id, 'conversation-message:m:delivered')).toBe(false);
  });

  it('rehydrates seq from the facts after reopen', () => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    for (let i = 0; i < 3; i++) store.appendEvent(run.id, { type: 'text', text: `t${i}` });
    store.close(); stores.pop();
    const reopened = openStore(dir).store;
    const reads = countTranscriptReads();
    expect(reopened.appendEvent(run.id, { type: 'text', text: 'after' }).seq).toBe(4);
    expect(reads.counts.files).toEqual([]);
  });

  it('appending to an archived run keeps facts without a rebuild', async () => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.appendEvent(run.id, { type: 'conversation-message', projectionId: 'p:before' });
    store.updateRun(run.id, { status: 'done', finishedAt: new Date().toISOString() });
    store.setArchived(run.id, true);
    await store.historyIdle();
    expect(existsSync(historyPaths(dir, run.id).plain)).toBe(false);
    const reads = countTranscriptReads();
    store.setArchived(run.id, false);
    store.appendEvent(run.id, { type: 'conversation-message', projectionId: 'p:after' });
    expect(store.transcriptFacts(run.id).projectionIds).toEqual(['p:before', 'p:after']);
    // Only restoreHistory decodes the archive; the facts never re-read it.
    expect(reads.counts.decompress).toBe(1);
  });

  it('deleting a run removes its facts sidecar', () => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.appendEvent(run.id, { type: 'conversation-message', projectionId: 'p:1' });
    expect(existsSync(historyPaths(dir, run.id).facts)).toBe(true);
    store.deleteRun(run.id);
    store.close(); stores.pop();
    expect(existsSync(historyPaths(dir, run.id).facts)).toBe(false);
  });
});
