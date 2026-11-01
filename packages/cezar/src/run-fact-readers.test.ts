import { describe, expect, it } from 'vitest';
import { scanRunFacts } from './lint/run-fact-reader.ts';

/**
 * The scanner behind `cez/run-fact-reader` (hearsay-tools/cezarion#1496): run facts are read from
 * the contract. `npm run lint` applies it to the repository and checks the reader list for stale
 * entries; these cases pin what it finds and passes.
 */
describe('run facts are read from the contract (hearsay-tools/cezarion#1496)', () => {
  describe('the scan', () => {
    const rules = (source: string, file = 'packages/web/src/lib/x.ts') => scanRunFacts(file, source).map((s) => s.rule);

    it.each([
      ['an attention compared with ===', "if (attention.label === 'usage limit') go()"],
      ['an optional attention compared with !==', "if (row.attention?.label !== 'running') go()"],
      ['a derived attention', "const held = deriveAttention(run).label === 'usage limit'"],
      ['a derived attention of a call', "const held = deriveAttention(pick(run)).label.startsWith('waiting on ')"],
      ['a lower-cased label', "deriveAttention(run).label.toLowerCase() === id"],
      ['a literal on the left', "if ('needs you' === attention.label) go()"],
      ['a switch', 'switch (attention.label) {}'],
    ])('finds %s', (_name, source) => {
      expect(rules(source)).toEqual(['label-comparison']);
    });

    it.each([
      ['a label printed', 'const text = `Task ${deriveAttention(run).label}`'],
      ['a label in an attribute', '<StatusDot aria-label={attention.label} />'],
      ['a label asserted in a test', "expect(deriveAttention(run).label).toBe('needs you')"],
      ['another object\'s label', "if (bucket.label === 'Needs you') go()"],
      ['a rung compared', "if (attention.rung === 'usage-limit') go()"],
      ['a label compared inside a comment', "// attention.label === 'usage limit'"],
    ])('passes %s', (_name, source) => {
      expect(rules(source)).toEqual([]);
    });

    it.each([
      ['the hold', "if (run.status === 'waiting' && run.autoResumeAt !== undefined) go()"],
      ['its negation', "if (run.status !== 'waiting' || !run.autoResumeAt) return"],
      ['the time first', "const held = run.autoResumeAt !== undefined && run.status === 'waiting'"],
      ['a literal on the left', "const held = 'waiting' === run.status && run.autoResumeAt"],
      ['across lines', "const held = run.status === 'waiting' &&\n  run.autoResumeAt !== undefined"],
    ])('finds %s restated', (_name, source) => {
      expect(rules(source, 'packages/cezar/src/runs/store.ts')).toEqual(['restated-hold']);
    });

    it.each([
      ['the write rule', "if (run.status !== 'waiting') run.autoResumeAt = undefined;"],
      ['another status', "if (run.status === 'failed' && run.autoResumeAt !== undefined) heal()"],
      ['a status alone', "if (run.status === 'waiting' && run.waits) go()"],
      ['two statements', "if (run.status === 'waiting') go(); if (other || run.autoResumeAt) stop()"],
    ])('passes %s', (_name, source) => {
      expect(rules(source, 'packages/cezar/src/runs/store.ts')).toEqual([]);
    });

    it('finds a resume time read in an unlisted source file, once per file', () => {
      expect(rules('const a = run.autoResumeAt; const b = run?.autoResumeAt')).toEqual(['resume-time-read']);
    });

    it('accepts an explicitly listed run module, but not another module', () => {
      const readers = { 'packages/cezar/src/workflows/run/timer.ts': 'owns the timer' };
      const source = 'const time = run.autoResumeAt';
      expect(scanRunFacts('packages/cezar/src/workflows/run/timer.ts', source, readers)).toEqual([]);
      expect(scanRunFacts('packages/cezar/src/workflows/run/other.ts', source, readers).map((s) => s.rule)).toEqual(['resume-time-read']);
    });

    it('passes a resume time in a listed file, a test, a fixture key and a comment', () => {
      expect(rules('const a = run.autoResumeAt', 'packages/web/src/lib/tasks-table.ts')).toEqual([]);
      expect(rules('const a = run.autoResumeAt', 'packages/web/src/lib/x.test.ts')).toEqual([]);
      expect(rules("const run = { autoResumeAt: '2026-10-25T00:00:00.000Z' }")).toEqual([]);
      expect(rules('// reads run.autoResumeAt')).toEqual([]);
    });

    it('lets a test outside the contract spell the hold as its oracle, but not compare a label', () => {
      expect(rules("until(() => run.status === 'waiting' && run.autoResumeAt !== undefined)", 'packages/cezar/src/workflows/x.test.ts')).toEqual([]);
      expect(rules("const needsYou = deriveAttention(run).label === 'needs you'", 'packages/cezar/src/workflows/x.test.ts')).toEqual(['label-comparison']);
    });

    it('lets the contract compare labels and spell the hold, as its definitions and oracles must', () => {
      expect(rules("if (run.status === 'waiting' && run.autoResumeAt !== undefined) go()", 'packages/contract/src/run-predicates.test.ts')).toEqual([]);
      expect(rules("deriveAttention(run).label === 'usage limit'", 'packages/contract/src/attention.test.ts')).toEqual([]);
    });
  });
});
