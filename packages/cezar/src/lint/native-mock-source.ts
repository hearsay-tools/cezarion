import { blankOnce, lineAt, type SourceRule } from './source-rule.ts';

/**
 * Tests run the real native mocks (hearsay-tools/cezarion#1479). A test that changes how a mock
 * behaves uses a mock-owned control (`CEZ_MOCK_FAILURE_CONTROL`, `CEZ_MOCK_DELIVERY_CONTROL`) or a
 * native scenario token; it never reads a mock's source to splice code into a copy, and never
 * points an adapter at such a copy. A mock edit near a spliced anchor broke CI (run 38825220194,
 * hearsay-tools/cezarion#1126). Standalone fakes a test writes from scratch stay allowed.
 */
const SCANNED = ['packages/cezar/src/', 'packages/cezar/test/'];
/** This module spells the refused shapes in its own patterns. */
const SELF = 'packages/cezar/src/lint/native-mock-source.ts';

const READ_CALL = /\breadFile(?:Sync)?\s*\(/g;
/** A mock script named by path, an adapter's `mockBin`, or a harness `*_MOCK` constant. */
const MOCK_SOURCE = /\bmockBin\b|\b[A-Z][A-Z_]*_MOCK\b|mock-[\w-]+\.mjs/;
const MOCKBIN_ASSIGNMENT = /\.mockBin\s*=(?![=>])/g;
const PATCHER_SPECIFIER = /(['"])[^'"\n]*mock-patch\.testkit(?:\.ts)?\1/g;

type MockRule = 'reads native mock source' | 'assigns an adapter mockBin' | 'imports the mock source patcher';

/** Every refused shape in one file's source. Strings and comments are blanked first, so a sample
 *  inside a literal or a comment is not a site. */
function mockSourceSites(source: string): Array<{ line: number; rule: MockRule }> {
  const code = blankOnce(source);
  const found: Array<{ line: number; rule: MockRule }> = [];
  for (const match of code.matchAll(READ_CALL)) {
    const open = match.index + match[0].length;
    let depth = 1, end = open;
    while (end < code.length && depth > 0) {
      if (code[end] === '(') depth++;
      else if (code[end] === ')') depth--;
      end++;
    }
    if (MOCK_SOURCE.test(source.slice(open, end))) found.push({ line: lineAt(source, match.index), rule: 'reads native mock source' });
  }
  for (const match of code.matchAll(MOCKBIN_ASSIGNMENT)) found.push({ line: lineAt(source, match.index), rule: 'assigns an adapter mockBin' });
  // A specifier is a string, so only its delimiters survive blanking: a match whose opening quote
  // is blanked sits inside another literal or a comment.
  for (const match of source.matchAll(PATCHER_SPECIFIER)) {
    if (code[match.index] === match[1]) found.push({ line: lineAt(source, match.index), rule: 'imports the mock source patcher' });
  }
  return found;
}

/** Every refused shape in one file, as `file:line rule`. */
export const mockSourceViolations = (file: string, source: string): string[] =>
  mockSourceSites(source).map(({ line, rule }) => `${file}:${line} ${rule}`);

export const nativeMockSource: SourceRule = {
  name: 'native-mock-source',
  description: 'Tests run the real native mocks; they never read, splice or swap mock source (hearsay-tools/cezarion#1479).',
  applies: (file) => SCANNED.some((dir) => file.startsWith(dir)) && file.endsWith('.ts') && !file.includes('/node_modules/') && file !== SELF,
  check: (_file, source) => mockSourceSites(source).map(({ line, rule }) => ({
    line,
    message: `Test ${rule}. Change a mock through its own control (CEZ_MOCK_FAILURE_CONTROL, CEZ_MOCK_DELIVERY_CONTROL) or a native scenario token, or write a standalone fake (hearsay-tools/cezarion#1479).`,
  })),
};
