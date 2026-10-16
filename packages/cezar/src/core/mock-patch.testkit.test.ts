import { describe, expect, it } from 'vitest';
import { patchMockOnce } from './mock-patch.testkit.ts';

describe('patchMockOnce', () => {
  const mockBin = '/repo/packages/cezar/scripts/mock-omp-rpc.mjs';
  const anchor = 'async function prompt(command) {\n  const message = command.message;\n';

  it('names the patcher, the mock and the anchor when the anchor is missing', () => {
    expect(() => patchMockOnce('owned-input-delivery.testkit.ts', mockBin, 'function other() {}\n', anchor, 'x')).toThrow(new Error(
      'owned-input-delivery.testkit.ts: anchor not found exactly once in mock-omp-rpc.mjs (found 0): "async function prompt(command) {\\n  const message = command.message;\\n"'));
  });

  it('counts a duplicated anchor', () => {
    expect(() => patchMockOnce('some.testkit.ts', mockBin, `${anchor}// x\n${anchor}`, anchor, 'x')).toThrow(new Error(
      'some.testkit.ts: anchor not found exactly once in mock-omp-rpc.mjs (found 2): "async function prompt(command) {\\n  const message = command.message;\\n"'));
  });

  it('replaces the one occurrence literally', () => {
    const source = `head\n${anchor}tail\n`;
    expect(patchMockOnce('some.testkit.ts', mockBin, source, anchor, "send('$&', '$$', '$1');")).toBe("head\nsend('$&', '$$', '$1');tail\n");
    expect(patchMockOnce('some.testkit.ts', mockBin, source, anchor, found => `${found}  gate('$&');\n`)).toBe(`head\n${anchor}  gate('$&');\ntail\n`);
  });
});
