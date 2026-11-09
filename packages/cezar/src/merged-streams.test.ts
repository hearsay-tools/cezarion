import { describe, expect, it } from 'vitest';
import { mergeAppendOnly } from './merged-streams.ts';

type Row = { id: string; at?: string; tag: string };
const merge = (...sources: Row[][]) => mergeAppendOnly(sources, row => row.id, row => row.at).map(row => row.tag);

describe('mergeAppendOnly', () => {
  it('returns one source unchanged, in file order, repeats included', () => {
    expect(merge([{ id: 'a', at: '2026-11-02', tag: 'a2' }, { id: 'a', at: '2026-11-01', tag: 'a1' }], [])).toEqual(['a2', 'a1']);
  });

  it('keeps the legacy copy of a duplicate and interleaves survivors by recorded time', () => {
    expect(merge(
      [{ id: 'x', at: '2026-11-01', tag: 'legacy x' }, { id: 'z', at: '2026-11-03', tag: 'legacy z' }],
      [{ id: 'x', at: '2026-11-05', tag: 'fallback x' }, { id: 'y', at: '2026-11-02', tag: 'fallback y' }],
    )).toEqual(['legacy x', 'fallback y', 'legacy z']);
  });

  it('orders equal times legacy first, and a missing time follows the row before it in its source', () => {
    expect(merge(
      [{ id: 'a', at: '2026-11-02', tag: 'legacy a' }, { id: 'b', tag: 'legacy b' }],
      [{ id: 'c', at: '2026-11-02', tag: 'fallback c' }, { id: 'd', at: '2026-11-01', tag: 'fallback d' }],
    )).toEqual(['fallback d', 'legacy a', 'legacy b', 'fallback c']);
  });
});
