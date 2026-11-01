import { describe, expect, it } from 'vitest';
import { mockSourceViolations } from './lint/native-mock-source.ts';

/**
 * The scanner behind `cez/native-mock-source` (hearsay-tools/cezarion#1479): tests run the real
 * native mocks and never read, splice or swap mock source. `npm run lint` applies it to the
 * repository; these cases pin what it refuses and allows.
 */
describe('native mock source boundary', () => {
  it.each([
    ['an adapter mockBin read', "const source = readFileSync(adapter.mockBin, 'utf8');", 'reads native mock source'],
    ['a mock script read by URL', "readFileSync(new URL('../../scripts/mock-codex-app-server.mjs', import.meta.url), 'utf8');", 'reads native mock source'],
    ['a harness mock constant read', 'const text = await readFile(CLAUDE_MOCK);', 'reads native mock source'],
    ['an adapter mockBin assignment', 'HARNESS_ADAPTERS.pi.mockBin = patched;', 'assigns an adapter mockBin'],
    ['a patcher import', "import { patchMockOnce } from './mock-patch.testkit.ts';", 'imports the mock source patcher'],
  ])('refuses %s', (_name, sample, rule) => {
    expect(mockSourceViolations('sample.ts', sample)).toEqual([`sample.ts:1 ${rule}`]);
  });

  it.each([
    ['a standalone fake', "writeFileSync(join(dir, 'mock.mjs'), '#!/usr/bin/env node\\nprocess.exit(0)');"],
    ['pointing the runner at the real mock', 'process.env[adapter.binEnv] = adapter.mockBin;'],
    ['a sample inside a literal', "const sample = \"readFileSync(adapter.mockBin, 'utf8'); import './mock-patch.testkit.ts'\";"],
    ['a comparison', 'expect(adapter.mockBin === other).toBe(true);'],
  ])('allows %s', (_name, sample) => {
    expect(mockSourceViolations('sample.ts', sample)).toEqual([]);
  });
});
