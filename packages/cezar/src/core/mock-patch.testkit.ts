import { basename } from 'node:path';

/** Replace the one literal `anchor` in a mock script's `source`, or throw an
 * error naming the patcher, the mock and the anchor. A bare
 * `expect(source.split(anchor)).toHaveLength(2)` named neither when a mock
 * edit moved an anchor (CI run 38825220194, #1126). The replacement is
 * inserted verbatim: `$&`, `$1` and `$$` are never read as replace patterns. */
export function patchMockOnce(
  patcher: string,
  mockBin: string,
  source: string,
  anchor: string,
  replacement: string | ((anchor: string) => string),
): string {
  const found = source.split(anchor).length - 1;
  if (found !== 1) throw new Error(`${patcher}: anchor not found exactly once in ${basename(mockBin)} (found ${found}): ${JSON.stringify(anchor)}`);
  const at = source.indexOf(anchor);
  return source.slice(0, at) + (typeof replacement === 'string' ? replacement : replacement(anchor)) + source.slice(at + anchor.length);
}
