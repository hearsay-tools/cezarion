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
function ownSource(fn, functions, source) {
  let at = fn.start, result = '';
  for (const child of functions.filter(item => item.start > fn.start && item.end <= fn.end)) {
    if (child.bodyStart < at) continue;
    result += source.slice(at, child.bodyStart) + '/* nested body */';
    at = child.bodyEnd;
  }
  return result + source.slice(at, fn.end);
}

export function compareFunctions(before, after, file) {
  const oldFunctions = analyzeSource(before, file);
  const functions = analyzeSource(after, file);
  const used = new Set();
  return functions.flatMap(fn => {
    const key = identity(fn, functions);
    const candidates = oldFunctions.filter(old => !used.has(old) && identity(old, oldFunctions) === key);
    const text = ownSource(fn, functions, after);
    const equal = candidates.filter(old => ownSource(old, oldFunctions, before) === text);
    const old = equal[0] ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (old) used.add(old);
    if (old && ownSource(old, oldFunctions, before) === text) return [];
    return [{
      name: fn.name, line: fn.line, column: fn.column, endLine: fn.endLine,
      complexity: fn.complexity,
      change: old ? 'modified' : candidates.length ? 'unknown' : 'added',
      baseline: old ? { name: old.name, line: old.line, complexity: old.complexity } : null,
      ...(candidates.length > 1 && !old ? { reason: 'Several baseline functions match. Inspect the diff before attributing this change.' } : {}),
    }];
  });
}

export function scanChanges(baseRef, cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
  });
  cwd = git('rev-parse', '--show-toplevel').trim();
  const target = git('rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`).trim();
  const head = git('rev-parse', '--verify', 'HEAD^{commit}').trim();
  const base = git('merge-base', head, target).trim();
  const pinnedGit = (...args) => git(`--attr-source=${base}`, ...args);
  const paths = [...new Set([
    ...pinnedGit('diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', base, '--').split('\0'),
    ...pinnedGit('ls-files', '--others', '--exclude-standard', '-z').split('\0'),
  ].filter(path => /\.[cm]?[jt]sx?$/i.test(path)))].sort();
  const files = [], deletedFiles = [];
  for (const file of paths) {
    const path = join(cwd, file);
    if (!existsSync(path)) { deletedFiles.push(file); continue; }
    if (!lstatSync(path).isFile()) throw new Error(`Expected a regular source file: ${file}`);
    const after = readFileSync(path, 'utf8');
    let before = '';
    // Test existence separately: a failed content read must never become "new".
    const entry = pinnedGit('ls-tree', '-z', base, '--', `:(literal)${file}`);
    if (entry) before = pinnedGit('show', '--no-textconv', `${base}:${file}`);
    const functions = compareFunctions(before, after, file);
    if (functions.length) files.push({ file, sourceHash: createHash('sha256').update(after).digest('hex'), functions });
  }
  return { schemaVersion: 1, root: cwd, target, head, base, thresholds, files, deletedFiles };
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
