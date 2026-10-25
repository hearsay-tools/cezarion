import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// Run in another process: fs hooks and stopped child ownership must not affect
// the node:test coordinator or its other lease tests.
export function checkZombieGroupChurn() {
  const helper = resolve(import.meta.dirname, '../../../../.ai/scripts/test-env-lease.mjs');
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, 'test-env-lease-churn-process.testkit.mjs'), helper], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /"unknownRetained":true,"stableReclaimed":true/);
}
