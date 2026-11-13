#!/usr/bin/env node
'use strict';

// Runs before a failed merge-group shard runs again (ci.yml). It writes the test files that
// failed in the first run to a list, one repository-relative path per line, and deletes
// Vitest's results cache. Files over the duration cap (vitest-file-duration.mjs) passed their
// tests, so they come from the cap's own list, which the reset also deletes. Vitest's sequencer runs cached failures first and orders the other
// files by cached duration, so only with the cache gone does the rerun keep the first order.
const fs = require('node:fs');
const path = require('node:path');

// Vitest keeps one cache per config root, at node_modules/.vite/vitest/<hash>/results.json.
function cacheFiles(root) {
  const dir = path.join(root, 'node_modules', '.vite', 'vitest');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((hash) => path.join(dir, hash, 'results.json')).filter((file) => fs.existsSync(file));
}

// Each entry is ["<project>:<path relative to the root>", { duration, failed }].
function failedFiles(cache, root, cwd) {
  const { results } = JSON.parse(fs.readFileSync(cache, 'utf8'));
  return results.filter(([, result]) => result?.failed === true)
    .map(([key]) => path.relative(cwd, path.resolve(root, key.slice(key.indexOf(':') + 1))));
}

// Must equal CAP_FAILURES_FILE in vitest-file-duration.mjs. Each line is an absolute module path.
const CAP_FAILURES_FILE = path.join('node_modules', '.vite', 'vitest', 'file-duration-cap.txt');

function capFailures(root, cwd) {
  const file = path.join(root, CAP_FAILURES_FILE);
  if (!fs.existsSync(file)) return [];
  const names = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => path.relative(cwd, line));
  fs.rmSync(file);
  return names;
}

// `root` and `list` resolve against `cwd`; the list names files relative to it.
function resetResults(root, list, { cwd = process.cwd(), log = console.log } = {}) {
  const rootDir = path.resolve(cwd, root);
  const caches = cacheFiles(rootDir);
  const names = new Set();
  for (const cache of caches) {
    try {
      for (const name of failedFiles(cache, rootDir, cwd)) names.add(name);
    } catch (error) {
      log(`::warning title=Unreadable Vitest results cache::${cache}: ${error.message}. The failed-file list leaves its files out.`);
    }
  }
  for (const name of capFailures(rootDir, cwd)) names.add(name);
  const sorted = [...names].sort();
  fs.writeFileSync(path.resolve(cwd, list), sorted.map((name) => `${name}\n`).join(''));
  for (const cache of caches) fs.rmSync(cache);
  log(`First run failed files (${sorted.length}):${sorted.map((name) => `\n  ${name}`).join('')}`);
  return sorted;
}

function main(args) {
  const [root, list] = args;
  if (!root || !list) {
    console.error('usage: vitest-rerun-reset.cjs <vitest root> <failed-file list>');
    return 2;
  }
  resetResults(root, list);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, resetResults, CAP_FAILURES_FILE };
