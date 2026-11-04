import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { registrationCalls } from './split-registration.testkit.ts';

it('counts direct registration calls and preserves duplicate group names', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cez-registration-'));
  try {
    writeFileSync(join(directory, 'family-row.test.ts'), `registerGroup('first');\nregisterGroup("first");\nregisterGroup(\n 'second'\n);`);
    expect(registrationCalls(pathToFileURL(`${directory}/`), 'family-', 'registerGroup')).toEqual(['first', 'first', 'second']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('ignores registration text in comments, strings and uncalled bodies', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cez-registration-'));
  try {
    writeFileSync(join(directory, 'family-row.test.ts'), `
// registerGroup('comment');
/* registerGroup('block comment'); */
const text = "registerGroup('string')";
const template = \`registerGroup('template')\`;
function unused() { registerGroup('function'); }
if (false) registerGroup('disabled');
`);
    expect(registrationCalls(pathToFileURL(`${directory}/`), 'family-', 'registerGroup')).toEqual([]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
