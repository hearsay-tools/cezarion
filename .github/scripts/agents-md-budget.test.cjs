// AGENTS.md loads on every agent turn (hearsay-tools/cezarion#1746). This test
// holds it to the byte limit in .github/agents-md.baseline.json, and makes a PR
// that shrinks the file lower the limit too, so the limit only goes down.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..', '..');
const baselinePath = '.github/agents-md.baseline.json';
const SLACK_BYTES = 1024;

test('AGENTS.md stays within its byte limit, and the limit follows it down', () => {
  const { maxBytes } = JSON.parse(fs.readFileSync(path.join(repoRoot, baselinePath), 'utf8'));
  assert.ok(Number.isInteger(maxBytes) && maxBytes > 0, `${baselinePath} needs a positive integer maxBytes`);
  const bytes = fs.statSync(path.join(repoRoot, 'AGENTS.md')).size;
  assert.ok(bytes <= maxBytes, [
    `AGENTS.md is ${bytes} bytes, over its limit of ${maxBytes} in ${baselinePath}.`,
    'Put the new rule in the narrowest document its tasks already read and leave AGENTS.md a pointer',
    '(docs/sdlc/friction.md, Where a new agent rule goes), or trim AGENTS.md elsewhere.',
    'Raise maxBytes only with the owner\'s approval in this PR.',
  ].join('\n'));
  assert.ok(maxBytes - bytes <= SLACK_BYTES,
    `AGENTS.md is ${bytes} bytes, ${maxBytes - bytes} under its limit. Lower maxBytes in ${baselinePath} to ${bytes} so the limit only goes down.`);
});
