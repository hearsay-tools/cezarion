import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@open-mercato/cezar-contract';
import { matchesRunQuery, refNumberFromUrl, searchTokens, sqlPrefilterTokens } from './run-search.ts';

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    id: '998ad06a-d0ca-44c5-baa3-796cdc700652',
    title: 'Fix the login bug',
    status: 'done',
    createdAt: '2026-10-03T21:09:02.000Z',
    archived: true,
    workflow: '(planned)',
    workflowLabel: 'implement',
    tokensUsed: 0,
    ...over,
  } as RunSummary;
}

describe('matchesRunQuery', () => {
  it('requires every token', () => {
    expect(matchesRunQuery(summary(), 'fix login')).toBe(true);
    expect(matchesRunQuery(summary(), 'fix logout')).toBe(false);
  });

  it('ignores case', () => {
    expect(matchesRunQuery(summary(), 'FIX LoGiN')).toBe(true);
  });

  it('matches a reference number with or without #', () => {
    for (const over of [
      { issueNumber: 864 },
      { prNumber: 864 },
      { markerRefs: { pr: 864 } },
      { referencedIssueUrl: 'https://github.com/o/r/issues/864' },
    ] satisfies Partial<RunSummary>[]) {
      expect(matchesRunQuery(summary(over), '864')).toBe(true);
      expect(matchesRunQuery(summary(over), '#864')).toBe(true);
    }
  });

  it('needs an exact reference number, but a title substring still matches', () => {
    expect(matchesRunQuery(summary({ issueNumber: 864 }), '86')).toBe(false);
    expect(matchesRunQuery(summary({ issueNumber: 864, title: 'Ship 86 fixes' }), '86')).toBe(true);
  });

  it('never matches a number inside a reference URL or the middle of an id', () => {
    const run = summary({ id: 'ab864cd0-0000-4000-8000-000000000000', referencedIssueUrl: 'https://github.com/o/r/issues/864', pullRequestUrl: 'https://github.com/o/r/pull/8641' });
    expect(matchesRunQuery(run, '86')).toBe(false);
    expect(matchesRunQuery(run, '#86')).toBe(false);
    expect(matchesRunQuery(run, '864')).toBe(true);
    expect(matchesRunQuery(summary({ id: '86400000-0000-4000-8000-000000000000' }), '864')).toBe(true);
    expect(matchesRunQuery(summary({ branch: 'fix/864-lists' }), '864')).toBe(true);
  });

  it('matches id prefix, branch, workflow label and title summary', () => {
    expect(matchesRunQuery(summary(), '998ad06a')).toBe(true);
    expect(matchesRunQuery(summary({ branch: 'cez/aee1234c' }), 'cez/aee1')).toBe(true);
    expect(matchesRunQuery(summary({ workflowLabel: 'brainstorm' }), 'brainst')).toBe(true);
    expect(matchesRunQuery(summary({ titleSummary: 'Bound the run lists' }), 'bound lists')).toBe(true);
  });

  it('matches non-ASCII tokens', () => {
    expect(matchesRunQuery(summary({ title: 'Zażółć gęślą' }), 'zażółć')).toBe(true);
  });

  it('matches nothing for a blank query', () => {
    expect(matchesRunQuery(summary(), '   ')).toBe(false);
  });
});

describe('searchTokens / sqlPrefilterTokens', () => {
  it('splits, lowercases and drops empties', () => {
    expect(searchTokens('  Fix   LOGIN ')).toEqual(['fix', 'login']);
  });

  it('keeps only ASCII tokens, without a leading #', () => {
    expect(sqlPrefilterTokens('zażółć #864 Fix')).toEqual(['864', 'fix']);
  });

  it('leaves out tokens JSON escapes, which instr over the stored summary would miss', () => {
    expect(sqlPrefilterTokens('"quoted" back\\slash fix')).toEqual(['fix']);
  });

  it('drops a token that is only #', () => {
    expect(sqlPrefilterTokens('# fix')).toEqual(['fix']);
  });
});

describe('refNumberFromUrl', () => {
  it('reads the trailing number', () => {
    expect(refNumberFromUrl('https://github.com/o/r/pull/774')).toBe(774);
    expect(refNumberFromUrl('https://github.com/o/r/pull/774/')).toBe(774);
    expect(refNumberFromUrl('https://github.com/o/r/pulls')).toBeNull();
  });
});
