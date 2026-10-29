// A node:test file, not Vitest: README.md is docs-only, and a docs-only change
// skips Vitest but still runs the build-and-package job, which runs this file
// (hearsay-tools/cezarion#2166).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('documents only current message commands in README examples', () => {
  const readme = readFileSync(new URL('../../../../README.md', import.meta.url), 'utf8');
  assert.doesNotMatch(readme, /\bworker (?:send|progress|follow-up|reply|conversation|inbox|cancel-request|wait-requests)\b/);
  assert.doesNotMatch(readme, /\bworker wait --request\b/);
  assert.ok(readme.includes('cez message request'), 'README names cez message request');
  assert.ok(readme.includes('cez worker resume'), 'README names cez worker resume');
});
