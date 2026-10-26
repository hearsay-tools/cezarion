const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');

/** Run the counter the way mutants-run.cjs does, against the real contract project. */
function count(files, project = 'contract') {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'mutants-related.mjs'), ...files], {
    cwd: root, encoding: 'utf8', env: { ...process.env, STRYKER_PROJECT: project },
  });
  return { ...result, count: Number(JSON.parse(result.stdout.trim().split('\n').at(-1) || '{}').count) };
}

test('counts the test files of the project that import a changed source file', () => {
  const related = count(['packages/contract/src/attention.ts']);
  assert.equal(related.status, 0, related.stderr);
  assert.ok(related.count >= 1, 'attention.test.ts imports attention.ts');
});

test('counts none for a file that no test of the project imports', () => {
  const unrelated = count(['packages/contract/src/not-a-file-anything-imports.ts']);
  assert.equal(unrelated.status, 0, unrelated.stderr);
  assert.equal(unrelated.count, 0);
});

test('refuses to run without a package project, the same rule as the Stryker Vitest config', () => {
  const result = count(['packages/contract/src/attention.ts'], 'everything');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /STRYKER_PROJECT must be one of/);
});
