const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PACKAGES, DEFAULT_BUDGET, mutableTarget, parseDiff, mergeRanges, plan, mutateArgs, readBudget, checkChangedLines, checkRelatedTests } = require('./mutants-scope.cjs');

const root = path.resolve(__dirname, '../..');

const DIFF = `diff --git a/packages/contract/src/attention.ts b/packages/contract/src/attention.ts
index 1111111..2222222 100644
--- a/packages/contract/src/attention.ts
+++ b/packages/contract/src/attention.ts
@@ -10,0 +11,3 @@ export const A = 1
+a
+b
+c
@@ -40,2 +43 @@ function f() {
-x
-y
+z
@@ -60,2 +62,0 @@ function g() {
-gone
-gone
diff --git a/packages/contract/src/attention.test.ts b/packages/contract/src/attention.test.ts
--- a/packages/contract/src/attention.test.ts
+++ b/packages/contract/src/attention.test.ts
@@ -1 +1,2 @@
+test
diff --git a/packages/cezar/src/workflows/run.ts b/packages/cezar/src/workflows/run.ts
--- a/packages/cezar/src/workflows/run.ts
+++ b/packages/cezar/src/workflows/run.ts
@@ -100,0 +101,2 @@
+one
+two
@@ -102,0 +104,1 @@
+three
diff --git a/docs/sdlc/ci.md b/docs/sdlc/ci.md
--- a/docs/sdlc/ci.md
+++ b/docs/sdlc/ci.md
@@ -1 +1 @@
+docs
`;

test('mutableTarget names the package of product source and nothing else', () => {
  const cases = {
    'packages/cezar/src/workflows/run.ts': 'cezar',
    'packages/web/src/routes/tasks.tsx': 'web',
    'packages/contract/src/attention.ts': 'contract',
    'packages/api-client/src/client.ts': 'api-client',
    'packages/contract/src/attention.test.ts': null,
    'packages/cezar/src/core/tool-grant-parity-cells.testkit.ts': null,
    'packages/web/src/test/e2e-wait-discipline.test.ts': null,
    'packages/web/src/test/helpers.ts': null,
    'packages/cezar/src/__fixtures__/a.ts': null,
    'packages/cezar/src/types.d.ts': null,
    'packages/web/e2e/smoke.e2e.ts': null,
    'packages/cezar/scripts/mock-claude.mjs': null,
    'packages/cezar/src/data.json': null,
    'packages/unknown/src/a.ts': null,
    'scripts/a.ts': null,
    '.github/scripts/mutants-scope.cjs': null,
  };
  for (const [file, expected] of Object.entries(cases)) assert.equal(mutableTarget(file), expected, file);
});

test('parseDiff keeps added and changed lines of product source, drops deletions, tests and docs', () => {
  const parsed = parseDiff(DIFF);
  assert.deepEqual([...parsed.keys()], ['packages/contract/src/attention.ts', 'packages/cezar/src/workflows/run.ts']);
  assert.deepEqual(parsed.get('packages/contract/src/attention.ts'), [[11, 13], [43, 43]]);
  assert.deepEqual(parsed.get('packages/cezar/src/workflows/run.ts'), [[101, 102], [104, 104]]);
});

test('parseDiff reads an empty diff and a quoted path as no work', () => {
  assert.equal(parseDiff('').size, 0);
  assert.equal(parseDiff('+++ b/"packages/web/src/a b.ts"\n@@ -1 +1 @@\n').size, 0);
});

test('mergeRanges joins overlapping and adjacent ranges and sorts the rest', () => {
  assert.deepEqual(mergeRanges([[20, 22], [1, 3], [4, 6], [21, 30], [40, 40]]), [[1, 6], [20, 30], [40, 40]]);
  assert.deepEqual(mergeRanges([]), []);
});

test('plan groups files by package in the fixed package order and counts changed lines', () => {
  const result = plan(parseDiff(DIFF));
  assert.deepEqual(result.map(p => p.name), ['cezar', 'contract']);
  assert.deepEqual(result.map(p => p.changedLines), [3, 4]);
  assert.deepEqual(result[1].files, [{ file: 'packages/contract/src/attention.ts', ranges: [[11, 13], [43, 43]] }]);
  assert.deepEqual(plan(new Map()), []);
});

test('mutateArgs spells each range the way Stryker reads it', () => {
  const [cezar] = plan(parseDiff(DIFF));
  assert.deepEqual(mutateArgs(cezar.files), ['packages/cezar/src/workflows/run.ts:101-102', 'packages/cezar/src/workflows/run.ts:104-104']);
});

test('the package list is the packages with a unit Vitest project, and the Stryker Vitest config names the same', () => {
  const withProject = fs.readdirSync(path.join(root, 'packages'))
    .filter(name => fs.existsSync(path.join(root, 'packages', name, 'vitest.config.ts'))).sort();
  assert.deepEqual([...PACKAGES].sort(), withProject);
  const source = fs.readFileSync(path.join(root, 'vitest.stryker.config.ts'), 'utf8');
  const listed = /const PROJECTS = \[([^\]]*)\]/.exec(source)[1].split(',').map(s => s.trim().replace(/'/g, ''));
  assert.deepEqual(listed, [...PACKAGES]);
});

test('the budget defaults and what the environment may change', () => {
  assert.deepEqual(readBudget({}), DEFAULT_BUDGET);
  assert.deepEqual(readBudget({ MUTANTS_MAX_CHANGED_LINES: '50', MUTANTS_MAX_RELATED_TESTS: '7', MUTANTS_DEADLINE_MINUTES: '12' }),
    { maxChangedLines: 50, maxRelatedTests: 7, deadlineMinutes: 12 });
  const open = readBudget({ MUTANTS_MAX_CHANGED_LINES: '0', MUTANTS_MAX_RELATED_TESTS: '0' });
  assert.equal(open.maxChangedLines, Infinity);
  assert.equal(open.maxRelatedTests, Infinity);
  assert.deepEqual(readBudget({ MUTANTS_MAX_CHANGED_LINES: 'many', MUTANTS_DEADLINE_MINUTES: '-3' }), DEFAULT_BUDGET);
});

test('checkChangedLines and checkRelatedTests name what exceeded the budget', () => {
  const budget = { maxChangedLines: 10, maxRelatedTests: 5, deadlineMinutes: 35 };
  assert.equal(checkChangedLines(10, budget), null);
  assert.match(checkChangedLines(11, budget), /11 changed lines.*budget of 10/);
  assert.equal(checkRelatedTests(5, budget), null);
  assert.match(checkRelatedTests(6, budget), /6 test files import.*budget of 5/);
  assert.equal(checkRelatedTests(10_000, { ...budget, maxRelatedTests: Infinity }), null);
});
