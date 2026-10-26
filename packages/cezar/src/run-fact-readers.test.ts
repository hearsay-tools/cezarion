import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blank } from './test-wait-discipline.testkit.ts';

/**
 * Run facts have one home in `packages/contract` (hearsay-tools/cezarion#1496): a reader decides
 * on the attention rung id, never on the label copy, and calls `isUsageLimitHold` rather than
 * spelling the hold out. Types catch a new rung id; this scan catches the two things types cannot,
 * a label comparison (in any file) and a restated hold (in a source file), plus an `autoResumeAt`
 * read in a source file not listed below.
 * TypeScript 7 has no parser API, so the scan reads `blank()`ed source, as
 * `contract-import-boundaries.test.ts` does.
 */
const repo = join(import.meta.dirname, '../../..');
const SCANNED = ['packages/cezar/src', 'packages/cezar/test', 'packages/web/src', 'packages/web/e2e', 'packages/api-client/src', 'packages/contract/src'];
/** The facts' home: it defines the rungs and the hold, and its tests keep the deleted copies as oracles. */
const HOME = 'packages/contract/src/';

/** Source files that read or write `autoResumeAt`, each with its reason. Tests build fixtures freely. */
const RESUME_TIME_READERS: Record<string, string> = {
  'packages/contract/src/waits.ts': 'defines `isUsageLimitHold` and names the usage-limit wait by its time',
  'packages/cezar/src/runs/store.ts': 'the write rule, load-time healing, and the withdrawal and resume writes',
  'packages/cezar/src/workflows/run.ts': 'arms, re-arms, withdraws and clears the resume timer at its time',
  'packages/cezar/src/runs/run-row.ts': 'the live column keeps an older row with a stale time live, so the store can heal it',
  'packages/cezar/src/runs/run-index.ts': 'the cold reader decodes a summary with a stale time to heal it',
  'packages/cezar/src/task-cli/projections.ts': 'prints the resume time beside the usage-limit label',
  'packages/web/src/lib/run-row-meta.ts': 'prints the time until the resume',
  'packages/web/src/lib/tasks-table.ts': 'prints the resume time in the status cell',
  'packages/web/src/lib/task-groups.ts': 'orders two holds by their resume times',
  'packages/web/src/routes/task-thread/auto-resume-hint.tsx': 'prints the resume time in the thread hint',
};

type Rule = 'label-comparison' | 'restated-hold' | 'resume-time-read';
interface Site { file: string; line: number; rule: Rule; text: string }

const isTest = (file: string) => /\.(?:test|e2e)\.tsx?$|\.testkit\.tsx?$|\/test\//.test(file);

/** Where the receiver of the `.label` at `dot` starts, when it is an attention: a name ending in
 *  `attention` or `Attention` (a property path included), or a `deriveAttention(…)` call. -1 otherwise. */
function attentionReceiver(code: string, dot: number): number {
  const name = /[\w$.?]*[aA]ttention$/.exec(code.slice(Math.max(0, dot - 80), dot));
  if (name) return dot - name[0].length;
  if (code.charAt(dot - 1) !== ')') return -1;
  let depth = 0;
  for (let i = dot - 1; i >= 0; i--) {
    const ch = code.charAt(i);
    if (ch === ')') depth++;
    else if (ch === '(' && --depth === 0) {
      const callee = /\bderiveAttention\s*$/.exec(code.slice(Math.max(0, i - 40), i));
      return callee ? i - callee[0].length : -1;
    }
  }
  return -1;
}

/** A comparison or a text test made on the label: `===`, `!==`, a string method, or a `switch`.
 *  `start` is where the receiver starts and `end` where `.label` ends. */
function comparesLabel(code: string, start: number, end: number): boolean {
  if (/^\s*(?:===|!==|==|!=)|^\.(?:startsWith|endsWith|includes|toLowerCase|toUpperCase|match|localeCompare)\b/.test(code.slice(end, end + 24))) return true;
  return /(?:===|!==|==|!=)\s*$|\bswitch\s*\(\s*$/.test(code.slice(Math.max(0, start - 24), start));
}

/** Every `status` compared with `'waiting'`, as offsets in `code`. */
function waitingComparisons(source: string, code: string): Array<{ start: number; end: number }> {
  const sites: Array<{ start: number; end: number }> = [];
  const quoted = (at: number, length: number) => /^(['"])waiting\1$/.test(source.slice(at, at + length));
  for (const match of code.matchAll(/\.status\s*(?:===|!==)\s*(['"]) *\1/g)) {
    const literal = match[0].length - match[0].search(/['"]/);
    if (quoted(match.index + match[0].length - literal, literal)) sites.push({ start: match.index, end: match.index + match[0].length });
  }
  for (const match of code.matchAll(/(['"]) *\1\s*(?:===|!==)\s*[\w$.?]*\.status\b/g)) {
    const literal = match[0].search(/\s*(?:===|!==)/);
    if (quoted(match.index, literal)) sites.push({ start: match.index, end: match.index + match[0].length });
  }
  return sites;
}

/** Whether a `.autoResumeAt` sits in the same condition as the comparison: joined by `&&` or `||`,
 *  with no statement or block boundary between. */
function joinedWithResumeTime(code: string, at: { start: number; end: number }): boolean {
  const joined = (between: string) => /&&|\|\|/.test(between) && !/[;{}]/.test(between);
  const after = code.slice(at.end, at.end + 160);
  const forward = after.search(/\??\.autoResumeAt\b/);
  if (forward >= 0 && joined(after.slice(0, forward))) return true;
  const before = code.slice(Math.max(0, at.start - 160), at.start);
  const back = [...before.matchAll(/\??\.autoResumeAt\b/g)].at(-1);
  return back !== undefined && joined(before.slice(back.index + back[0].length));
}

function scanRunFacts(file: string, source: string): Site[] {
  const code = blank(source);
  const lines = source.split('\n');
  const lineAt = (offset: number) => code.slice(0, offset).split('\n').length;
  const site = (rule: Rule, offset: number): Site => ({ file, line: lineAt(offset), rule, text: lines[lineAt(offset) - 1]!.trim() });
  const sites: Site[] = [];
  if (!file.startsWith(HOME)) {
    for (const match of code.matchAll(/\??\.label\b/g)) {
      const start = attentionReceiver(code, match.index);
      if (start >= 0 && comparesLabel(code, start, match.index + match[0].length)) sites.push(site('label-comparison', match.index));
    }
    // A test may spell the hold out: there it is an oracle for the record the engine wrote.
    for (const at of isTest(file) ? [] : waitingComparisons(source, code)) {
      if (joinedWithResumeTime(code, at)) sites.push(site('restated-hold', at.start));
    }
  }
  if (!isTest(file) && !(file in RESUME_TIME_READERS)) {
    const first = code.search(/\??\.autoResumeAt\b/);
    if (first >= 0) sites.push(site('resume-time-read', first));
  }
  return sites;
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(join(repo, dir))) return [];
  return readdirSync(join(repo, dir), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => relative(repo, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .filter((path) => !/\/(?:node_modules|dist|__fixtures__)\//.test(path))
    .sort();
}

const HOW: Record<Rule, string> = {
  'label-comparison': 'decide on `attention.rung`; the label is copy',
  'restated-hold': 'call `isUsageLimitHold(run)` from the contract\'s waits module',
  'resume-time-read': 'decide through `isUsageLimitHold`, or add the file to RESUME_TIME_READERS with its reason',
};

describe('run facts are read from the contract (hearsay-tools/cezarion#1496)', () => {
  it('no reader compares an attention label, restates the hold, or reads the resume time unlisted', () => {
    const sites = SCANNED.flatMap(sourceFiles).flatMap((file) => scanRunFacts(file, readFileSync(join(repo, file), 'utf8')));
    expect(sites.map((s) => `${s.file}:${s.line} ${s.rule}: ${s.text} — ${HOW[s.rule]}`)).toEqual([]);
  });

  it('lists only files that still read the resume time', () => {
    const stale = Object.keys(RESUME_TIME_READERS).filter((file) => {
      const path = join(repo, file);
      return !existsSync(path) || !/\??\.autoResumeAt\b/.test(blank(readFileSync(path, 'utf8')));
    });
    expect(stale).toEqual([]);
  });

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
