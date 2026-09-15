const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, 'require-e2e-passed.cjs');

function evaluate(output) {
  assert.equal(fs.existsSync(script), true, 'CI must gate TEST_E2E_STATUS through require-e2e-passed.cjs');
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    input: output,
  });
}

test('CI accepts only TEST_E2E_STATUS=passed', () => {
  const result = evaluate('vitest ok\nTEST_E2E_STATUS=passed\n');
  assert.equal(result.status, 0, result.stderr);
});

test('CI rejects TEST_E2E_STATUS=skipped even when the suite exits 0', () => {
  const result = evaluate('E2E SKIPPED — the UI was NOT verified.\nTEST_E2E_STATUS=skipped\n');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /skipped/);
});

test('CI rejects TEST_E2E_STATUS=failed', () => {
  const result = evaluate('a spec failed\nTEST_E2E_STATUS=failed\n');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /failed/);
});

test('CI rejects a run that never printed TEST_E2E_STATUS', () => {
  const result = evaluate('vitest crashed before the marker\n');
  assert.notEqual(result.status, 0);
});

test('CI reads the last TEST_E2E_STATUS when the log contains more than one', () => {
  const passedThenSkipped = evaluate('TEST_E2E_STATUS=passed\nTEST_E2E_STATUS=skipped\n');
  assert.notEqual(passedThenSkipped.status, 0);
  const skippedThenPassed = evaluate('TEST_E2E_STATUS=skipped\nTEST_E2E_STATUS=passed\n');
  assert.equal(skippedThenPassed.status, 0, skippedThenPassed.stderr);
});
