import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source files over 1,000 lines are pinned at their current length (hearsay-tools/cezarion#1800).
 *
 * A pinned file may not grow, and no other file may pass the limit. The baseline only shrinks:
 * after you cut a file, `FILE_LENGTH_UPDATE=1 npm run lint`
 * lowers its pin, and `.github/scripts/baseline-growth.cjs` refuses a pull request that raises one.
 * To start over, delete the baseline and run the same command. It pins what is over the limit then.
 *
 * Counted: every tracked `*.ts`, `*.tsx`, `*.mjs` and `*.cjs` under `packages/`, except tests,
 * test kits, browser specs, `test/` directories and fixtures. Length is the newline count, as `wc -l`.
 */
const repo = join(import.meta.dirname, '../../../..');
const baselinePath = join(import.meta.dirname, '../file-length.baseline.json');

const COUNTED = /\.(ts|tsx|mjs|cjs)$/;
const EXCLUDED = /\.(test|testkit|e2e)\.|\/test\/|__fixtures__|\/fixtures\//;
export const isCounted = (path: string): boolean => COUNTED.test(path) && !EXCLUDED.test(path);
export const lineCount = (text: string): number => text.split('\n').length - 1;
const lengthOf = (lengths: Record<string, number>, path: string): number => lengths[path] ?? 0;

export interface Baseline {
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
export function compareLengths(lengths: Record<string, number>, baseline: Baseline) {
  const over = Object.entries(lengths).filter(([, lines]) => lines > baseline.limit);
  return {
    unpinned: over.filter(([path]) => !(path in baseline.files)).map(([path, lines]) => `${path}: ${lines} lines, over the limit of ${baseline.limit}`),
    grown: over.filter(([path, lines]) => lines > (baseline.files[path] ?? Infinity)).map(([path, lines]) => `${path}: ${lines} lines, pinned at ${baseline.files[path]}`),
    stale: Object.entries(baseline.files)
      .filter(([path, pin]) => lengthOf(lengths, path) < pin || lengthOf(lengths, path) <= baseline.limit)
      .map(([path, pin]) => `${path}: pinned at ${pin}, now ${lengths[path] ?? 'gone'}`),
  };
}

/** Lower every pin to the file's length and drop the pins that no longer apply. Never adds or raises one. */
export function pinnedLengths(lengths: Record<string, number>, baseline: Baseline): Record<string, number> {
  const files = Object.entries(baseline.files)
    .filter(([path]) => lengthOf(lengths, path) > baseline.limit)
    .map(([path, pin]) => [path, Math.min(pin, lengths[path] ?? pin)] as const);
  return Object.fromEntries(files.sort(([a], [b]) => a.localeCompare(b)));
}

function writeBaseline(limit: number, files: Record<string, number>): void {
  const baseline: Baseline = {
    $comment:
      'Non-test source files over 1,000 lines, pinned at their length when the ratchet landed (hearsay-tools/cezarion#1800). ' +
      'A pin only shrinks: cut a file, then run FILE_LENGTH_UPDATE=1 npm run lint. ' +
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

/** The repository length budget, including shrink-only update mode. */
export function fileLengthProblems(update = process.env.FILE_LENGTH_UPDATE === '1'): string[] {
  const lengths = sourceLengths();
  if (update) updateBaseline(lengths);
  if (!existsSync(baselinePath)) {
    return ['packages/cezar/src/file-length.baseline.json:1 file-length: Write the first baseline: FILE_LENGTH_UPDATE=1 npm run lint'];
  }
  const { unpinned, grown, stale } = compareLengths(lengths, readBaseline());
  const report = (entry: string, fix: string): string => {
    const at = entry.indexOf(':');
    return `${entry.slice(0, at)}:1 file-length: ${entry.slice(at + 2)}. ${fix}`;
  };
  return [
    ...unpinned.map((entry) => report(entry, 'Split the file; do not add it to the baseline')),
    ...grown.map((entry) => report(entry, 'Cut the file back to its pin, or split it')),
    ...stale.map((entry) => report(entry, 'Lower the pins: FILE_LENGTH_UPDATE=1 npm run lint')),
  ];
}
