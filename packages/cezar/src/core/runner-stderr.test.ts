import { describe, expect, it } from 'vitest';
import { summarizeRunnerStderr } from './runner-stderr.ts';

describe('summarizeRunnerStderr', () => {
  it.each([
    ['', ''],
    ['  \nNode.js v24.20.0\n', ''],
    ['authentication unavailable\n', 'authentication unavailable'],
    ['\nfirst\n\nsecond\nthird\nfourth\nNode.js v24.20.0\n', 'second | third | fourth'],
    ['node:events:496\n  throw er;\n  ^\n\nError: write EPIPE\n    at write (file.js:1:2) {\n  errno: -32,\n  code: \'EPIPE\'\n}\n\nNode.js v24.20.0\n', 'Error: write EPIPE'],
    ['TypeError [ERR_INVALID_ARG_TYPE]: expected a string\n    at write (file.js:1:2)\nNode.js v24.20.0', 'TypeError [ERR_INVALID_ARG_TYPE]: expected a string'],
    ['\u001b[31mRangeError: overflow\u001b[0m\r\n\t at fn (file.js:1:1)\r\n\r\nNode.js v24.20.0\r\n', 'RangeError: overflow'],
    ['fatal error: runtime failed\n}\nNode.js v24.20.0\n', 'fatal error: runtime failed'],
  ])('summarizes %j', (stderr, expected) => {
    expect(summarizeRunnerStderr(stderr)).toBe(expected);
  });
  it('bounds a long actionable exception instead of keeping its tail', () => {
    const summary = summarizeRunnerStderr('Error: broken ' + 'x'.repeat(2000));
    expect(summary).toMatch(/^Error: broken /);
    expect(summary.length).toBeLessThanOrEqual(500);
    expect(summary.endsWith('…')).toBe(true);
  });
  it('retains the end of long plain diagnostics when there is no exception header', () => {
    const summary = summarizeRunnerStderr('x'.repeat(2000) + ' boom');
    expect(summary.length).toBeLessThanOrEqual(500);
    expect(summary.endsWith(' boom')).toBe(true);
  });

});
