import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { brotliCompressSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { readFiniteRunFeed, readRunEventBatch, subscribeRunFeed } from './run-event-feed.ts';
import { LIVE_BYTE_LIMIT, type RunEvent } from '@open-mercato/cezar-contract';

let dataDir: string;
let store: RunStore;
let runId: string;
const signal = () => new AbortController().signal;
const demand = () => ({ projectId: 'boot', runId, afterSeq: 0 });
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cez-feed-'));
  store = RunStore.open(dataDir);
  runId = store.createRun({ title: 'Feed', task: 'Feed', workflow: 'quick-task', steps: [] }).id;
});
afterEach(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });

describe('bounded persisted feed', () => {
  it('reads compressed history with an accepted-prefix cursor', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => JSON.stringify({ seq: i + 1, type: 'note', ts: '', text: 'archive' })).join('\n') + '\n';
    writeFileSync(join(dataDir, 'runs', `${runId}.ndjson.br`), brotliCompressSync(lines));
    const a = await readRunEventBatch(dataDir, demand(), signal());
    expect(a.events).toHaveLength(256);
    const b = await readRunEventBatch(dataDir, { ...demand(), cursor: a.cursor, afterSeq: a.afterSeq }, signal());
    expect(b.events).toHaveLength(44);
    expect(b.hasMore).toBe(false);
  });
  it('leaves a partial trailing record for the next read', async () => {
    const path = join(dataDir, 'runs', `${runId}.ndjson`);
    const line = JSON.stringify({ seq: 1, type: 'note', ts: '', text: 'complete' });
    writeFileSync(path, line);
    const a = await readRunEventBatch(dataDir, demand(), signal());
    expect(a.events).toEqual([]);
    expect(a.hasMore).toBe(false);
    writeFileSync(path, line + '\n');
    const b = await readRunEventBatch(dataDir, { ...demand(), cursor: a.cursor }, signal());
    expect(b.events[0]?.seq).toBe(1);
  });
  it('requests rehydration for an oversized event rather than looping without progress', async () => {
    store.appendEvent(runId, { type: 'note', text: 'x'.repeat(LIVE_BYTE_LIMIT + 1) });
    await expect(readRunEventBatch(dataDir, demand(), signal())).rejects.toMatchObject({ status: 413 });
  });
  it('resumes both snapshot and disk prefixes across byte-limited pages', async () => {
    store.appendEvent(runId, { type: 'item.started', item: { kind: 'message', id: 'item', text: '' } });
    store.emitEphemeral(runId, { type: 'item.delta', itemId: 'item', field: 'text', delta: 'latest text' });
    store.appendEvent(runId, { type: 'note', text: 'following' });
    const snapshots = store.liveReadSnapshot(runId);
    let cursor: string | undefined;
    let afterSeq = 0;
    const seen: RunEvent[] = [];
    for (let i = 0; i < 3; i++) {
      const page = await readRunEventBatch(dataDir, { ...demand(), cursor, afterSeq }, signal(), 150, snapshots);
      seen.push(...page.events);
      cursor = page.cursor; afterSeq = page.afterSeq;
      expect(page.events).toHaveLength(1);
      expect(page.hasMore).toBe(i < 2);
    }
    expect(seen.map(event => event.seq)).toEqual([1, 2, 3]);
    expect(seen[1]).toMatchObject({ type: 'item.updated', item: { text: 'latest text' } });
  });
  it('cancels a snapshot-only response while checking for absent disk history', async () => {
    const controller = new AbortController();
    const reading = readRunEventBatch(dataDir, demand(), controller.signal, LIVE_BYTE_LIMIT,
      { throughSeq: 1, events: [{ type: 'item.updated', seq: 1, ts: '', item: { id: 'item', kind: 'message', text: 'live' } }] });
    controller.abort();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('releases the finite scan write observer on cancellation and a failed read', async () => {
    const before = store.listenerCount('event');
    const controller = new AbortController();
    const reading = readFiniteRunFeed({ store, dataDir }, demand(), controller.signal);
    expect(store.listenerCount('event')).toBe(before + 1);
    controller.abort();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(store.listenerCount('event')).toBe(before);
    store.appendEvent(runId, { type: 'note', text: 'x'.repeat(LIVE_BYTE_LIMIT + 1) });
    await expect(readFiniteRunFeed({ store, dataDir }, demand(), signal())).rejects.toMatchObject({ status: 413 });
    expect(store.listenerCount('event')).toBe(before);
  });
  it('rejects expired cursors and pre-aborted requests', async () => {
    store.appendEvent(runId, { type: 'note', text: 'old' });
    const a = await readRunEventBatch(dataDir, demand(), signal());
    writeFileSync(join(dataDir, 'runs', `${runId}.ndjson`), '');
    await expect(readRunEventBatch(dataDir, { ...demand(), cursor: a.cursor }, signal())).rejects.toMatchObject({ status: 409 });
    const controller = new AbortController(); controller.abort();
    await expect(readRunEventBatch(dataDir, demand(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('ordered replay/live handoff', () => {
  it('attaches before replay, deduplicates overlap, and releases every listener on abort', async () => {
    store.appendEvent(runId, { type: 'note', text: 'persisted' });
    const controller = new AbortController();
    const seen: number[] = [];
    let sawLive!: () => void;
    const received = new Promise<void>(resolve => { sawLive = resolve; });
    const baseline = store.listenerCount('event');
    const task = subscribeRunFeed({ store, dataDir }, demand(), {
      async event(event) {
        seen.push(event.seq);
        if (event.seq === 1) store.appendEvent(runId, { type: 'note', text: 'during replay' });
        if (event.seq === 3) sawLive();
      }, reset: () => { throw new Error('unexpected reset'); },
    }, controller.signal);
    expect(store.listenerCount('event')).toBe(baseline + 1);
    store.appendEvent(runId, { type: 'note', text: 'during read' });
    await received;
    controller.abort(); await task;
    expect(seen).toEqual([1, 2, 3]);
    expect(store.listenerCount('event')).toBe(baseline);
  });
  it('bounds a slow live consumer and stops on overflow', async () => {
    const controller = new AbortController();
    let released!: () => void;
    const blocked = new Promise<void>(resolve => { released = resolve; });
    const resets: string[] = [];
    const task = subscribeRunFeed({ store, dataDir }, demand(), {
      event: () => blocked, reset: reason => { resets.push(reason); },
    }, controller.signal);
    const event = { seq: 1, ts: '', type: 'note', text: 'x'.repeat(LIVE_BYTE_LIMIT) } satisfies RunEvent;
    store.emit('event', { runId, event });
    released(); await task;
    expect(resets).toHaveLength(1);
    expect(store.listenerCount('event')).toBe(0);
  });
  it('detaches replay and live work when the project store closes', async () => {
    const controller = new AbortController();
    const resets: string[] = [];
    const task = subscribeRunFeed({ store, dataDir }, demand(), {
      event: async () => {}, reset: reason => { resets.push(reason); },
    }, controller.signal);
    store.close();
    try {
      expect(resets).toEqual(['project removed']);
      expect(store.listenerCount('event')).toBe(0);
    } finally { controller.abort(); await task; }
  });

});
