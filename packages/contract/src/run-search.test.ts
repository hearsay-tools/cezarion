import { describe, expect, it, vi } from 'vitest';
import {
  RUN_SEARCH_FIELDS, matchesRunSearch, refNumberFromUrl, searchTokens, sqlPrefilterTokens,
  type RunSearchExtras, type RunSearchField, type RunSearchFieldId,
} from './run-search.ts';
import type { RunSummary } from './runs.ts';

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

describe('matchesRunSearch (stored scope)', () => {
  it('requires every token', () => {
    expect(matchesRunSearch(summary(), 'fix login')).toBe(true);
    expect(matchesRunSearch(summary(), 'fix logout')).toBe(false);
  });

  it('ignores case', () => {
    expect(matchesRunSearch(summary(), 'FIX LoGiN')).toBe(true);
  });

  it('matches a reference number with or without #', () => {
    for (const over of [
      { issueNumber: 864 },
      { prNumber: 864 },
      { markerRefs: { pr: 864 } },
      { referencedIssueUrl: 'https://github.com/o/r/issues/864' },
    ] satisfies Partial<RunSummary>[]) {
      expect(matchesRunSearch(summary(over), '864')).toBe(true);
      expect(matchesRunSearch(summary(over), '#864')).toBe(true);
    }
  });

  it('needs an exact reference number, but a title substring still matches', () => {
    expect(matchesRunSearch(summary({ issueNumber: 864 }), '86')).toBe(false);
    expect(matchesRunSearch(summary({ issueNumber: 864, title: 'Ship 86 fixes' }), '86')).toBe(true);
  });

  it('never matches a number inside a reference URL or the middle of an id', () => {
    const run = summary({ id: 'ab864cd0-0000-4000-8000-000000000000', referencedIssueUrl: 'https://github.com/o/r/issues/864', pullRequestUrl: 'https://github.com/o/r/pull/8641' });
    expect(matchesRunSearch(run, '86')).toBe(false);
    expect(matchesRunSearch(run, '#86')).toBe(false);
    expect(matchesRunSearch(run, '864')).toBe(true);
    expect(matchesRunSearch(summary({ id: '86400000-0000-4000-8000-000000000000' }), '864')).toBe(true);
    expect(matchesRunSearch(summary({ branch: 'fix/864-lists' }), '864')).toBe(true);
  });

  it('matches id prefix, branch, workflow label and title summary', () => {
    expect(matchesRunSearch(summary(), '998ad06a')).toBe(true);
    expect(matchesRunSearch(summary({ branch: 'cez/aee1234c' }), 'cez/aee1')).toBe(true);
    expect(matchesRunSearch(summary({ workflowLabel: 'brainstorm' }), 'brainst')).toBe(true);
    expect(matchesRunSearch(summary({ titleSummary: 'Bound the run lists' }), 'bound lists')).toBe(true);
  });

  it('matches non-ASCII tokens', () => {
    expect(matchesRunSearch(summary({ title: 'Zażółć gęślą' }), 'zażółć')).toBe(true);
  });

  it('matches nothing for a blank query, in either mode', () => {
    expect(matchesRunSearch(summary(), '   ')).toBe(false);
    expect(matchesRunSearch(summary(), '   ', { mode: 'phrase' })).toBe(false);
  });

  it('matches an automation by its name, or its id when unnamed, only when given the names (hearsay-tools/cezarion#1616)', () => {
    const launched = summary({ automationId: 'auto-7f3' });
    const names = new Map([['auto-7f3', 'Dependency bump']]);
    expect(matchesRunSearch(launched, 'dependency login', { automationNames: names })).toBe(true);
    expect(matchesRunSearch(launched, 'auto-7f3', { automationNames: new Map() })).toBe(true);
    // The palette passes no names: it shows no origin line, so the automation is not searched.
    expect(matchesRunSearch(launched, 'auto-7f3')).toBe(false);
    expect(matchesRunSearch(summary(), 'dependency', { automationNames: names })).toBe(false);
  });

  it('matches every collection-only PR exactly for cold and archived summaries', () => {
    const run = summary({ pullRequests: Array.from({ length: 5 }, (_, i) => ({ number: 812 + i, source: 'declared', url: `https://github.com/o/r/pull/${812 + i}` })) });
    for (const number of [812, 813, 814, 815, 816]) {
      expect(matchesRunSearch(run, `#${number}`)).toBe(true);
      expect(matchesRunSearch(run, String(number))).toBe(true);
    }
    expect(matchesRunSearch(run, '#81')).toBe(false);
    expect(matchesRunSearch(run, 'github.com/o/r')).toBe(true);
    expect(matchesRunSearch(run, '#999')).toBe(false);
  });
});

describe('matchesRunSearch (shown scope)', () => {
  const shown = (extras: RunSearchExtras = {}, omit?: readonly RunSearchFieldId[]) =>
    ({ scope: 'shown' as const, extras, ...(omit ? { omit } : {}) });

  it('searches the title the row prints, never the raw title or the summary it hides', () => {
    const run = summary({ title: 'plz fix', titleSummary: 'Repair the thing' });
    expect(matchesRunSearch(run, 'repair', shown({ displayTitle: 'Repair the thing' }))).toBe(true);
    expect(matchesRunSearch(run, 'plz', shown({ displayTitle: 'Repair the thing' }))).toBe(false);
    expect(matchesRunSearch(run, 'repair', shown())).toBe(false);
  });

  it('searches branch, workflow, workflow label and what the reader adds', () => {
    const run = summary({ branch: 'cez/e5f6a7b8', workflow: 'plan-then-do', workflowLabel: 'om-fix' });
    const extras = { displayTitle: 'T', automation: 'Nightly health check', projectName: 'Storefront', tags: ['frontend'] };
    for (const query of ['e5f6', 'plan-then', 'om-fix', 'nightly', 'storefront', 'frontend']) {
      expect(matchesRunSearch(run, query, shown(extras)), query).toBe(true);
    }
    expect(matchesRunSearch(run, 'nightly', shown({ displayTitle: 'T' }))).toBe(false);
  });

  it('does not search the id or the URLs, which a row never prints', () => {
    const run = summary({ pullRequestUrl: 'https://github.com/o/r/pull/8641' });
    expect(matchesRunSearch(run, '998ad06a', shown({ displayTitle: 'T' }))).toBe(false);
    expect(matchesRunSearch(run, 'github.com', shown({ displayTitle: 'T' }))).toBe(false);
  });

  it('matches a number only against the references the row shows, exactly, with or without #', () => {
    const run = summary({ issueNumber: 864 });
    const references = () => [864];
    expect(matchesRunSearch(run, '864', shown({ references }))).toBe(true);
    expect(matchesRunSearch(run, '#864', shown({ references }))).toBe(true);
    expect(matchesRunSearch(run, '86', shown({ references }))).toBe(false);
    // The run holds 864, but the row shows no reference for it.
    expect(matchesRunSearch(run, '864', shown())).toBe(false);
  });

  it('asks for the references only when a token is a number that no text matched', () => {
    const references = vi.fn(() => [864]);
    const run = summary();
    matchesRunSearch(run, 'login', shown({ displayTitle: 'Fix the login bug', references }));
    matchesRunSearch(run, '86', shown({ displayTitle: 'Ship 86 fixes', references }));
    expect(references).not.toHaveBeenCalled();
    expect(matchesRunSearch(run, '864', shown({ displayTitle: 'T', references }))).toBe(true);
    expect(references).toHaveBeenCalledTimes(1);
  });

  it('leaves out a field the reader omits, and no other', () => {
    const run = summary({ workflowLabel: 'om-fix', workflow: 'inbox' });
    expect(matchesRunSearch(run, 'om-fix', shown({ displayTitle: 'T' }))).toBe(true);
    expect(matchesRunSearch(run, 'om-fix', shown({ displayTitle: 'T' }, ['workflowLabel']))).toBe(false);
    expect(matchesRunSearch(run, 'inbox', shown({ displayTitle: 'T' }, ['workflowLabel']))).toBe(true);
  });

  it('matches the query as one phrase in phrase mode, and per token otherwise', () => {
    const run = summary();
    const extras = { displayTitle: 'Fix the login bug' };
    expect(matchesRunSearch(run, 'the login', { ...shown(extras), mode: 'phrase' })).toBe(true);
    expect(matchesRunSearch(run, 'login fix', { ...shown(extras), mode: 'phrase' })).toBe(false);
    // Only the ends are trimmed: a double space inside the phrase is part of it.
    expect(matchesRunSearch(run, ' the  login ', { ...shown(extras), mode: 'phrase' })).toBe(false);
    expect(matchesRunSearch(run, 'login fix', shown(extras))).toBe(true);
  });

  it('matches a number typed alone as a reference in phrase mode, not one inside a longer phrase', () => {
    const run = summary();
    const references = () => [12];
    expect(matchesRunSearch(run, ' #12 ', { ...shown({ references }), mode: 'phrase' })).toBe(true);
    expect(matchesRunSearch(run, 'fix 12', { ...shown({ displayTitle: 'T', references }), mode: 'phrase' })).toBe(false);
  });
});

describe('RUN_SEARCH_FIELDS', () => {
  const fields: readonly RunSearchField[] = RUN_SEARCH_FIELDS;
  const full = summary({
    titleSummary: 'Bound the run lists',
    branch: 'cez/aee1234c',
    automationId: 'auto-7f3',
    pullRequestUrl: 'https://github.com/o/r/pull/11',
    referencedPullRequestUrl: 'https://github.com/o/r/pull/12',
    referencedIssueUrl: 'https://github.com/o/r/issues/13',
    pullRequests: [{ number: 14, source: 'declared', url: 'https://github.com/o/r/pull/14' }],
    prNumber: 15,
    issueNumber: 16,
    markerRefs: { pr: 17, issue: 18 },
  });

  it('lists every summary-sourced value verbatim in the stored summary, which is all the SQL prefilter reads', () => {
    const stored = JSON.stringify(full).toLowerCase();
    const summarySourced = fields.filter((field) => field.source === 'summary');
    expect(summarySourced.length).toBeGreaterThan(0);
    for (const field of summarySourced) {
      const values = field.kind === 'reference' ? field.numbers(full, {}).map(String) : field.texts(full, {}).filter((text) => text !== undefined);
      expect(values.length, field.id).toBeGreaterThan(0);
      for (const value of values) expect(stored, `${field.id}: ${value}`).toContain(String(value).toLowerCase());
    }
  });

  it('gives every reader-sourced field of the stored scope a universe for the prefilter to leave out', () => {
    const readerSourced = fields.filter((field) => field.scopes.includes('stored') && field.source === 'reader');
    expect(readerSourced.map((field) => field.id)).toEqual(['automation']);
    for (const field of readerSourced) expect(field.universe, field.id).toBeTypeOf('function');
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

  it('leaves out a token inside an automation name, which the stored summary does not hold (hearsay-tools/cezarion#1616)', () => {
    expect(sqlPrefilterTokens('Bump login', { automationNames: new Map([['auto-7f3', 'Dependency bump']]) })).toEqual(['login']);
  });

  it('drops a token that is only #', () => {
    expect(sqlPrefilterTokens('# fix')).toEqual(['fix']);
  });

  it('prefilters the whole phrase in phrase mode', () => {
    expect(sqlPrefilterTokens(' Fix the ', { mode: 'phrase' })).toEqual(['fix the']);
  });
});

describe('refNumberFromUrl', () => {
  it('reads the trailing number', () => {
    expect(refNumberFromUrl('https://github.com/o/r/pull/774')).toBe(774);
    expect(refNumberFromUrl('https://github.com/o/r/pull/774/')).toBe(774);
    expect(refNumberFromUrl('https://github.com/o/r/pulls')).toBeNull();
  });
});
