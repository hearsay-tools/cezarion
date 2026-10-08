import { LIVE_BYTE_LIMIT, liveRunBatchResponseSchema, type LiveRunBatch } from '@open-mercato/cezar-contract';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { UiEventSink } from '../runs/ui-event-sink.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

let root: string;
let store: RunStore;
let app: ReturnType<typeof createApp>;
let runId: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cez-live-'));
  store = RunStore.open(join(root, '.ai/cezar'));
  runId = store.createRun({ title: 'Stream', workflow: 'quick-task', task: 'Stream', steps: [] }).id;
  app = createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test', bootProjectId: 'boot' });
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
const batch = (runs: unknown[]) => apiRequest(app, '/api/v1/workspace/run-event-batches', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runs }),
});

describe('finite multi-run catch-up', () => {
  it('delivers current text before item completion without persisting streaming deltas', async () => {
    const sink = new UiEventSink({
      persist: event => { store.appendEvent(runId, event); },
      emitLive: event => { store.emitEphemeral(runId, event); },
    });
    const item = { kind: 'message' as const, id: 'typing', role: 'assistant' as const, text: '' };
    sink.handle({ type: 'item.started', item });
    const first = liveRunBatchResponseSchema.parse(await (await batch([{ projectId: 'boot', runId, afterSeq: 0 }])).json()).results[0] as LiveRunBatch;
    sink.handle({ type: 'item.delta', itemId: item.id, field: 'text', delta: 'Still ' });
    sink.flushAll();
    sink.handle({ type: 'item.delta', itemId: item.id, field: 'text', delta: 'writing' });
    sink.flushAll();
    store.appendEvent(runId, { type: 'note', text: 'unrelated persisted event' });
    const next = liveRunBatchResponseSchema.parse(await (await batch([{ projectId: 'boot', runId, afterSeq: first.afterSeq, cursor: first.cursor }])).json()).results[0] as LiveRunBatch;
    expect(next.events.map(event => event.seq)).toEqual([3, 4]);
    expect(next.events[0]).toMatchObject({ type: 'item.updated', item: { text: 'Still writing' } });
    sink.handle({ type: 'item.updated', item: { ...item, text: 'Still writing more' } });
    const last = liveRunBatchResponseSchema.parse(await (await batch([{ projectId: 'boot', runId, afterSeq: next.afterSeq, cursor: next.cursor }])).json()).results[0] as LiveRunBatch;
    expect(last.events).toMatchObject([{ type: 'item.updated', item: { text: 'Still writing more' } }]);
    expect(store.readEvents(runId).map(event => event.type)).toEqual(['item.started', 'note']);
    const duplicate = liveRunBatchResponseSchema.parse(await (await batch([{ projectId: 'boot', runId, afterSeq: last.afterSeq, cursor: last.cursor }])).json()).results[0] as LiveRunBatch;
    expect(duplicate.events).toEqual([]);
    sink.handle({ type: 'item.completed', item: { ...item, text: 'Finished' } });
    const completed = liveRunBatchResponseSchema.parse(await (await batch([{ projectId: 'boot', runId, afterSeq: last.afterSeq, cursor: last.cursor }])).json()).results[0] as LiveRunBatch;
    expect(completed.events).toMatchObject([{ type: 'item.completed', item: { text: 'Finished' } }]);
  });
  it('merges active snapshots at an event-limit boundary without skipping persisted records', async () => {
    store.appendEvent(runId, { type: 'item.started', item: { kind: 'message', id: 'typing', text: '' } });
    for (let i = 0; i < 254; i++) store.appendEvent(runId, { type: 'note', text: 'history' });
    store.emitEphemeral(runId, { type: 'item.delta', itemId: 'typing', field: 'text', delta: 'live text' });
    store.appendEvent(runId, { type: 'note', text: 'after live text' });
    const first = liveRunBatchResponseSchema.parse(await (await batch([{ projectId: 'boot', runId, afterSeq: 0 }])).json()).results[0] as LiveRunBatch;
    expect(first.events).toHaveLength(256);
    expect(first.events.at(-1)).toMatchObject({ seq: 256, type: 'item.updated', item: { text: 'live text' } });
    expect(first.hasMore).toBe(true);
    const next = liveRunBatchResponseSchema.parse(await (await batch([{ projectId: 'boot', runId, afterSeq: first.afterSeq, cursor: first.cursor }])).json()).results[0] as LiveRunBatch;
    expect(next.events).toMatchObject([{ seq: 257, text: 'after live text' }]);
    expect(next.hasMore).toBe(false);
  });
  it('retains only redacted active content and clears it on store closure', async () => {
    store.registerSessionSecret('fixture-secret-must-be-redacted');
    store.appendEvent(runId, { type: 'item.started', item: { kind: 'message', id: 'typing', text: '' } });
    store.emitEphemeral(runId, { type: 'item.delta', itemId: 'typing', field: 'text', delta: 'fixture-secret-must-be-redacted' });
    const response = await (await batch([{ projectId: 'boot', runId, afterSeq: 0 }])).text();
    expect(response).not.toContain('fixture-secret-must-be-redacted');
    expect(response).toContain('[REDACTED]');
    expect(store.liveItemSnapshots(runId)).toHaveLength(1);
    store.close();
    expect(store.liveItemSnapshots(runId)).toEqual([]);
  });
  it('discards active snapshots when their run is deleted', () => {
    store.appendEvent(runId, { type: 'item.started', item: { kind: 'message', id: 'typing', text: '' } });
    store.emitEphemeral(runId, { type: 'item.delta', itemId: 'typing', field: 'text', delta: 'temporary' });
    store.updateRun(runId, { status: 'done' });
    expect(store.liveItemSnapshots(runId)).toHaveLength(1);
    expect(store.deleteRun(runId)).toBe(true);
    expect(store.liveItemSnapshots(runId)).toEqual([]);
  });
  it('bounds replay at an accepted prefix and continues without loss or duplicates', async () => {
    for (let i = 0; i < 300; i++) store.appendEvent(runId, { type: 'note', text: `line ${i}` });
    const first = await batch([{ projectId: 'default', runId, afterSeq: 0 }]);
    expect(first.status).toBe(200);
    const a = liveRunBatchResponseSchema.parse(await first.json()).results[0] as LiveRunBatch;
    expect(a.events).toHaveLength(256);
    expect(a.hasMore).toBe(true);
    expect(a.afterSeq).toBe(256);
    const second = await batch([{ projectId: 'boot', runId, afterSeq: a.afterSeq, cursor: a.cursor }]);
    const b = liveRunBatchResponseSchema.parse(await second.json()).results[0] as LiveRunBatch;
    expect(b.events.map((e: { seq: number }) => e.seq)).toEqual(Array.from({ length: 44 }, (_, i) => i + 257));
    expect(b.hasMore).toBe(false);
    expect(a.projectId).toBe('boot');
  });
  it('reports a missing task without losing the other requested transcript', async () => {
    store.appendEvent(runId, { type: 'note', text: 'survives' });
    const response = await batch([{ projectId: 'boot', runId: 'gone', afterSeq: 0 }, { projectId: 'boot', runId, afterSeq: 0 }]);
    expect(response.status).toBe(200);
    const { results } = liveRunBatchResponseSchema.parse(await response.json());
    expect(results[0]).toMatchObject({ type: 'error', status: 404 });
    expect((results[1] as LiveRunBatch).events[0]!.text).toBe('survives');
  });
  it('rejects duplicate demand, malformed names and excessive demand at the boundary', async () => {
    const demand = { projectId: 'boot', runId, afterSeq: 0 };
    expect((await batch([demand, demand])).status).toBe(400);
    expect((await batch([demand, { ...demand, projectId: 'default' }])).status).toBe(400);
    expect((await batch([{ ...demand, runId: '../escape' }])).status).toBe(400);
    expect((await batch(Array.from({ length: 33 }, (_, i) => ({ ...demand, runId: `run-${i}` })))).status).toBe(400);
  });
  it('keeps sequence gaps while filtering the already accepted prefix', async () => {
    store.appendEvent(runId, { type: 'note', text: 'first' });
    store.appendEvent(runId, { type: 'note', text: 'second' });
    const response = await batch([{ projectId: 'boot', runId, afterSeq: 1 }]);
    expect(response.status).toBe(200);
    expect((liveRunBatchResponseSchema.parse(await response.json()).results[0] as LiveRunBatch).events.map((e: { seq: number }) => e.seq)).toEqual([2]);
  });
});

describe('multiplexed live task feed', () => {
  it('isolates project errors, replays healthy demand and releases listeners on cancellation', async () => {
    store.appendEvent(runId, { type: 'note', text: 'healthy transcript' });
    const controller = new AbortController();
    const before = store.listenerCount('event');
    const response = await apiRequest(app, '/api/v1/workspace/run-events', {
      method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runs: [{ projectId: 'unknown', runId, afterSeq: 0 }, { projectId: 'boot', runId, afterSeq: 0 }] }),
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let wire = '';
    try {
      while (!wire.includes('healthy transcript') || !wire.includes('"type":"error"')) {
        const next = await reader.read();
        if (next.done) throw new Error('stream ended before replay');
        wire += new TextDecoder().decode(next.value);
      }
      expect(wire).toContain('"projectId":"unknown"');
      expect(wire).toContain('"projectId":"boot"');
      expect(store.listenerCount('event')).toBe(before + 1);
    } finally { controller.abort(); await reader.cancel(); }
    expect(store.listenerCount('event')).toBe(before);
  });
  it('keeps the old per-run SSE route and large records compatible', async () => {
    const text = 'x'.repeat(1024 * 1024 + 10);
    store.appendEvent(runId, { type: 'note', text });
    const controller = new AbortController();
    const response = await apiRequest(app, `/api/v1/runs/${runId}/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    let size = 0;
    try {
      while (size < text.length) {
        const { value, done } = await reader.read();
        if (done) throw new Error('legacy replay truncated');
        size += value.length;
      }
      expect(size).toBeGreaterThan(text.length);
    } finally { controller.abort(); await reader.cancel(); }
  });
  it('rejects canonical duplicates on the streaming route too', async () => {
    const response = await apiRequest(app, '/api/v1/workspace/run-events', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runs: ['default', 'boot'].map(projectId => ({ projectId, runId, afterSeq: 0 })) }),
    });
    expect(response.status).toBe(400);
  });
  it('exposes finite checkout recovery with validated identifiers', async () => {
    const response = await apiRequest(app, '/api/v1/projects/checkout/co-fixture/progress');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ progress: null });
    expect((await apiRequest(app, '/api/v1/p/boot/projects/checkout/co-fixture/progress')).status).toBe(404);
  });
});


it('resets an individually oversized wire envelope instead of replaying it forever', async () => {
  store.appendEvent(runId, { type: 'note', text: 'x'.repeat(LIVE_BYTE_LIMIT - 100) });
  const finite = liveRunBatchResponseSchema.parse(await (await batch([{ projectId: 'boot', runId, afterSeq: 0 }])).json());
  expect(finite.results[0]!.type).toBe('batch');
  const controller = new AbortController();
  const response = await apiRequest(app, '/api/v1/workspace/run-events', {
    method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runs: [{ projectId: 'boot', runId, afterSeq: 0 }] }),
  });
  const reader = response.body!.getReader();
  let wire = '';
  try {
    while (!wire.includes('"type":"reset"')) {
      const { value, done } = await reader.read();
      if (done) break;
      wire += new TextDecoder().decode(value);
    }
    expect(wire).toContain('"type":"reset"');
    expect(wire).toContain('"status":413');
  } finally { controller.abort(); await reader.cancel(); }
});


it.each([-1, 0, 1])('delivers or resets at the complete SSE wire boundary (%i)', async difference => {
  const shape = { type: 'event', projectId: 'boot', runId, name: 'run-event', event: { type: 'note', text: '', seq: 1, ts: new Date().toISOString() } }
  const overhead = Buffer.byteLength(`event: live\ndata: ${JSON.stringify(shape)}\n\n`)
  store.appendEvent(runId, { type: 'note', text: 'x'.repeat(LIVE_BYTE_LIMIT + difference - overhead) })
  const controller = new AbortController()
  const response = await apiRequest(app, '/api/v1/workspace/run-events', {
    method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runs: [{ projectId: 'boot', runId, afterSeq: 0 }] }),
  })
  const reader = response.body!.getReader()
  let wire = ''
  try {
    while (!wire.includes('"type":"event"') && !wire.includes('"type":"reset"')) {
      const { value, done } = await reader.read()
      if (done) break
      wire += new TextDecoder().decode(value)
    }
    if (difference > 0) expect(wire).toContain('"status":413')
    else {
      const block = wire.split('\n\n').find(frame => frame.includes('"type":"event"'))!
      expect(block).toBeDefined()
      expect(Buffer.byteLength(block + '\n\n')).toBe(LIVE_BYTE_LIMIT + difference)
    }
  } finally { controller.abort(); await reader.cancel() }
})
