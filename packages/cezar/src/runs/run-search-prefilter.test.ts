import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { matchesRunSearch, sqlPrefilterTokens, type RunSearchRun, type StoredRunSearch } from '@open-mercato/cezar-contract/run-search';

import { RUNS_DB_FILE, RunDatabase } from './run-database.ts';

/**
 * The SQL prefilter only narrows the rows `matchesRunSearch` then judges, so a row it drops can
 * never be found (hearsay-tools/cezarion#1807). This asks the database itself: a run the predicate
 * accepts must come back from `visitRootSummaries` with the prefilter's tokens, read through the
 * real `instr(lower(summary), ?)` over the stored JSON, not a model of it.
 *
 * Seeded and bounded, so CI sees the same cases every time. Two exclusions, each pinned by an
 * example below and tracked by hearsay-tools/cezarion#1884: a number the predicate matches by
 * value (`#007` is PR 7) and the two characters JavaScript folds to ASCII and SQLite does not.
 */
const SEED = 1807;
const RUNS = 400;

let dir: string;
let db: RunDatabase;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cez-run-search-'));
  db = RunDatabase.open(join(dir, RUNS_DB_FILE));
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Whether the prefilter keeps `run`'s stored row: the same row the store would write. */
function keeps(run: RunSearchRun, tokens: readonly string[]): boolean {
  const summary = JSON.stringify({ status: 'done', createdAt: '2026-10-03T21:09:02.000Z', archived: true, tokensUsed: 0, ...run });
  db.transaction({
    upserts: [{ id: 'row', createdAt: '2026-10-03T21:09:02.000Z', status: 'done', archived: true, live: false, data: '{}', summary }],
    deletes: [],
  });
  let kept = false;
  db.visitRootSummaries(tokens, () => { kept = true; return false; });
  return kept;
}

/** Letters no summary key holds, so a key name cannot satisfy the prefilter in place of the value. */
const ALPHABET = [...'xyzjXYZJ0123456789#-/:. ', '"', '\\', '\n', '\u0001', 'é', 'É', 'ß', 'ż', '漢', '😀'];
const text = fc.string({ unit: fc.constantFrom(...ALPHABET), maxLength: 10 });
const optional = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined });
const number = fc.integer({ min: 1, max: 99999 });
const url = fc.tuple(fc.constantFrom('pull', 'issues'), number).map(([kind, n]) => `https://github.com/o/r/${kind}/${n}`);

const runArb: fc.Arbitrary<RunSearchRun> = fc.record({
  id: fc.oneof(fc.uuid(), text),
  title: text,
  titleSummary: text,
  branch: text,
  workflow: text,
  workflowLabel: text,
  automationId: text,
  pullRequestUrl: url,
  referencedPullRequestUrl: url,
  referencedIssueUrl: url,
  pullRequests: fc.array(fc.record({ number, source: fc.constant('declared' as const), url: optional(url) }, { requiredKeys: ['number', 'source'] }), { maxLength: 3 }),
  prNumber: number,
  issueNumber: number,
  markerRefs: fc.record({ pr: number, issue: number }, { requiredKeys: [] }),
}, { requiredKeys: ['id', 'title', 'workflow'] }) as fc.Arbitrary<RunSearchRun>;

/** A number token the predicate matches by value, not by text: `007` for PR 7. */
const zeroPadded = (token: string) => {
  const bare = token.replace(/^#/, '');
  return /^\d+$/.test(bare) && String(Number(bare)) !== bare;
};

/** Pieces of the run itself and of its automation's name (so most queries match) mixed with noise (so some do not). */
function queryArb(run: RunSearchRun, automationName: string | undefined): fc.Arbitrary<string> {
  const numbers = [run.prNumber, run.issueNumber, run.markerRefs?.pr, run.markerRefs?.issue, ...(run.pullRequests ?? []).map((pr) => pr.number)]
    .flatMap((n) => (n === undefined ? [] : [String(n), `#${n}`, `00${n}`, `#00${n}`]));
  const fields = [run.id, run.title, run.titleSummary, run.branch, run.workflow, run.workflowLabel, run.automationId,
    run.pullRequestUrl, run.referencedPullRequestUrl, run.referencedIssueUrl, automationName, ...numbers,
  ].filter((field): field is string => typeof field === 'string' && field !== '');
  const piece = fields.length === 0 ? text : fc.constantFrom(...fields).chain((field) =>
    fc.tuple(fc.nat({ max: field.length - 1 }), fc.integer({ min: 1, max: field.length })).map(([start, length]) => field.slice(start, start + length)));
  const token = fc.oneof({ weight: 6, arbitrary: piece }, { weight: 1, arbitrary: text })
    .filter((candidate) => candidate.trim() !== '' && !zeroPadded(candidate));
  return fc.oneof({ weight: 4, arbitrary: token }, { weight: 1, arbitrary: fc.array(token, { minLength: 2, maxLength: 3 }).map((tokens) => tokens.join(' ')) });
}

describe('sqlPrefilterTokens never drops a run matchesRunSearch accepts', () => {
  it('holds over seeded random runs, queries, modes and automation names', () => {
    let accepted = 0;
    fc.assert(
      fc.property(
        runArb.chain((run) => optional(text).chain((automationName) =>
          fc.tuple(fc.constant(run), queryArb(run, automationName), fc.constantFrom('tokens', 'phrase'), fc.constant(automationName)))),
        ([run, query, mode, automationName]) => {
          const options: StoredRunSearch = {
            mode,
            ...(automationName === undefined ? {} : { automationNames: new Map(run.automationId === undefined ? [] : [[run.automationId, automationName]]) }),
          };
          if (!matchesRunSearch(run, query, options)) return true;
          accepted += 1;
          return keeps(run, sqlPrefilterTokens(query, options));
        },
      ),
      { seed: SEED, numRuns: RUNS },
    );
    // A property over queries nothing matches would pass for nothing.
    expect(accepted).toBeGreaterThan(RUNS / 4);
  });
});

describe('known gaps of the prefilter (hearsay-tools/cezarion#1884)', () => {
  function run(over: Partial<RunSearchRun>): RunSearchRun {
    return { id: 'run-1', title: 'T', workflow: 'w', ...over } as RunSearchRun;
  }

  it('drops a number the predicate matches by value: #007 finds PR 7, the stored summary holds no 007', () => {
    const pr7 = run({ prNumber: 7 });
    expect(matchesRunSearch(pr7, '#007')).toBe(true);
    const tokens = sqlPrefilterTokens('#007');
    expect(tokens).toEqual(['007']);
    expect(keeps(pr7, tokens)).toBe(false);
    // The canonical spelling reads the same on both sides.
    expect(keeps(pr7, sqlPrefilterTokens('#7'))).toBe(true);
  });

  it('drops a match through U+212A (Kelvin sign), which JavaScript folds to k and SQLite lower() does not', () => {
    const kelvin = run({ title: 'Kzzz' });
    expect(matchesRunSearch(kelvin, 'kzzz')).toBe(true);
    expect(keeps(kelvin, sqlPrefilterTokens('kzzz'))).toBe(false);
  });

  it('drops a match through U+0130 (dotted capital I), which JavaScript folds to i plus a combining dot', () => {
    const dotted = run({ title: 'xİ' });
    expect(matchesRunSearch(dotted, 'xi')).toBe(true);
    expect(keeps(dotted, sqlPrefilterTokens('xi'))).toBe(false);
  });
});
