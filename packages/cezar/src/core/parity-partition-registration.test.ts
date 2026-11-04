import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { checkParityRegistration, type ParityCollector } from './parity-partition.testkit.ts';

function describeFixtureParity(part: string, collect?: ParityCollector): void {
  if (part === 'all' || part === 'first') collect?.('runner A1 first');
  if (part === 'all' || part === 'second') collect?.('runner A2 second');
}

function scratchGuard(extra: string, check: (run: () => void) => void, reformatted = false): void {
  const directory = mkdtempSync(join(tmpdir(), 'cez-parity-registration-'));
  try {
    const entry = reformatted
      ? "import {\n describeFixtureParity\n} from './fixture.testkit.ts';\n"
      : "import { describeFixtureParity } from './fixture.testkit.ts';\n";
    writeFileSync(join(directory, 'first.test.ts'), `${entry}describeFixtureParity('first');`);
    writeFileSync(join(directory, 'second.test.ts'), `${entry}describeFixtureParity('second');`);
    writeFileSync(join(directory, 'extra.test.ts'), extra);
    check(() => checkParityRegistration('fixture', describeFixtureParity, ['runner A1', 'runner A2'], 2, pathToFileURL(`${directory}/`)));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

it('discovers reformatted imports and preserves literal registrations', () => {
  scratchGuard("const unrelated = 'ordinary fixture';", run => expect(run).not.toThrow(), true);
});

for (const source of [
  "import { describeFixtureParity } from './fixture.testkit.ts';",
  "import {\n describeFixtureParity\n} from './fixture.testkit.ts';",
  "import { describeFixtureParity } from './fixture.testkit.ts';\ndescribeFixtureParity('missing');",
  "import {\n describeFixtureParity\n} from './fixture.testkit.ts'; describeFixtureParity(part);",
  "import { describeFixtureParity as hidden } from './fixture.testkit.ts'; hidden('first');",
  "import {\n describeFixtureParity\n} from './fixture.testkit.ts'; describeFixtureParity('first');",
]) {
  it(`rejects unsupported or duplicate parity registrations: ${source}`, () => {
    scratchGuard(source, run => expect(run).toThrow());
  });
}
