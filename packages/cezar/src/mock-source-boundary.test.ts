import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blank } from './test-wait-discipline.testkit.ts';

/**
 * Tests run the real native mocks (hearsay-tools/cezarion#1479). A test that changes how a mock
 * behaves uses a mock-owned control (`CEZ_MOCK_FAILURE_CONTROL`, `CEZ_MOCK_DELIVERY_CONTROL`) or a
 * native scenario token; it never reads a mock's source to splice code into a copy, and never
 * points an adapter at such a copy. A mock edit near a spliced anchor broke CI (run 38825220194,
 * hearsay-tools/cezarion#1126). Standalone fakes a test writes from scratch stay allowed.
 */
const pkg = join(import.meta.dirname, '..');
const SCANNED = ['src', 'test'];
const SELF = 'src/mock-source-boundary.test.ts';

const READ_CALL = /\breadFile(?:Sync)?\s*\(/g;
/** A mock script named by path, an adapter's `mockBin`, or a harness `*_MOCK` constant. */
const MOCK_SOURCE = /\bmockBin\b|\b[A-Z][A-Z_]*_MOCK\b|mock-[\w-]+\.mjs/;
const MOCKBIN_ASSIGNMENT = /\.mockBin\s*=(?![=>])/g;
const PATCHER_SPECIFIER = /(['"])[^'"\n]*mock-patch\.testkit(?:\.ts)?\1/g;

/** Every refused shape in one file's source, as `file:line rule`. Strings and comments are
 *  blanked first, so a sample inside a literal or a comment is not a site. */
function mockSourceViolations(file: string, source: string): string[] {
  const code = blank(source);
  const line = (offset: number) => source.slice(0, offset).split('\n').length;
  const found: string[] = [];
  for (const match of code.matchAll(READ_CALL)) {
    const open = match.index + match[0].length;
    let depth = 1, end = open;
    while (end < code.length && depth > 0) {
      if (code[end] === '(') depth++;
      else if (code[end] === ')') depth--;
      end++;
    }
    if (MOCK_SOURCE.test(source.slice(open, end))) found.push(`${file}:${line(match.index)} reads native mock source`);
  }
  for (const match of code.matchAll(MOCKBIN_ASSIGNMENT)) found.push(`${file}:${line(match.index)} assigns an adapter mockBin`);
  // A specifier is a string, so only its delimiters survive blanking: a match whose opening quote
  // is blanked sits inside another literal or a comment.
  for (const match of source.matchAll(PATCHER_SPECIFIER)) {
    if (code[match.index] === match[1]) found.push(`${file}:${line(match.index)} imports the mock source patcher`);
  }
  return found;
}

function scannedFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : scannedFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

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

  it('finds no test that reads or swaps native mock source', () => {
    const violations = SCANNED.flatMap(dir => scannedFiles(join(pkg, dir)))
      .filter(path => relative(pkg, path) !== SELF)
      .flatMap(path => mockSourceViolations(relative(pkg, path), readFileSync(path, 'utf8')));
    expect(violations).toEqual([]);
  });
});
