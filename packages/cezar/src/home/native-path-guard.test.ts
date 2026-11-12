import { realpathSync } from 'node:fs';
import { tmpdir, type } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { assertSquawkHomeWriteIsSandboxed } from '../paths.ts';

const account = join(tmpdir(), 'cez-native-guard-account');
vi.mock('node:os', async original => {
  const os = await original<typeof import('node:os')>();
  return { ...os, userInfo: () => ({ ...os.userInfo(), homedir: account }) };
});
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  // This guard probe never accesses the real account home, including on regression.
  return { ...fs, realpathSync: vi.fn(path => String(path)) };
});
afterEach(() => { vi.clearAllMocks(); });

it('keeps protected filesystem lookups native when process.platform is mocked', () => {
  const platform = process.platform;
  Object.defineProperty(process, 'platform', { configurable: true, value: sep === '\\' ? 'linux' : 'win32' });
  try {
    expect(() => assertSquawkHomeWriteIsSandboxed(join(tmpdir(), 'cez-native-guard-sandbox', 'config.json'))).not.toThrow();
    const lookedUp = vi.mocked(realpathSync).mock.calls.map(([path]) => String(path));
    const config = sep === '\\' ? join(account, 'AppData', 'Roaming', 'Hearsay Squawk')
      : type() === 'Darwin' ? join(account, 'Library', 'Application Support', 'Hearsay Squawk', 'config')
        : join(account, '.config', 'hearsay-squawk');
    expect(lookedUp).toContain(config);
    expect(lookedUp.every(path => !path.includes(sep === '\\' ? '/' : '\\'))).toBe(true);
  } finally { Object.defineProperty(process, 'platform', { configurable: true, value: platform }); }
});
