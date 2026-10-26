'use strict';
// Which lines of a pull request the mutation job mutates, and whether a package fits the budget.
// Pure functions: mutants-run.cjs does the git and process work. Advisory job, never a merge gate.

// The packages with a unit Vitest project. vitest.stryker.config.ts names the same four; the test pins the pair.
const PACKAGES = ['cezar', 'contract', 'api-client', 'web'];

// Test code and fixtures inside src/ say nothing about product code, so they are never mutated.
const NOT_PRODUCT = /(^|\/)(__tests__|__fixtures__|fixtures|test|tests)\/|\.(test|testkit|spec|e2e)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/;

// What one pull request may cost. 0 lifts a cap (the timing probe does).
const DEFAULT_BUDGET = { maxChangedLines: 400, maxRelatedTests: 150, deadlineMinutes: 35 };

/** The package that owns a mutable product source file, or null for any other path. */
function mutableTarget(file) {
  const match = /^packages\/([^/]+)\/src\/.+\.(?:ts|tsx)$/.exec(file);
  if (!match || !PACKAGES.includes(match[1]) || NOT_PRODUCT.test(file)) return null;
  return match[1];
}

/** Sort ranges and join the ones that overlap or touch. */
function mergeRanges(ranges) {
  const merged = [];
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = merged.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * Added and changed lines per mutable file, from `git diff -U0 --no-color --no-renames`.
 * A pure deletion adds no line, and a path git had to quote is skipped.
 */
function parseDiff(text) {
  const found = new Map();
  let file = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('+++ ')) {
      const name = line.startsWith('+++ b/') ? line.slice(6) : '';
      file = mutableTarget(name) ? name : null;
      continue;
    }
    const hunk = file && /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0) found.set(file, [...(found.get(file) ?? []), [Number(hunk[1]), Number(hunk[1]) + count - 1]]);
  }
  return new Map([...found].map(([name, ranges]) => [name, mergeRanges(ranges)]));
}

const countLines = ranges => ranges.reduce((sum, [start, end]) => sum + end - start + 1, 0);

/** Group the changed files by owning package, in PACKAGES order. */
function plan(changed) {
  const groups = PACKAGES.map(name => ({ name, files: [], changedLines: 0 }));
  for (const [file, ranges] of changed) {
    const group = groups.find(g => g.name === mutableTarget(file));
    group.files.push({ file, ranges });
    group.changedLines += countLines(ranges);
  }
  return groups.filter(g => g.files.length > 0);
}

/** Stryker's `--mutate` spelling: `path:startLine-endLine`. */
function mutateArgs(files) {
  return files.flatMap(({ file, ranges }) => ranges.map(([start, end]) => `${file}:${start}-${end}`));
}

function number(value, fallback, { zeroMeans } = {}) {
  if (!/^\d+$/.test(value ?? '')) return fallback;
  return Number(value) === 0 && zeroMeans !== undefined ? zeroMeans : Number(value);
}

/** The default budget, with the three MUTANTS_* variables applied. Junk values leave a default alone. */
function readBudget(env) {
  const deadline = number(env.MUTANTS_DEADLINE_MINUTES, DEFAULT_BUDGET.deadlineMinutes);
  return {
    maxChangedLines: number(env.MUTANTS_MAX_CHANGED_LINES, DEFAULT_BUDGET.maxChangedLines, { zeroMeans: Infinity }),
    maxRelatedTests: number(env.MUTANTS_MAX_RELATED_TESTS, DEFAULT_BUDGET.maxRelatedTests, { zeroMeans: Infinity }),
    deadlineMinutes: deadline > 0 ? deadline : DEFAULT_BUDGET.deadlineMinutes,
  };
}

/** A reason to skip a package for its size, or null. */
function checkChangedLines(changedLines, budget) {
  return changedLines > budget.maxChangedLines
    ? `${changedLines} changed lines is over the budget of ${budget.maxChangedLines}` : null;
}

/**
 * A reason to skip a package for the tests its mutants would run, or null. With none, Stryker
 * stops with "No tests were executed" (the probe saw it on a one-line api-client change), and
 * nothing could kill a mutant anyway.
 */
function checkRelatedTests(relatedTests, budget) {
  if (relatedTests === 0) return 'no test file in this package imports the changed files, so no test could kill a mutant';
  return relatedTests > budget.maxRelatedTests
    ? `${relatedTests} test files import the changed files, over the budget of ${budget.maxRelatedTests}` : null;
}

module.exports = { PACKAGES, DEFAULT_BUDGET, mutableTarget, mergeRanges, parseDiff, plan, mutateArgs, readBudget, checkChangedLines, checkRelatedTests };
