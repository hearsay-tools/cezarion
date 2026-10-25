import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source files over 1,000 lines are pinned at their current length (hearsay-tools/cezarion#1800).
 *
 * A pinned file may not grow, and no other file may pass the limit. The baseline only shrinks:
 * after you cut a file, `FILE_LENGTH_UPDATE=1 npm test -- packages/cezar/src/file-length.test.ts`
 * lowers its pin, and `.github/scripts/baseline-growth.cjs` refuses a pull request that raises one.
 * To start over, delete the baseline and run the same command. It pins what is over the limit then.
 *
 * Counted: every tracked `*.ts`, `*.tsx`, `*.mjs` and `*.cjs` under `packages/`, except tests,
 * test kits, browser specs, `test/` directories and fixtures. Length is the newline count, as `wc -l`.
 */
const repo = join(import.meta.dirname, '../../..');
const baselinePath = join(import.meta.dirname, 'file-length.baseline.json');

const COUNTED = /\.(ts|tsx|mjs|cjs)$/;
const EXCLUDED = /\.(test|testkit|e2e)\.|\/test\/|__fixtures__|\/fixtures\//;
const isCounted = (path: string): boolean => COUNTED.test(path) && !EXCLUDED.test(path);
const lineCount = (text: string): number => text.split('\n').length - 1;

interface Baseline {
  $comment: string;
  limit: number;
  files: Record<string, number>;
}

function sourceLengths(): Record<string, number> {
  const listed = execFileSync('git', ['ls-files', '-z', '--', 'packages'], { cwd: repo, encoding: 'utf8', maxBuffer: 16 << 20 });
  return Object.fromEntries(
    listed
      .split('\0')
      .filter((path) => path && isCounted(path))
      .map((path) => [path, lineCount(readFileSync(join(repo, path), 'utf8'))]),
  );
}

const readBaseline = (): Baseline => JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;

/**
 * `unpinned`: a file over the limit that the baseline lacks. `grown`: a pinned file longer than its pin.
 * `stale`: a pin above the file's length, or for a file that is gone or at the limit or under it. The
 * baseline must shrink to match, or the ratchet would let the file grow back.
 */
function compareLengths(lengths: Record<string, number>, baseline: Baseline) {
  const over = Object.entries(lengths).filter(([, lines]) => lines > baseline.limit);
  return {
    unpinned: over.filter(([path]) => !(path in baseline.files)).map(([path, lines]) => `${path}: ${lines} lines, over the limit of ${baseline.limit}`),
    grown: over.filter(([path, lines]) => lines > (baseline.files[path] ?? Infinity)).map(([path, lines]) => `${path}: ${lines} lines, pinned at ${baseline.files[path]}`),
    stale: Object.entries(baseline.files)
      .filter(([path, pin]) => (lengths[path] ?? 0) < pin || (lengths[path] ?? 0) <= baseline.limit)
      .map(([path, pin]) => `${path}: pinned at ${pin}, now ${lengths[path] ?? 'gone'}`),
  };
}

/** Lower every pin to the file's length and drop the pins that no longer apply. Never adds or raises one. */
function pinnedLengths(lengths: Record<string, number>, baseline: Baseline): Record<string, number> {
  const files = Object.entries(baseline.files)
    .filter(([path]) => (lengths[path] ?? 0) > baseline.limit)
    .map(([path, pin]) => [path, Math.min(pin, lengths[path] ?? pin)] as const);
  return Object.fromEntries(files.sort(([a], [b]) => a.localeCompare(b)));
}

function writeBaseline(limit: number, files: Record<string, number>): void {
  const baseline: Baseline = {
    $comment:
      'Non-test source files over 1,000 lines, pinned at their length when the ratchet landed (hearsay-tools/cezarion#1800). ' +
      'A pin only shrinks: cut a file, then run FILE_LENGTH_UPDATE=1 npm test -- packages/cezar/src/file-length.test.ts. ' +
      'A new file over the limit is a failure, not an entry. Rules: docs/sdlc/ci.md.',
    limit,
    files,
  };
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
}

/** Lower the pins, or pin everything over the limit when there is no baseline yet. */
function updateBaseline(lengths: Record<string, number>, limit = 1000): void {
  if (existsSync(baselinePath)) {
    const baseline = readBaseline();
    writeBaseline(baseline.limit, pinnedLengths(lengths, baseline));
    return;
  }
  const over = Object.entries(lengths).filter(([, lines]) => lines > limit);
  writeBaseline(limit, Object.fromEntries(over.sort(([a], [b]) => a.localeCompare(b))));
}

describe('source file length', () => {
  it('keeps every source file over the limit at or under its pin, and pins no other file', () => {
    const lengths = sourceLengths();
    if (process.env.FILE_LENGTH_UPDATE === '1') updateBaseline(lengths);
    expect(existsSync(baselinePath), 'Write the first baseline: FILE_LENGTH_UPDATE=1 npm test -- packages/cezar/src/file-length.test.ts').toBe(true);
    const { unpinned, grown, stale } = compareLengths(lengths, readBaseline());
    expect(unpinned, 'Split the file; do not add it to the baseline').toEqual([]);
    expect(grown, 'Cut the file back to its pin, or split it').toEqual([]);
    expect(stale, 'Lower the pins: FILE_LENGTH_UPDATE=1 npm test -- packages/cezar/src/file-length.test.ts').toEqual([]);
  });
});

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
