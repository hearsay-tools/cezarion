import { describe, expect, it } from 'vitest';
import { LIVE_BYTE_LIMIT, type RunEvent } from '@open-mercato/cezar-contract';
import { LiveItemSnapshots } from './live-item-snapshots.ts';

const started = (id = 'item', text = '', stepId = 'step'): RunEvent => ({
  type: 'item.started', seq: 1, ts: '', stepId, item: { id, kind: 'message', role: 'assistant', text },
});
const delta = (itemId = 'item', text = 'next', stepId = 'step'): RunEvent => ({
  type: 'item.delta', seq: 2, ts: '', stepId, itemId, field: 'text', delta: text,
});

describe('bounded active item snapshots', () => {
  it('isolates runs/steps and coalesces reasoning, message and tool output without mutating earlier reads', () => {
    const cache = new LiveItemSnapshots();
    for (const [id, kind, field] of [['message', 'message', 'text'], ['reason', 'reasoning', 'reasoning'], ['tool', 'tool', 'output']]) {
      cache.observe('a', { ...started(id), item: { id, kind, text: 'prefix', output: 'prefix' } }, false);
      cache.observe('a', { ...delta(id, ' one'), field }, true);
    }
    const before = cache.read('a');
    cache.observe('a', delta('message', ' two'), true);
    cache.observe('b', started(), false);
    cache.observe('b', delta('item', 'other run'), true);
    cache.observe('a', started('message', '', 'different-step'), false);
    cache.observe('a', delta('message', 'other step', 'different-step'), true);
    expect(before.map(event => event.item)).toMatchObject([{ text: 'prefix one' }, { text: 'prefix one' }, { output: 'prefix one' }]);
    expect(cache.read('a').map(event => event.item)).toContainEqual(expect.objectContaining({ text: 'prefix one two' }));
    expect(cache.read('b').map(event => event.item)).toMatchObject([{ text: 'other run' }]);
  });

  it('replaces content-only updates and releases completed items, sessions, deleted runs and closed stores', () => {
    const cache = new LiveItemSnapshots();
    cache.observe('a', started(), false);
    cache.observe('a', delta(), true);
    cache.observe('a', { ...started('item', 'replacement'), type: 'item.updated', seq: 3 }, true);
    expect(cache.read('a')).toMatchObject([{ seq: 3, item: { text: 'replacement' } }]);
    cache.observe('a', { ...started(), type: 'item.completed' }, false);
    expect(cache.read('a')).toEqual([]);
    for (const type of ['session.started', 'session.ended']) {
      cache.observe('a', started(), false); cache.observe('a', delta(), true);
      cache.observe('a', { type, seq: 3, ts: '', stepId: 'step' }, false);
      expect(cache.read('a')).toEqual([]);
    }
    cache.observe('a', started(), false); cache.observe('a', delta(), true);
    cache.observe('b', started(), false); cache.observe('b', delta(), true);
    cache.forget('a'); expect(cache.read('a')).toEqual([]); expect(cache.read('b')).toHaveLength(1);
    cache.clear(); expect(cache.read('b')).toEqual([]);
  });

  it('caps total item count across runs and never reconstructs an evicted prefix from a delta suffix', () => {
    const cache = new LiveItemSnapshots();
    for (let i = 0; i < 257; i++) {
      cache.observe(`run${i}`, started(), false);
      cache.observe(`run${i}`, delta(), true);
    }
    expect(cache.read('run0')).toEqual([]);
    cache.observe('run0', delta('item', 'suffix'), true);
    expect(cache.read('run0')).toEqual([]);
    expect(Array.from({ length: 257 }, (_, i) => cache.read(`run${i}`).length).reduce((a, b) => a + b)).toBe(256);
    cache.observe('run0', { ...started('item', 'full snapshot'), type: 'item.updated' }, true);
    expect(cache.read('run0')).toMatchObject([{ item: { text: 'full snapshot' } }]);
  });

  it('caps UTF-8 bytes per item and across the store without truncating content', () => {
    const cache = new LiveItemSnapshots();
    for (let i = 0; i < 5; i++) cache.observe('a', { ...started(String(i), '界'.repeat(300_000)), type: 'item.updated' }, true);
    expect(cache.read('a')).toHaveLength(4);
    expect(cache.read('a').every(event => JSON.stringify(event).includes('界'.repeat(300_000)))).toBe(true);
    cache.observe('a', { ...started('huge', '界'.repeat(LIVE_BYTE_LIMIT / 3)), type: 'item.updated' }, true);
    expect(cache.read('a')).toHaveLength(4);
    cache.observe('a', delta('4', 'x'.repeat(200_000)), true);
    expect(cache.read('a')).toHaveLength(3);
    cache.observe('a', delta('4', 'suffix'), true);
    expect(cache.read('a')).toHaveLength(3);
  });
});
