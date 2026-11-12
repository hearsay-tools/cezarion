import { REBRAND_SWITCH } from './home/switch.ts';
import { resolveHome } from './home/resolve.ts'; // test-home-read: import for the annotated sandbox and refusal probes
import { randomUUID } from 'node:crypto';
const testHome = (env: NodeJS.ProcessEnv = process.env) => resolveHome({ purpose: 'cli', env }); // test-home-read: resolve refusal inputs; fixture blocks unowned mutations
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const mutationScope = vi.hoisted(() => ({ root: undefined as string | undefined, active: false }));
vi.hoisted(() => vi.resetModules());

vi.mock('node:os', async (original) => {
  const os = await original<typeof import('node:os')>();
  return { ...os, userInfo: vi.fn(os.userInfo) };
});

// Fail closed: even a broken guard cannot write or remove a real file.
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const check = (path?: unknown) => {
    if (!mutationScope.active) return;
    if (!mutationScope.root) throw new Error('Test filesystem mutation was not authorized');
    const target = path instanceof URL ? fileURLToPath(path) : Buffer.isBuffer(path) ? path.toString() : path;
    if (typeof target === 'string' && target !== mutationScope.root && !resolve(target).startsWith(resolve(mutationScope.root) + sep)) throw new Error('Test filesystem mutation escaped its fixture');
  };
  return { ...fs, existsSync: vi.fn(fs.existsSync), realpathSync: vi.fn(fs.realpathSync), lstatSync: vi.fn(fs.lstatSync),
    mkdirSync: vi.fn((...args: Parameters<typeof fs.mkdirSync>) => { check(args[0]); return fs.mkdirSync(...args); }),
    openSync: vi.fn((...args: Parameters<typeof fs.openSync>) => { check(args[0]); return fs.openSync(...args); }),
    writeFileSync: vi.fn((...args: Parameters<typeof fs.writeFileSync>) => { check(args[0]); return fs.writeFileSync(...args); }),
    renameSync: vi.fn((...args: Parameters<typeof fs.renameSync>) => { check(args[0]); check(args[1]); return fs.renameSync(...args); }),
    chmodSync: vi.fn((...args: Parameters<typeof fs.chmodSync>) => { check(args[0]); return fs.chmodSync(...args); }),
    linkSync: vi.fn((...args: Parameters<typeof fs.linkSync>) => { check(args[0]); check(args[1]); return fs.linkSync(...args); }),
    unlinkSync: vi.fn((...args: Parameters<typeof fs.unlinkSync>) => { check(args[0]); return fs.unlinkSync(...args); }),
    rmSync: vi.fn((...args: Parameters<typeof fs.rmSync>) => { check(args[0]); return fs.rmSync(...args); }),
    fsyncSync: vi.fn((...args: Parameters<typeof fs.fsyncSync>) => { check(); return fs.fsyncSync(...args); }),
  };
});
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), writeFile: vi.fn(), rename: vi.fn(), rm: vi.fn() }));

import { existsSync, realpathSync, lstatSync, mkdirSync, openSync, fsyncSync, chmodSync, linkSync, unlinkSync, writeFileSync, renameSync, rmSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { assertCezarHomeWriteIsSandboxed } from './paths.ts';
import { atomicWriteJsonSync } from './workspace/config.ts';
import { mergeWriteAgentAccounts } from './workspace/agent-accounts.ts';
import { disableRemoteSettings, enableRemoteSettings } from './remote-settings.ts';
import { acquireLock, saveServerState } from './server-install/state.ts';
import { freshServerState } from './server-install/types.ts';

const realHome = join(userInfo().homedir, '.cezar'); // test-home-read: refusal target; fixture rejects unowned mutations
const mutations = [mkdirSync, openSync, writeFileSync, fsyncSync, renameSync, chmodSync, linkSync, unlinkSync, rmSync];
beforeEach(() => { mutationScope.active = true; });
afterEach(() => { mutationScope.active = false; mutationScope.root = undefined; vi.unstubAllEnvs(); vi.mocked(existsSync).mockRestore(); vi.mocked(realpathSync).mockRestore(); vi.mocked(lstatSync).mockRestore(); vi.mocked(userInfo).mockRestore(); vi.clearAllMocks(); });

describe('home write guard with HOME pinned to a sandbox', () => {
  it.each(['Buffer', 'URL'])('rejects a %s path outside the authorized fixture', async kind => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const fixture = fs.mkdtempSync(join(tmpdir(), 'cez-guard-path-'));
    const target = join(fixture, 'outside.json');
    mutationScope.root = join(fixture, 'allowed');
    try {
      expect(() => writeFileSync(kind === 'URL' ? pathToFileURL(target) : Buffer.from(target), '{}')).toThrow('escaped its fixture');
      expect(fs.existsSync(target)).toBe(false);
    } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
  });

  it.each([['realpath', 'EACCES'], ['realpath', 'ELOOP'], ['lstat', 'EACCES']])('fails closed on %s lookup error %s', async (lookup, code) => {
    vi.resetModules();
    const { Home } = await import('./home/home.ts');
    vi.mocked(userInfo).mockReturnValue({ ...userInfo(), homedir: '/tmp/cez-guard-account' });
    vi.mocked(realpathSync).mockImplementation(() => { throw Object.assign(new Error('lookup refused'), { code: lookup === 'realpath' ? code : 'ENOENT' }); });
    vi.mocked(lstatSync).mockImplementation(() => { throw Object.assign(new Error('lookup refused'), { code }); });
    expect(() => Home.sandbox('/tmp/cez-guard-new-sandbox')).toThrow('refusing to write');
    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
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
      for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
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
      mutationScope.root = fixture;
      expect(Home.sandbox(destination).root).toBe(REBRAND_SWITCH ? join(destination, 'config') : destination);
      expect(mkdirSync).toHaveBeenCalledWith(REBRAND_SWITCH ? join(destination, 'config') : destination, { recursive: true, mode: 0o700 });
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('blocks the first real-home write when the passwd-home parent is a symlink', async () => {
    vi.resetModules();
    const { Home } = await import('./home/home.ts');
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const fixture = fs.mkdtempSync(join(tmpdir(), 'cez-guard-passwd-symlink-'));
    const account = join(fixture, 'account');
    try {
      fs.mkdirSync(account);
      fs.symlinkSync(fixture, join(fixture, 'alias'), 'dir');
      vi.mocked(userInfo).mockReturnValue({ ...userInfo(), homedir: join(fixture, 'alias', 'account') });
      expect(() => Home.sandbox(join(account, '.cezar', 'first-write'))).toThrow('refusing to write');
      for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
      expect(fs.existsSync(join(account, '.cezar'))).toBe(false);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('allows unrelated sandbox writes when the protected home has a dangling ancestor', async () => {
    vi.resetModules();
    const { Home } = await import('./home/home.ts');
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const fixture = fs.mkdtempSync(join(tmpdir(), 'cez-guard-passwd-dangling-'));
    try {
      fs.symlinkSync(join(fixture, 'missing'), join(fixture, 'account'), 'dir');
      vi.mocked(userInfo).mockReturnValue({ ...userInfo(), homedir: join(fixture, 'account') });
      const destination = join(fixture, 'sandbox');
      mutationScope.root = fixture;
      expect(Home.sandbox(destination).root).toBe(REBRAND_SWITCH ? join(destination, 'config') : destination);
      expect(mkdirSync).toHaveBeenCalledWith(REBRAND_SWITCH ? join(destination, 'config') : destination, { recursive: true, mode: 0o700 });
      expect(() => Home.sandbox(join(fixture, 'account', '.cezar'))).toThrow('refusing to write');
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
      for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it.each(['write', 'replace', 'restore', 'install lock', 'remote disable'])('checks a nested protected path before creating even a sandbox lock for %s', async operation => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const { Home } = await import('./home/home.ts');
    const { HomeStore } = await import('./home/store.ts');
    const fixture = fs.mkdtempSync(join(tmpdir(), 'cez-guard-nested-'));
    vi.mocked(userInfo).mockReturnValue({ ...userInfo(), homedir: join(fixture, 'account') });
    mutationScope.root = fixture;
    try {
      const home = Home.sandbox(join(fixture, 'sandbox'));
      const protectedHome = join(fixture, 'account', '.cezar');
      fs.mkdirSync(protectedHome, { recursive: true });
      fs.mkdirSync(home.state, { recursive: true });
      fs.symlinkSync(protectedHome, home.serverInstances, 'dir');
      fs.symlinkSync(protectedHome, home.remoteSettings, 'dir');
      const path = home.serverState('named');
      const store = new HomeStore(home);
      vi.clearAllMocks();
      mutationScope.root = undefined;
      await expect(async () => {
        if (operation === 'write') store.writeJson(path, {});
        else if (operation === 'replace') store.replace(path, Buffer.from('{}'));
        else if (operation === 'install lock') acquireLock('named', home);
        else if (operation === 'remote disable') await disableRemoteSettings({}, undefined, home);
        else store.restoreOutsideWrite(path);
      }).rejects.toThrow('refusing to write');
      for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
    } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
  });

  it.each(['test', 'dev'])('does not journal reads of a passwd home with a %s marker', async kind => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const { readHomeFile } = await import('./home/store.ts');
    const fixture = fs.mkdtempSync(join(tmpdir(), 'cez-guard-read-'));
    vi.mocked(userInfo).mockReturnValue({ ...userInfo(), homedir: fixture });
    const root = join(fixture, '.cezar');
    try {
      fs.mkdirSync(root);
      fs.writeFileSync(join(root, 'install.json'), JSON.stringify({ installId: randomUUID(), kind, createdAt: new Date().toISOString() }));
      fs.writeFileSync(join(root, 'config.json'), '{"saved":true}');
      expect(JSON.parse(readHomeFile(join(root, 'config.json')))).toEqual({ saved: true });
      for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
    } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
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
    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
  });

  it('allows sandbox creation outside test runners', async () => {
    vi.resetModules();
    const { Home } = await import('./home/home.ts');
    for (const key of Object.keys(process.env)) {
      if (['VITEST', 'NODE_TEST_CONTEXT', 'JEST_WORKER_ID'].includes(key) || key.startsWith('STRYKER_')) vi.stubEnv(key, undefined);
    }
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const fixture = fs.mkdtempSync(join(tmpdir(), 'cez-guard-no-runner-'));
    mutationScope.root = fixture;
    try {
      expect(Home.sandbox(fixture).root).toBe(REBRAND_SWITCH ? join(fixture, 'config') : fixture);
      expect(JSON.parse(readFileSync(join(Home.sandbox(fixture).config, 'install.json'), 'utf8')).kind).toBe('test');
    } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
  });

  it.each(['atomic JSON', 'agent accounts', 'remote settings', 'server state'])('blocks %s before any filesystem mutation', async (writer) => {
    vi.stubEnv('HOME', '/tmp/cez-guard-sandbox');
    const home = testHome({ CEZ_HOME: realHome });
    const write = () => {
      if (writer === 'atomic JSON') return atomicWriteJsonSync(join(realHome, 'config.json'), {});
      if (writer === 'agent accounts') return mergeWriteAgentAccounts(() => {}, home);
      if (writer === 'remote settings') return enableRemoteSettings(4321, undefined, undefined, home);
      return saveServerState(freshServerState(), undefined, home);
    };
    await expect(async () => write()).rejects.toThrow('refusing to write');
    for (const mutation of [existsSync, ...mutations, mkdir, writeFile, rename]) {
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
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const { Home } = await import('./home/home.ts');
    const fixture = fs.mkdtempSync(join(tmpdir(), 'cez-guard-remote-'));
    mutationScope.root = fixture;
    try {
      const env = { CEZ_HOME: fixture };
      const home = Home.sandbox(fixture);
      vi.mocked(mkdirSync).mockImplementationOnce((path, options) => { env.CEZ_HOME = realHome; return fs.mkdirSync(path, options); });
      await enableRemoteSettings(4321, env, undefined, home);
      expect(JSON.parse(readFileSync(join(home.remoteSettings, '4321.json'), 'utf8'))).toHaveProperty('enabledAt');
      for (const [path] of vi.mocked(renameSync).mock.calls) expect(String(path)).not.toContain(realHome);
    } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
  });

  it('is a no-op outside test runners', () => {
    for (const key of Object.keys(process.env)) {
      if (['VITEST', 'NODE_TEST_CONTEXT', 'JEST_WORKER_ID'].includes(key) || key.startsWith('STRYKER_')) vi.stubEnv(key, undefined);
    }
    expect(() => assertCezarHomeWriteIsSandboxed(realHome, { VITEST: 'true' })).not.toThrow();
  });
});

// Literal native-platform defaults; no writes or directory creation even if the guard regresses.
it('refuses every split default kind root and descendant from the account home', () => {
  const account = join(tmpdir(), 'cez-split-guard-account');
  vi.mocked(userInfo).mockReturnValue({ ...userInfo(), homedir: account });
  const roots = process.platform === 'win32'
    ? [join(account, 'AppData', 'Roaming', 'Hearsay Squawk'), ...['state', 'data', 'cache', 'run'].map(kind => join(account, 'AppData', 'Local', 'Hearsay Squawk', kind))]
    : process.platform === 'darwin'
      ? [...['config', 'state', 'data'].map(kind => join(account, 'Library', 'Application Support', 'Hearsay Squawk', kind)),
        join(account, 'Library', 'Caches', 'Hearsay Squawk'), join(process.env.TMPDIR || '/tmp', 'hearsay-squawk')]
      : [join(account, '.config', 'hearsay-squawk'), join(account, '.local', 'state', 'hearsay-squawk'),
        join(account, '.local', 'share', 'hearsay-squawk'), join(account, '.cache', 'hearsay-squawk'),
        join(account, '.local', 'state', 'hearsay-squawk', 'run')];
  for (const root of roots) {
    expect(() => assertCezarHomeWriteIsSandboxed(root, {})).toThrow('refusing to write');
    expect(() => assertCezarHomeWriteIsSandboxed(join(root, 'nested', 'file.json'), {})).toThrow('refusing to write');
    if (!root.endsWith(sep + 'run')) expect(() => assertCezarHomeWriteIsSandboxed(root + '-sandbox', {})).not.toThrow();
  }
  for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
});
