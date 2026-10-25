#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { analyzeSource } from './code-metrics.mjs';

export const thresholds = Object.freeze({ crap: 30, complexity: 20 });

export function exceededMetrics({ complexity, crap }) {
  return Object.entries(thresholds).filter(([key, limit]) =>
    Number.isFinite({ complexity, crap }[key]) && { complexity, crap }[key] > limit,
  ).map(([key]) => key);
}

const normalizeName = name => name.replace(/^anonymous@\d+:\d+$/, 'anonymous');
function identity(fn, functions) {
  return functions.filter(parent => parent.start < fn.start && parent.end >= fn.end)
    .concat(fn).map(item => normalizeName(item.name)).join(' / ');
}

// A change inside a nested body belongs to that function. Keep signatures in
// the parent's comparison so added or replaced functions remain visible.
function ownSource(fn, functions, source, from = fn.start) {
  let at = from, result = '';
  for (const child of functions.filter(item => item.start > fn.start && item.end <= fn.end)) {
    if (child.bodyStart < at) continue;
    result += source.slice(at, child.bodyStart) + '/* nested body */';
    at = child.bodyEnd;
  }
  return result + source.slice(at, fn.end);
}

// Hash of a function's own body, nested bodies masked: the same text under another
// name or in another file hashes alike, so a move or rename can be paired up.
const bodyHash = (fn, functions, source) =>
  createHash('sha256').update(ownSource(fn, functions, source, fn.bodyStart)).digest('hex');
// The distinct trimmed lines of a function's own body: what two copies of one function share.
const bodyLines = (fn, functions, source) =>
  [...new Set(ownSource(fn, functions, source, fn.bodyStart).split('\n').map(line => line.trim()).filter(line => line.length > 3))];
const summary = ({ name, line, complexity }) => ({ name, line, complexity });

/**
 * Compare one file's functions before and after. `changed` lists the functions whose
 * own source differs. With `details`, each carries its decision `points`, `bodyHash` and body `lines`,
 * and `unmatched` lists the functions before that no function after took over. The
 * candidates of an ambiguous match are not unmatched: the comparison keeps them.
 */
export function matchFunctions(before, after, file, { details = false } = {}) {
  const oldFunctions = analyzeSource(before, file);
  const functions = analyzeSource(after, file);
  const used = new Set();
  const ambiguous = new Set();
  const changed = functions.flatMap(fn => {
    const key = identity(fn, functions);
    const candidates = oldFunctions.filter(old => !used.has(old) && identity(old, oldFunctions) === key);
    const text = ownSource(fn, functions, after);
    const equal = candidates.filter(old => ownSource(old, oldFunctions, before) === text);
    const old = equal[0] ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (old) used.add(old);
    if (old && ownSource(old, oldFunctions, before) === text) return [];
    if (candidates.length > 1 && !old) candidates.forEach(candidate => ambiguous.add(candidate));
    return [{
      name: fn.name, line: fn.line, column: fn.column, endLine: fn.endLine,
      complexity: fn.complexity,
      change: old ? 'modified' : candidates.length ? 'unknown' : 'added',
      baseline: old ? summary(old) : null,
      ...(candidates.length > 1 && !old ? {
        reason: 'Several baseline functions match. Inspect the diff before attributing this change.',
        candidates: candidates.map(summary),
      } : {}),
      ...(details ? { bodyHash: bodyHash(fn, functions, after), lines: bodyLines(fn, functions, after), points: fn.points } : {}),
    }];
  });
  const unmatched = details
    ? oldFunctions.filter(old => !used.has(old) && !ambiguous.has(old)).map(old => ({ ...summary(old), bodyHash: bodyHash(old, oldFunctions, before), lines: bodyLines(old, oldFunctions, before) }))
    : [];
  return { changed, unmatched };
}

export const compareFunctions = (before, after, file) => matchFunctions(before, after, file).changed;

const REGULAR_MODES = new Set(['100644', '100755']);
const isSourcePath = path => /\.[cm]?[jt]sx?$/i.test(path);

/** The text of a regular file at a revision: undefined when absent, null for a symlink or submodule. */
function blobAt(pinnedGit, revision, file) {
  // Test existence separately: a failed content read must never become "new".
  const entry = pinnedGit('ls-tree', '-z', revision, '--', `:(literal)${file}`);
  if (!entry) return undefined;
  if (!REGULAR_MODES.has(entry.split(' ')[0])) return null;
  return pinnedGit('show', '--no-textconv', `${revision}:${file}`);
}

// Where the "after" side comes from. The working tree adds staged, unstaged and
// untracked files. A revision reads Git objects only, so CI can inspect a pull
// request head it never checked out.
function workingTreeSide(cwd, pinnedGit, base) {
  return {
    paths: () => [
      ...pinnedGit('diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', base, '--').split('\0'),
      ...pinnedGit('ls-files', '--others', '--exclude-standard', '-z').split('\0'),
    ],
    read(file) {
      const path = join(cwd, file);
      if (!existsSync(path)) return undefined;
      if (!lstatSync(path).isFile()) throw new Error(`Expected a regular source file: ${file}`);
      return readFileSync(path, 'utf8');
    },
  };
}

function revisionSide(pinnedGit, base, head) {
  return {
    paths: () => pinnedGit('diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', base, head, '--').split('\0'),
    read: file => blobAt(pinnedGit, head, file),
  };
}

function matchInFile(before, after, file, options) {
  try { return matchFunctions(before, after, file, options); }
  catch (error) { throw new Error(`${file}: ${error.message}`, { cause: error }); }
}

/**
 * Changed functions between the merge-base of `baseRef` and the head, which is the
 * working tree on top of HEAD unless `head` names a revision to read from Git alone.
 * `details` adds what pairing a moved function needs: each function's decision
 * points and body hash, and `removed`, the base functions no head function took over.
 */
export function scanChanges(baseRef, cwd = process.cwd(), { head: headRevision, details = false } = {}) {
  const git = (...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
  });
  cwd = git('rev-parse', '--show-toplevel').trim();
  const target = git('rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`).trim();
  const head = git('rev-parse', '--verify', '--end-of-options', `${headRevision ?? 'HEAD'}^{commit}`).trim();
  const base = git('merge-base', head, target).trim();
  const pinnedGit = (...args) => git(`--attr-source=${base}`, ...args);
  const side = headRevision ? revisionSide(pinnedGit, base, head) : workingTreeSide(cwd, pinnedGit, base);
  const paths = [...new Set(side.paths().filter(isSourcePath))].sort();
  const files = [], deletedFiles = [], removed = [];
  for (const file of paths) {
    const after = side.read(file);
    if (after === null) continue;
    const before = blobAt(pinnedGit, base, file) ?? '';
    if (after === undefined) {
      deletedFiles.push(file);
      if (!details) continue; // A deleted file has no scores; only pairing a move reads its old functions.
    }
    const { changed, unmatched } = matchInFile(before, after ?? '', file, { details });
    removed.push(...unmatched.map(fn => ({ file, ...fn })));
    if (changed.length) files.push({ file, sourceHash: createHash('sha256').update(after).digest('hex'), functions: changed });
  }
  return {
    schemaVersion: 1, root: cwd, target, head, base, thresholds, files, deletedFiles, ...(details ? { removed } : {}),
  };
}

export function runChangedFunctions(args, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const { values, positionals } = parseArgs({ args, options: { base: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
    if (values.help) {
      stdout.write('Usage: node <skill>/scripts/changed-functions.mjs --base <PR-target-ref>\n\nLists changed JS/TS functions against the merge-base, including staged, unstaged,\nand untracked files. Returns baseline complexity and policy thresholds as JSON.\n');
      return 0;
    }
    if (!values.base?.trim() || positionals.length) throw new Error('Supply --base <PR-target-ref>. An unknown base cannot pass the check.');
    stdout.write(JSON.stringify(scanChanges(values.base, cwd), null, 2) + '\n');
    return 0;
  } catch (error) {
    stderr.write(`changed-functions: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = runChangedFunctions(process.argv.slice(2));
}
