import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import { visit } from './home-boundary.ts';
import { declaredRunnerIds, literalText, parserPlugins } from './runner-id-branch.ts';
import { lineAt, repoRoot, type SourceRule } from './source-rule.ts';

/**
 * `RUNNER_IDS` in `core/agent-runner.ts` is the one roster of runners. A second list written by
 * hand keeps compiling when a runner is added, and that runner is then missing from one seam
 * (open-mercato/cezar#387).
 *
 * Static scope: every JS and TS file under `packages/`, tests included, except the file that
 * defines `RUNNER_IDS`. The rule reports an array literal whose string elements name every id of
 * `RUNNER_IDS`, in any order and with any other element beside them.
 *
 * It leaves out a list that omits a runner (a deliberate subset), a roster spelled as a union
 * type, as object keys or as separate arguments, and a list built from parts. An object typed
 * `Record<RunnerId, …>` needs no rule: the compiler refuses a missing key.
 *
 * `runner-roster-literal.baseline.json` lists the files that keep a roster, each with its count
 * and a reason. It only shrinks: `npm run lint` fails a stale entry, and CI's baseline-growth
 * gate refuses a new one.
 */
const DEFINITION = 'packages/cezar/src/core/agent-runner.ts';

export const runnerRostersFile = 'packages/cezar/src/lint/runner-roster-literal.baseline.json';

let declared: string[] | undefined;

/** Where each hand-written full roster starts in `source`. */
export function runnerRosters(file: string, source: string, ids: readonly string[] = (declared ??= declaredRunnerIds())): number[] {
  // A roster quotes every id; most files do not and are not parsed.
  if (!ids.every(id => ['\'', '"', '`'].some(quote => source.includes(`${quote}${id}${quote}`)))) return [];
  const ast = parse(source, { sourceType: 'module', plugins: parserPlugins(file) });
  const offsets: number[] = [];
  visit(ast.program, (node) => {
    if (node.type !== 'ArrayExpression') return;
    const named = new Set(node.elements.map(element => (element ? literalText(element) : undefined)));
    if (ids.every(id => named.has(id))) offsets.push(node.start ?? 0);
  });
  return offsets;
}

/** A file that keeps `count` hand-written rosters. */
export interface RunnerRosterException { file: string; count: number; reason: string }

export function readRunnerRosterExceptions(path = join(repoRoot, runnerRostersFile)): RunnerRosterException[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { entries: RunnerRosterException[] }).entries;
}

let listed: RunnerRosterException[] | undefined;

/** The rosters beyond what the list allows for the file. */
export function scanRunnerRosters(file: string, source: string, exceptions = (listed ??= readRunnerRosterExceptions())): number[] {
  return runnerRosters(file, source).slice(exceptions.find(entry => entry.file === file)?.count ?? 0);
}

const applies = (file: string) => /^packages\/.+\.[cm]?[jt]sx?$/.test(file) && file !== DEFINITION;

/** Entries that allow more than the file still has, repeat another entry, or give no reason. */
export function staleRunnerRosters(root = repoRoot): string[] {
  const seen = new Set<string>();
  return readRunnerRosterExceptions(join(root, runnerRostersFile)).flatMap((entry) => {
    const path = join(root, entry.file);
    const actual = existsSync(path) ? runnerRosters(entry.file, readFileSync(path, 'utf8')).length : 0;
    const valid = applies(entry.file) && Number.isInteger(entry.count) && entry.count > 0 && entry.reason.trim() !== '' && !seen.has(entry.file);
    seen.add(entry.file);
    return valid && actual === entry.count ? [] : [
      `${runnerRostersFile} cez/runner-roster-literal: stale or invalid entry ${entry.file} (lists ${entry.count}, the file has ${actual}); lower the count or remove the entry`,
    ];
  });
}

export const runnerRosterLiteral: SourceRule = {
  name: 'runner-roster-literal',
  description: 'RUNNER_IDS is the one roster of runners; no other array literal lists every runner id (open-mercato/cezar#387).',
  applies,
  check: (file, source) => scanRunnerRosters(file, source).map(offset => ({
    line: lineAt(source, offset),
    message: 'This array lists every runner id by hand, so a new runner would be missing here. Use RUNNER_IDS or isRunnerId() from packages/cezar/src/core/agent-runner.ts; a Node-free package derives from runnerSchema.options in packages/contract/src/runner.ts (open-mercato/cezar#387).',
  })),
};
