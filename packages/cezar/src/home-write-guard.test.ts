import { useTestHome } from './home/test-home.testkit.ts';
import { resolveHome } from './home/resolve.ts';
const testHome = (env: NodeJS.ProcessEnv = process.env) => resolveHome({ purpose: 'cli', env });
import { afterEach, describe, expect, it, vi } from 'vitest';
import { userInfo } from 'node:os';
import { join } from 'node:path';

// Fail closed: even a broken guard cannot write or remove a real file.
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, existsSync: vi.fn(fs.existsSync), mkdirSync: vi.fn(), writeFileSync: vi.fn(), renameSync: vi.fn(), chmodSync: vi.fn(), rmSync: vi.fn() };
});
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), writeFile: vi.fn(), rename: vi.fn(), rm: vi.fn() }));

import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { assertCezarHomeWriteIsSandboxed } from './paths.ts';
import { atomicWriteJsonSync } from './workspace/config.ts';
import { mergeWriteAgentAccounts } from './workspace/agent-accounts.ts';
import { enableRemoteSettings } from './remote-settings.ts';
import { saveServerState } from './server-install/state.ts';
import { installFromRegistry } from './self-update/installer.ts';
import { freshServerState } from './server-install/types.ts';

const realHome = join(userInfo().homedir, '.cezar');
afterEach(() => { vi.unstubAllEnvs(); vi.mocked(existsSync).mockRestore(); vi.clearAllMocks(); });

describe('home write guard with HOME pinned to a sandbox', () => {
  it.each(['VITEST', 'NODE_TEST_CONTEXT', 'JEST_WORKER_ID', 'STRYKER_MUTATOR'])('blocks a real-home sandbox before any filesystem mutation under %s', async (runner) => {
    vi.resetModules();
    const { Home } = await import('./home/home.ts');
    for (const key of Object.keys(process.env)) {
      if (['VITEST', 'NODE_TEST_CONTEXT', 'JEST_WORKER_ID'].includes(key) || key.startsWith('STRYKER_')) vi.stubEnv(key, undefined);
    }
    vi.stubEnv(runner, '1');
    vi.stubEnv('HOME', '/tmp/cez-guard-sandbox');
    expect(() => Home.sandbox(realHome)).toThrow('refusing to write');
    for (const mutation of [mkdirSync, writeFileSync]) expect(mutation).not.toHaveBeenCalled();
  });

  it('allows sandbox creation outside test runners', async () => {
    vi.resetModules();
    const { Home } = await import('./home/home.ts');
    for (const key of Object.keys(process.env)) {
      if (['VITEST', 'NODE_TEST_CONTEXT', 'JEST_WORKER_ID'].includes(key) || key.startsWith('STRYKER_')) vi.stubEnv(key, undefined);
    }
    expect(Home.sandbox(realHome).root).toBe(realHome);
    expect(mkdirSync).toHaveBeenCalledWith(realHome, { recursive: true, mode: 0o700 });
    expect(writeFileSync).toHaveBeenCalledWith(join(realHome, 'install.json'), expect.any(String), { flag: 'wx', mode: 0o600 });
  });

  it.each(['atomic JSON', 'agent accounts', 'remote settings', 'server state'])('blocks %s before any filesystem mutation', async (writer) => {
    vi.stubEnv('HOME', '/tmp/cez-guard-sandbox');
    useTestHome(testHome({ CEZ_HOME: realHome }));
    const write = () => {
      if (writer === 'atomic JSON') return atomicWriteJsonSync(join(realHome, 'config.json'), {});
      if (writer === 'agent accounts') return mergeWriteAgentAccounts(() => {}, testHome());
      if (writer === 'remote settings') return enableRemoteSettings(4321, undefined, undefined, testHome());
      return saveServerState(freshServerState(), undefined, testHome());
    };
    await expect(async () => write()).rejects.toThrow('refusing to write');
    for (const mutation of [existsSync, mkdirSync, writeFileSync, renameSync, rmSync, mkdir, writeFile, rename]) {
      expect(mutation).not.toHaveBeenCalled();
    }
  });

  it('does not let a custom env without VITEST bypass the process guard', async () => {
    await expect(enableRemoteSettings(4321, { CEZ_HOME: realHome }, undefined, testHome({ CEZ_HOME: realHome }))).rejects.toThrow('refusing to write');
    expect(mkdir).not.toHaveBeenCalled();
    expect(() => assertCezarHomeWriteIsSandboxed(join(realHome, 'file'), {})).toThrow('refusing to write');
  });

  it.each(['NODE_TEST_CONTEXT', 'JEST_WORKER_ID', 'STRYKER_MUTATOR'])('recognizes %s in the process', (key) => {
    vi.stubEnv('VITEST', '');
    vi.stubEnv(key, '1');
    expect(() => assertCezarHomeWriteIsSandboxed(realHome, {})).toThrow('refusing to write');
  });

  it('allows a sandbox and a sibling path during a test', () => {
    expect(() => assertCezarHomeWriteIsSandboxed('/tmp/cez-guard-sandbox/file')).not.toThrow();
    expect(() => assertCezarHomeWriteIsSandboxed(`${realHome}-other/file`)).not.toThrow();
  });

  it('keeps a remote grant in its checked directory when env changes during mkdir', async () => {
    const env = { CEZ_HOME: '/tmp/cez-guard-sandbox' };
    vi.mocked(mkdir).mockImplementationOnce(async () => { env.CEZ_HOME = realHome; return undefined; });
    await enableRemoteSettings(4321, env, undefined, testHome(env));
    expect(rename).toHaveBeenCalledWith(expect.any(String), '/tmp/cez-guard-sandbox/remote-settings/4321.json');
  });

  it('checks the install destination again after npm changes the home', async () => {
    const env = { CEZ_HOME: '/tmp/cez-guard-sandbox' };
    vi.mocked(existsSync).mockImplementation((path) => String(path).includes('.staging-'));
    await expect(installFromRegistry('0.12.1', { home: { ...testHome(env), get versions() { return join(env.CEZ_HOME, 'versions'); } }, env, runNpm: async () => { env.CEZ_HOME = realHome; } }))
      .rejects.toThrow('refusing to write');
    expect(renameSync).not.toHaveBeenCalled();
    for (const [path] of vi.mocked(rmSync).mock.calls) expect(String(path)).not.toContain(realHome);
  });

  it('is a no-op outside test runners', () => {
    for (const key of Object.keys(process.env)) {
      if (['VITEST', 'NODE_TEST_CONTEXT', 'JEST_WORKER_ID'].includes(key) || key.startsWith('STRYKER_')) vi.stubEnv(key, undefined);
    }
    expect(() => assertCezarHomeWriteIsSandboxed(realHome, { VITEST: 'true' })).not.toThrow();
  });
});
