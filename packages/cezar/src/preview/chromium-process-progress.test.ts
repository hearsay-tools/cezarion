import { afterEach, expect, it, vi } from 'vitest';
const { readFileSync } = vi.hoisted(() => ({ readFileSync: vi.fn() }));
vi.mock('node:fs', () => ({ readFileSync }));
import { chromiumProcessProgress } from './chromium-launch-progress.ts';
afterEach(() => vi.resetAllMocks());

it.skipIf(process.platform !== 'linux')('reads fault and CPU counters after a comm containing spaces and parentheses', () => {
  readFileSync.mockReturnValue('123 (chrome (renderer)) S 1 2 3 4 5 6 7 8 9 10 11 12 13');
  expect(chromiumProcessProgress(123)).toBe('7:9:11:12');
  expect(readFileSync).toHaveBeenCalledWith('/proc/123/stat', 'utf8');
});
it('falls back when procfs cannot be read', () => {
  readFileSync.mockImplementation(() => { throw new Error('unavailable'); });
  expect(chromiumProcessProgress(123)).toBeUndefined();
});
it('ignores truncated or malformed counters', () => {
  readFileSync.mockReturnValue('123 (chrome) S 1');
  expect(chromiumProcessProgress(123)).toBeUndefined();
});
