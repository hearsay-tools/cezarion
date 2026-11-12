#!/usr/bin/env node
'use strict';

// Runs before a failed merge-group shard runs again (ci.yml). It writes the test files that
// failed in the first run to a list, one repository-relative path per line, and deletes
// Vitest's results cache. Vitest's sequencer runs cached failures first and orders the other
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
function failedFiles(cache, root) {
  const { results } = JSON.parse(fs.readFileSync(cache, 'utf8'));
  return results.filter(([, result]) => result?.failed === true)
    .map(([key]) => path.relative(process.cwd(), path.resolve(root, key.slice(key.indexOf(':') + 1))));
}

function resetResults(root, list) {
  const caches = cacheFiles(root);
  const names = new Set();
  for (const cache of caches) {
    try {
      for (const name of failedFiles(cache, root)) names.add(name);
    } catch (error) {
      console.log(`::warning title=Unreadable Vitest results cache::${cache}: ${error.message}. The failed-file list leaves its files out.`);
    }
  }
  const sorted = [...names].sort();
  fs.writeFileSync(list, sorted.map((name) => `${name}\n`).join(''));
  for (const cache of caches) fs.rmSync(cache);
  return sorted;
}

if (require.main === module) {
  const [root, list] = process.argv.slice(2);
  if (!root || !list) {
    console.error('usage: vitest-rerun-reset.cjs <vitest root> <failed-file list>');
    process.exit(2);
  }
  const names = resetResults(root, list);
  console.log(`First run failed files (${names.length}):${names.map((name) => `\n  ${name}`).join('')}`);
}

module.exports = { resetResults };
