#!/usr/bin/env node
// The CI ratchet on function complexity (hearsay-tools/cezarion#1800). It compares each
// function a pull request changes with its merge-base counterpart and fails on a function
// above the limit that is new or more complex than that counterpart, so a pull request can
// lower a long function but never grow one. A function the change does not touch is never
// read. The head is read as Git objects only, so CI can run this from trusted base code.
// CRAP joins the gate once CI publishes coverage (hearsay-tools/cezarion#1780).
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { scanChanges, thresholds } from './changed-functions.mjs';

const OWNER_NOTE = 'For an owner-approved increase, the owner adds the baseline-growth label, then re-runs the failed complexity-gate job.';
const APPROVED_NOTE = 'Complexity growth approved by the baseline-growth label; owner merge required.';
const MAX_POINTS = 40;
const MAX_HINTS = 10;
// Two functions that share this fraction of their body lines can be one function moved and edited.
const MIN_SIMILARITY = 0.5;
const HELP = `Usage: node <skill>/scripts/complexity-gate.mjs --base <ref> --head <rev> [--allow-growth]

Fail when a function that the head changes since the merge-base of <ref> and <rev> has
classic complexity above ${thresholds.complexity} and is new or above its merge-base complexity.
A moved or renamed function is compared with the function it came from. The head is read
from Git objects only; the working tree and untracked files are ignored.

  --allow-growth  Print the findings as warnings and exit 0 (the baseline-growth label)
  -h, --help      Show this help

Exit codes: 0 pass, 1 complexity grew, 2 the check could not run (bad revision, unparseable file).
`;

const isNamed = name => !name.startsWith('anonymous@');
const simpleName = name => name.split('.').at(-1);
const tally = lines => lines.reduce((counts, line) => counts.set(line, (counts.get(line) ?? 0) + 1), new Map());

/** Dice coefficient of two functions' body lines, repeats counted: 1 for one body, 0 for none in common. */
export function similarity(a = [], b = []) {
  const counts = tally(b);
  let shared = 0;
  for (const [line, count] of tally(a)) shared += Math.min(count, counts.get(line) ?? 0);
  return a.length + b.length ? (2 * shared) / (a.length + b.length) : 0;
}

/** The one donor closest to `fn` by body, at least MIN_SIMILARITY close; none when two are equally close. */
function closestDonor(fn, donors) {
  const scored = donors.map(item => ({ item, score: similarity(item.lines, fn.lines) })).filter(({ score }) => score >= MIN_SIMILARITY);
  const best = Math.max(...scored.map(({ score }) => score));
  const top = scored.filter(({ score }) => score === best);
  return top.length === 1 ? top[0].item : undefined;
}
const mostComplex = (best, item) => (!best || item.complexity > best.complexity ? item : best);

/**
 * Pair each added function, which has no counterpart in its own file, with a function the change
 * removed: first one with an identical body (a move or rename), then the one same-named function
 * that shares the most of its body lines, at least half of them (a move with edits). Two equally close
 * origins leave it new. A removed function serves one pair, so a clone is still new, and a
 * same-named function with another body is still new.
 */
export function pairMoves(candidates, removed) {
  const free = new Set(removed);
  const pairs = new Map();
  const take = (fn, donor) => {
    if (donor) { free.delete(donor); pairs.set(fn, donor); }
  };
  for (const fn of candidates) take(fn, [...free].filter(item => item.bodyHash === fn.bodyHash).reduce(mostComplex, undefined));
  for (const fn of candidates.filter(item => !pairs.has(item) && isNamed(item.name))) {
    take(fn, closestDonor(fn, [...free].filter(item => isNamed(item.name) && simpleName(item.name) === simpleName(fn.name))));
  }
  return { pairs, free };
}

/** The merge-base function a changed function descends from, with how it was found. */
function counterpartOf(fn, moved) {
  if (moved) return { kind: 'moved', ...moved };
  if (fn.baseline) return { kind: 'modified', file: fn.file, ...fn.baseline };
  if (!fn.candidates) return undefined;
  return { kind: 'ambiguous', file: fn.file, count: fn.candidates.length, ...fn.candidates.reduce(mostComplex, undefined) };
}

export function findGrowth(scan, limit = thresholds.complexity) {
  const changed = scan.files.flatMap(file => file.functions.map(fn => ({ ...fn, file: file.file })));
  const over = changed.filter(fn => fn.complexity > limit);
  const { pairs, free } = pairMoves(over.filter(fn => fn.change === 'added'), scan.removed);
  const results = over.map(fn => ({ fn, from: counterpartOf(fn, pairs.get(fn)) }));
  const growth = results.filter(({ fn, from }) => !from || fn.complexity > from.complexity);
  return {
    limit, checked: changed.length, files: scan.files.length, growth,
    moved: results.filter(item => item.from?.kind === 'moved' && !growth.includes(item)),
    kept: results.filter(item => item.from?.kind !== 'moved' && !growth.includes(item)),
    lost: [...free].filter(item => item.complexity > limit),
  };
}

const WAS = {
  moved: from => `was ${from.complexity} in ${from.file}:${from.name} at the merge base`,
  modified: from => `was ${from.complexity} at the merge base`,
  ambiguous: from => `was at most ${from.complexity} among ${from.count} functions with this name at the merge base`,
};
const headline = ({ fn, from }, limit) =>
  `${fn.file}:${fn.line} ${fn.name}: complexity ${fn.complexity} (${from ? WAS[from.kind](from) : 'new function'}; limit ${limit})`;

const shellWord = text => `'${text.replaceAll("'", "'\\''")}'`;

/** The commands that print each complexity: the head's, and the merge base's when a counterpart exists. */
function reproduce({ fn, from }, { root, base }) {
  const metrics = relative(root, fileURLToPath(new URL('./metrics.mjs', import.meta.url)));
  const select = (name, line) => `${isNamed(name) ? `--function ${shellWord(name)} ` : ''}--line ${line}`;
  const head = `node ${metrics} ${shellWord(fn.file)} ${select(fn.name, fn.line)} --breakdown`;
  if (!from) return [`head: ${head}`];
  const copy = `"\${TMPDIR:-/tmp}/complexity-base${extname(from.file)}"`;
  return [`head: ${head}`, `base: git show ${base}:${from.file} > ${copy} && node ${metrics} ${copy} ${select(from.name, from.line)}`];
}

function pointLines(fn) {
  const shown = fn.points.slice(0, MAX_POINTS).map(point => `      ${point.line} ${point.kind}`);
  const hidden = fn.points.length - shown.length;
  return ['    decision points at head:', ...shown, ...(hidden > 0 ? [`      ... ${hidden} more (the head command lists all)`] : [])];
}

function lostLines({ growth, lost, limit }) {
  if (!lost.length || !growth.some(({ from }) => !from)) return [];
  return ['', `The change removed these functions over ${limit}. The gate pairs a moved function only by identical body, or by name and a mostly shared body:`,
    ...lost.slice(0, MAX_HINTS).map(item => `  ${item.file}:${item.line} ${item.name} (complexity ${item.complexity})`)];
}

export function growthReport(result, context) {
  const { growth, limit } = result;
  return [
    `${growth.length} changed ${growth.length === 1 ? 'function is' : 'functions are'} over the complexity limit of ${limit} and new or more complex than at the merge base:`,
    ...growth.flatMap(item => ['', headline(item, limit), ...reproduce(item, context).map(line => `  ${line}`), ...pointLines(item.fn)]),
    ...lostLines(result),
  ];
}

const escapeData = text => text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const escapeProperty = text => escapeData(text).replaceAll(':', '%3A').replaceAll(',', '%2C');
const annotation = (level, item, limit) =>
  `::${level} file=${escapeProperty(item.fn.file)},line=${item.fn.line},title=Function complexity::${escapeData(headline(item, limit))}`;

/** A notice, not a failure: a changed function over the limit that did not grow still fails the pre-PR check. */
function keptLines({ kept, limit }) {
  if (!kept.length) return [];
  const [verb, pronoun] = kept.length === 1 ? ['function stays', 'it'] : ['functions stay', 'them'];
  return ['', `${kept.length} changed ${verb} over ${limit} without growing. The pre-PR check still reports ${pronoun}:`,
    ...kept.slice(0, MAX_HINTS).map(item => `  ${headline(item, limit)}`),
    ...(kept.length > MAX_HINTS ? [`  ... ${kept.length - MAX_HINTS} more`] : [])];
}

function passReport(result, seconds) {
  return [
    `Checked ${result.checked} changed functions in ${result.files} files in ${seconds.toFixed(1)} s: none over ${result.limit} is new or more complex than at the merge base.`,
    ...result.moved.map(item => `  matched to a removed function: ${headline(item, result.limit)}`),
    ...keptLines(result),
  ];
}

export function runComplexityGate(args, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      base: { type: 'string' }, head: { type: 'string' }, 'allow-growth': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) { stdout.write(HELP); return 0; }
    if (!values.base?.trim() || !values.head?.trim() || positionals.length) throw new Error('Supply --base <ref> and --head <rev>. An unknown revision cannot pass the gate.');
    const started = performance.now();
    const scan = scanChanges(values.base, cwd, { head: values.head, details: true });
    const result = findGrowth(scan);
    const allowed = Boolean(values['allow-growth']);
    if (!result.growth.length) {
      stdout.write(passReport(result, (performance.now() - started) / 1000).join('\n') + '\n');
      return 0;
    }
    const lines = [...growthReport(result, { root: scan.root, base: scan.base }), '', allowed ? APPROVED_NOTE : OWNER_NOTE];
    if (env.GITHUB_ACTIONS === 'true') lines.push(...result.growth.map(item => annotation(allowed ? 'warning' : 'error', item, result.limit)));
    stdout.write(lines.join('\n') + '\n');
    return allowed ? 0 : 1;
  } catch (error) {
    stderr.write(`complexity-gate: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = runComplexityGate(process.argv.slice(2));
}
