import { describe, expect, it } from 'vitest';
import { compareLengths, isCounted, lineCount, pinnedLengths, type Baseline } from './lint/file-length.ts';

describe('the length rules', () => {
  const baseline: Baseline = { $comment: '', limit: 1000, files: { 'packages/a/long.ts': 1500, 'packages/a/gone.ts': 1200, 'packages/a/shrunk.ts': 1100 } };
  const compare = (lengths: Record<string, number>) => compareLengths(lengths, baseline);

  it('passes pinned files at their pin and every file at the limit', () => {
    const lengths = { 'packages/a/long.ts': 1500, 'packages/a/gone.ts': 1200, 'packages/a/shrunk.ts': 1100, 'packages/a/edge.ts': 1000 };
    expect(compare(lengths)).toEqual({ unpinned: [], grown: [], stale: [] });
  });

  it('fails a pinned file that grew, and a file that passed the limit', () => {
    const lengths = { 'packages/a/long.ts': 1501, 'packages/a/gone.ts': 1200, 'packages/a/shrunk.ts': 1100, 'packages/a/new.ts': 1001 };
    const result = compare(lengths);
    expect(result.grown).toEqual(['packages/a/long.ts: 1501 lines, pinned at 1500']);
    expect(result.unpinned).toEqual(['packages/a/new.ts: 1001 lines, over the limit of 1000']);
    expect(result.stale).toEqual([]);
  });

  it('calls a pin stale once its file shrank, fell to the limit, or went away', () => {
    const lengths = { 'packages/a/long.ts': 1400, 'packages/a/shrunk.ts': 1000 };
    expect(compare(lengths).stale).toEqual([
      'packages/a/long.ts: pinned at 1500, now 1400',
      'packages/a/gone.ts: pinned at 1200, now gone',
      'packages/a/shrunk.ts: pinned at 1100, now 1000',
    ]);
  });

  it('updates a baseline by lowering and dropping pins, never by adding or raising one', () => {
    const lengths = { 'packages/a/long.ts': 1400, 'packages/a/shrunk.ts': 1000, 'packages/a/new.ts': 2000, 'packages/a/gone.ts': 1300 };
    expect(pinnedLengths(lengths, baseline)).toEqual({ 'packages/a/gone.ts': 1200, 'packages/a/long.ts': 1400 });
  });

  it('counts source files and skips tests, test kits, browser specs, test directories and fixtures', () => {
    expect(['a/x.ts', 'a/x.tsx', 'a/x.mjs', 'a/x.cjs', 'packages/web/e2e/agent-browser.ts'].map(isCounted)).toEqual([true, true, true, true, true]);
    const skipped = ['a/x.test.ts', 'a/x.testkit.ts', 'a/x.e2e.ts', 'a/test/x.ts', 'a/__fixtures__/x.ts', 'a/fixtures/x.ts', 'a/x.json', 'a/x.md'];
    expect(skipped.map(isCounted)).toEqual(skipped.map(() => false));
  });

  it('counts newlines as wc -l does', () => {
    expect([lineCount(''), lineCount('a'), lineCount('a\n'), lineCount('a\nb\n')]).toEqual([0, 0, 1, 2]);
  });
});
