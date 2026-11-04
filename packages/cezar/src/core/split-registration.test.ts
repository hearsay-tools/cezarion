import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { registrationCalls } from './split-registration.testkit.ts';

it('counts direct registration calls and preserves duplicate group names', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cez-registration-'));
  try {
    writeFileSync(join(directory, 'family-row.test.ts'), `import { registerGroup } from "./family.testkit.ts";\nregisterGroup('first');\nregisterGroup("first");\nregisterGroup(\n 'second'\n);`);
    expect(registrationCalls(pathToFileURL(`${directory}/`), 'family-', 'registerGroup')).toEqual(['first', 'first', 'second']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('ignores registration text in comments and larger strings', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cez-registration-'));
  try {
    writeFileSync(join(directory, 'family-row.test.ts'), `
// registerGroup('comment');
/* registerGroup('block comment'); */
const text = "registerGroup('string')";
const template = \`registerGroup('template')\`;
`);
    expect(registrationCalls(pathToFileURL(`${directory}/`), 'family-', 'registerGroup')).toEqual([]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const source of [
  "registerGroup(part);",
  "registerGroup('first');",
  "function registerGroup() {} registerGroup('first');",
  "import { registerGroup as hidden } from './family.testkit.ts'; hidden('first');",
  "registerGroup('first'); const duplicate = registerGroup('first');",
  "function unused() { registerGroup('first'); }",
  "if (false) registerGroup('first');",
]) {
  it(`rejects unsupported registration references: ${source}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'cez-registration-'));
    try {
      writeFileSync(join(directory, 'family-row.test.ts'), source);
      expect(() => registrationCalls(pathToFileURL(`${directory}/`), 'family-', 'registerGroup'))
        .toThrow(/family-row\.test\.ts: unsupported registerGroup registration:/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
