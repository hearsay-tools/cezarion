import { useTestHome } from './home/test-home.testkit.ts';
import { resolveHome } from './home/resolve.ts';
const testHome = (env: NodeJS.ProcessEnv = process.env) => resolveHome({ purpose: 'cli', env });
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

vi.mock('node:os', async (original) => {
  const os = await original<typeof import('node:os')>();
  return { ...os, userInfo: vi.fn(os.userInfo) };
});

// Fail closed: even a broken guard cannot write or remove a real file.
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, existsSync: vi.fn(fs.existsSync), realpathSync: vi.fn(fs.realpathSync), lstatSync: vi.fn(fs.lstatSync), mkdirSync: vi.fn(), writeFileSync: vi.fn(), renameSync: vi.fn(), chmodSync: vi.fn(), rmSync: vi.fn() };
});
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), writeFile: vi.fn(), rename: vi.fn(), rm: vi.fn() }));

import { existsSync, realpathSync, lstatSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { assertCezarHomeWriteIsSandboxed } from './paths.ts';
import { atomicWriteJsonSync } from './workspace/config.ts';
import { mergeWriteAgentAccounts } from './workspace/agent-accounts.ts';
import { enableRemoteSettings } from './remote-settings.ts';
import { saveServerState } from './server-install/state.ts';
import { installFromRegistry } from './self-update/installer.ts';
import { freshServerState } from './server-install/types.ts';

const realHome = join(userInfo().homedir, '.cezar');
afterEach(() => { vi.unstubAllEnvs(); vi.mocked(existsSync).mockRestore(); vi.mocked(realpathSync).mockRestore(); vi.mocked(lstatSync).mockRestore(); vi.mocked(userInfo).mockRestore(); vi.clearAllMocks(); });

describe('home write guard with HOME pinned to a sandbox', () => {
  it.each([['realpath', 'EACCES'], ['realpath', 'ELOOP'], ['lstat', 'EACCES']])('fails closed on %s lookup error %s', async (lookup, code) => {
    vi.resetModules();
    const { Home } = await import('./home/home.ts');
    vi.mocked(userInfo).mockReturnValue({ ...userInfo(), homedir: '/tmp/cez-guard-account' });
    vi.mocked(realpathSync).mockImplementation(() => { throw Object.assign(new Error('lookup refused'), { code: lookup === 'realpath' ? code : 'ENOENT' }); });
    vi.mocked(lstatSync).mockImplementation(() => { throw Object.assign(new Error('lookup refused'), { code }); });
    expect(() => Home.sandbox('/tmp/cez-guard-new-sandbox')).toThrow('refusing to write');
    for (const mutation of [mkdirSync, writeFileSync]) expect(mutation).not.toHaveBeenCalled();
  });

  it.each(['root', 'ancestor', 'missing descendant', 'dangling'])('blocks a symlinked %s before any filesystem mutation', async (kind) => {
    vi.resetModules();
    const { Home } = await import('./home/home.ts');
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const fixture = fs.mkdtempSync(join(tmpdir(), 'cez-guard-symlink-'));
    const account = join(fixture, 'account');
    const protectedHome = join(account, '.cezar');
    const alias = join(fixture, 'alias');
    vi.mocked(userInfo).mockReturnValue({ ...userInfo(), homedir: account });
    try {
      fs.mkdirSync(protectedHome, { recursive: true });
      const target = kind === 'ancestor' ? account : kind === 'root' ? protectedHome : join(protectedHome, 'missing');
      if (kind === 'dangling') fs.rmSync(protectedHome, { recursive: true });
      fs.symlinkSync(target, alias, 'dir');
      const destination = kind === 'ancestor' ? join(alias, '.cezar', 'missing', 'nested') : alias;
      expect(() => Home.sandbox(destination)).toThrow('refusing to write');
      for (const mutation of [mkdirSync, writeFileSync]) expect(mutation).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('allows a fresh sandbox beneath a symlinked temporary ancestor', async () => {
    vi.resetModules();
    const { Home } = await import('./home/home.ts');
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const fixture = fs.mkdtempSync(join(tmpdir(), 'cez-guard-symlink-'));
    vi.mocked(userInfo).mockReturnValue({ ...userInfo(), homedir: join(fixture, 'account') });
    try {
      fs.symlinkSync(fixture, join(fixture, 'alias'), 'dir');
      const destination = join(fixture, 'alias', 'fresh', 'sandbox');
      expect(Home.sandbox(destination).root).toBe(destination);
      expect(mkdirSync).toHaveBeenCalledWith(destination, { recursive: true, mode: 0o700 });
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it.each(['write', 'delete', 'lock'])('blocks a symlinked server-state %s before any filesystem mutation', async (operation) => {
    vi.resetModules();
    const state = await import('./server-install/state.ts');
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const fixture = fs.mkdtempSync(join(tmpdir(), 'cez-guard-state-symlink-'));
    const account = join(fixture, 'account');
    const alias = join(fixture, 'alias');
    vi.mocked(userInfo).mockReturnValue({ ...userInfo(), homedir: account });
    try {
      fs.mkdirSync(join(account, '.cezar'), { recursive: true });
      fs.symlinkSync(account, alias, 'dir');
      const home = testHome({ CEZ_HOME: join(alias, '.cezar') });
      expect(() => {
        if (operation === 'write') state.saveServerState(freshServerState(), 'named', home);
        else if (operation === 'delete') state.deleteServerState('named', home);
        else state.acquireLock('named', home);
      }).toThrow('refusing to write');
      for (const mutation of [mkdirSync, writeFileSync, renameSync, rmSync]) expect(mutation).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

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
    expect(realpathSync).not.toHaveBeenCalled();
    expect(lstatSync).not.toHaveBeenCalled();
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
