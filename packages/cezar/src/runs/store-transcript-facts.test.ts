import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { historyPaths } from './history-file.ts';
import { TranscriptFactsQueue } from './transcript-facts-queue.ts';
import { RunStore } from './store.ts';
import { countTranscriptReads, restoreTranscriptReads } from './transcript-reads.testkit.ts';
import { seedSettledFamily } from '../workflows/delegation-reconcile.testkit.ts';

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

describe('RunStore transcript facts across processes (#880 review)', () => {
  it('sees appends another store made after it cached the facts', () => {
    const { dir, store: a } = openStore();
    const run = a.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    a.appendEvent(run.id, { type: 'text', text: 'one' });
    const b = openStore(dir).store;
    expect(b.transcriptFacts(run.id).lastSeq).toBe(1); // cached, as warm-up caches a family
    a.appendEvent(run.id, { type: 'conversation-message', projectionId: 'p:two' });
    a.appendEvent(run.id, { type: 'text', text: 'three' });
    a.close(); stores.splice(stores.indexOf(a), 1);
    expect(b.transcriptFacts(run.id).projectionIds).toEqual(['p:two']);
    expect(b.adoptFamily(run.id)).toBeDefined();
    expect(b.appendEvent(run.id, { type: 'text', text: 'four' }).seq).toBe(4);
  });
});

describe('RunStore transcript facts off the request path (#880)', () => {
  it('stamps the archive when the compressor runs', async () => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.appendEvent(run.id, { type: 'conversation-message', projectionId: 'p:1' });
    store.updateRun(run.id, { status: 'done', finishedAt: new Date().toISOString() });
    store.setArchived(run.id, true);
    await store.historyIdle();
    const { compressed, facts } = historyPaths(dir, run.id);
    const st = statSync(compressed);
    expect(JSON.parse(readFileSync(facts, 'utf8')).archive).toEqual({ size: st.size, mtimeMs: st.mtimeMs, ino: st.ino });
    store.close(); stores.pop();
    const reopened = openStore(dir).store;
    const reads = countTranscriptReads();
    expect(reopened.transcriptFacts(run.id).projectionIds).toEqual(['p:1']);
    expect(reads.counts.decompress).toBe(0);
  });

  it('warms conversation families without sync brotli', async () => {
    const { dir, store } = openStore();
    const { parentId, workerId } = seedSettledFamily(store, dir);
    store.appendEvent(workerId, { type: 'conversation-message', projectionId: 'p:worker' });
    store.close(); stores.pop();
    // An archive an older cezar wrote: no sidecar describes it.
    const paths = historyPaths(dir, workerId);
    writeFileSync(paths.compressed, brotliCompressSync(readFileSync(paths.plain)));
    rmSync(paths.plain); rmSync(paths.facts, { force: true });
    rmSync(historyPaths(dir, parentId).facts, { force: true });
    const reads = countTranscriptReads();
    const reopened = openStore(dir).store;
    await reopened.factsWarmIdle();
    expect(existsSync(paths.facts)).toBe(true);
    expect(reads.counts.decompress).toBe(0);
    expect(reopened.transcriptFacts(workerId).projectionIds).toEqual(['p:worker']);
    expect(reads.counts.decompress).toBe(0);
  });

  it('readEventsAsync reads an archive with the async API', async () => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.appendEvent(run.id, { type: 'text', text: 'one' });
    store.appendEvent(run.id, { type: 'text', text: 'two' });
    const expected = store.readEvents(run.id);
    const paths = historyPaths(dir, run.id);
    writeFileSync(paths.compressed, brotliCompressSync(readFileSync(paths.plain)));
    rmSync(paths.plain);
    const reads = countTranscriptReads();
    expect(await store.readEventsAsync(run.id)).toEqual(expected);
    expect(reads.counts.decompress).toBe(0);
    expect(reads.counts.files).toEqual([]);
  });
});


describe('off-loop store readiness (hearsay-tools/cezarion#906)', () => {
  it.each([true, false])('opens a cold waiting root without synchronous history and refreshes its conservative summary (keepLive=%s)', async keepLive => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 'root', task: 'task', workflow: 'w', steps: [] });
    store.updateRun(run.id, { status: 'waiting', delegation: { role: 'root', permissions: [], receipts: [] } });
    const ask = store.appendEvent(run.id, { type: 'ask.requested', requestId: 'q', questions });
    store.appendEvent(run.id, { type: 'human-input-delivered', askSeq: ask.seq });
    store.updateRun(run.id, { hasPendingHumanAsk: true });
    store.close(); stores.pop();
    rmSync(historyPaths(dir, run.id).facts, { force: true });
    const reads = countTranscriptReads();
    const joins = vi.spyOn(TranscriptFactsQueue.prototype, 'join');
    const reopened = RunStore.open(dir, { keepLive }); stores.push(reopened);
    expect(reads.counts.files).toEqual([]);
    expect(reopened.getRun(run.id)?.hasPendingHumanAsk).toBe(true);
    reopened.flush(); // A save before readiness must not lose the deferred repair.
    await reopened.prepareRecoveryFacts();
    expect(reopened.getRun(run.id)?.hasPendingHumanAsk).toBe(false);
    expect(joins).not.toHaveBeenCalled();
  });

  it.each(['warm', 'selected'] as const)('%s worker failure releases deferred settled families and claims without clearing attention', async mode => {
    const { dir, store: producer } = openStore();
    // Selected readiness must be tested independently of the open-time warm catch.
    const reader = mode === 'selected' ? openStore(dir).store : undefined;
    await reader?.factsWarmIdle();
    const families = [seedSettledFamily(producer, dir), seedSettledFamily(producer, dir)];
    for (const { parentId } of families) {
      producer.updateRun(parentId, { status: 'waiting' });
      producer.appendEvent(parentId, { type: 'ask.requested', requestId: parentId, questions });
    }
    producer.close(); stores.splice(stores.indexOf(producer), 1);
    for (const { parentId, workerId } of families) {
      rmSync(historyPaths(dir, parentId).facts, { force: true });
      rmSync(historyPaths(dir, workerId).facts, { force: true });
    }
    const failure = new Error('facts worker dispatch failed');
    const dispatch = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(() => { throw failure; });
    const joins = vi.spyOn(TranscriptFactsQueue.prototype, 'join');
    const reopened = reader ?? openStore(dir).store;
    if (reader) for (const { parentId } of families) expect(reader.adoptFamily(parentId)).toBe(parentId);
    reopened.flush();
    for (const { parentId } of families) expect(reopened.heldIds()).toContain(parentId);
    if (mode === 'warm') await expect(reopened.factsWarmIdle()).resolves.toBeUndefined();
    else await expect(reopened.prepareTranscriptFacts(families.flatMap(f => [f.parentId, f.workerId]))).rejects.toBe(failure);
    expect(dispatch).toHaveBeenCalled();
    expect(joins).not.toHaveBeenCalled();
    // Failure itself must schedule the ordinary fenced save/eviction, without another caller.
    await expect.poll(() => reopened.heldIds(), { timeout: 5_000 }).toEqual([]);
    for (const { parentId, workerId } of families) {
      expect(reopened.getRun(parentId)?.hasPendingHumanAsk).toBe(true);
      expect(reopened.heldIds()).not.toContain(parentId);
      expect(reopened.heldIds()).not.toContain(workerId);
      expect(existsSync(historyPaths(dir, parentId).facts)).toBe(false);
    }
    // This is ownership release, not just memory eviction: a peer can claim both families.
    const peer = openStore(dir).store;
    for (const { parentId } of families) expect(peer.adoptFamily(parentId)).toBe(parentId);
  });

  it.each([undefined, false, true])('retains legacy summary %s for an empty transcript without a sidecar', async summary => {
    const { dir, store } = openStore();
    const run = store.createRun({ title: 'legacy', task: 'task', workflow: 'w', steps: [] });
    store.updateRun(run.id, { status: 'waiting', hasPendingHumanAsk: summary,
      delegation: { role: 'root', permissions: [], receipts: [] } });
    store.close(); stores.pop();
    writeFileSync(historyPaths(dir, run.id).plain, '');
    rmSync(historyPaths(dir, run.id).facts, { force: true });
    const reopened = RunStore.open(dir, { keepLive: true }); stores.push(reopened);
    await reopened.prepareRecoveryFacts();
    expect(reopened.getRun(run.id)?.hasPendingHumanAsk).toBe(summary === true);
  });

  it('yields between selected ready sidecars instead of chaining all work in microtasks', async () => {
    const { store } = openStore();
    const run = store.createRun({ title: 'ready', task: 'task', workflow: 'w', steps: [] });
    store.appendEvent(run.id, { type: 'text', text: 'cached' });
    let ticked = false;
    const tick = new Promise<void>(resolve => setImmediate(() => { ticked = true; resolve(); }));
    await store.prepareTranscriptFacts([run.id]);
    expect(ticked).toBe(true);
    await tick;
  });

  it('warms live complete families before historical families and other IDs, once each', async () => {
    const { dir, store } = openStore();
    const historical = seedSettledFamily(store, dir);
    const other = store.createRun({ title: 'other', task: 'task', workflow: 'w', steps: [] });
    store.updateRun(other.id, { status: 'done' });
    const live = seedSettledFamily(store, dir);
    store.updateRun(live.parentId, { status: 'waiting' });
    const ids = [historical.parentId, historical.workerId, other.id, live.parentId, live.workerId];
    for (const id of ids) store.appendEvent(id, { type: 'text', text: id });
    store.close(); stores.pop();
    for (const id of ids) rmSync(historyPaths(dir, id).facts, { force: true });
    const completed: string[] = [];
    const request = TranscriptFactsQueue.prototype.request;
    vi.spyOn(TranscriptFactsQueue.prototype, 'request').mockImplementation(function (this: TranscriptFactsQueue<unknown>, id, demand) {
      return request.call(this, id, demand).then(value => { completed.push(id); return value; });
    });
    const reopened = RunStore.open(dir, { keepLive: true }); stores.push(reopened);
    await reopened.factsWarmIdle();
    expect(completed).toEqual([live.parentId, live.workerId, historical.parentId, historical.workerId, other.id]);
    for (const id of ids) expect(existsSync(historyPaths(dir, id).facts)).toBe(true);
  });
});
