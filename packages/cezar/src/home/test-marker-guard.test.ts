import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prepareOperatorHome } from './entry.ts';
import { Home, kindHomePaths } from './home.ts';
import { nativePathPlatform, oneRootKinds } from './kind-roots.ts';
import { createInstallMarker, readInstallMarker, underTestRunner } from './install-marker.ts';
import { accountProtectedRoots, insideRoot, protectedRootsFor } from './protected-roots.ts';

// The simulated account home lives in a temp directory: no probe can reach the real one.
const account = vi.hoisted(() => ({ home: '' }));
vi.hoisted(() => vi.resetModules());
vi.mock('node:os', async original => {
  const os = await original<typeof import('node:os')>();
  return { ...os, userInfo: () => ({ ...os.userInfo(), homedir: account.home }) };
});

let fixture = '';
beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'cez-test-marker-guard-'));
  account.home = join(fixture, 'account');
  mkdirSync(account.home);
  // Fail closed: never run a probe against the real account home.
  if (userInfo().homedir !== account.home || accountProtectedRoots()[0] !== join(account.home, '.cezar')) throw new Error('the account home mock is not active'); // test-home-read: compares the mocked account home; no write
  // A plain Node process: benchmark scripts and manual calls carry no test-runner variable.
  for (const key of Object.keys(process.env)) {
    if (['VITEST', 'NODE_TEST_CONTEXT', 'JEST_WORKER_ID'].includes(key) || key.startsWith('STRYKER_')) vi.stubEnv(key, undefined);
  }
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(fixture, { recursive: true, force: true }); });

const refusal = /refusing to write a test install marker/;
const legacyRoot = () => join(account.home, '.cezar');

it('a plain process refuses a test marker at every account root, in both layouts', () => {
  expect(underTestRunner()).toBe(false);
  expect(accountProtectedRoots()).toContain(legacyRoot());
  for (const root of accountProtectedRoots()) {
    expect(() => Home.sandbox(root, { layout: 'legacy' })).toThrow(refusal);
    expect(() => Home.sandbox(root, { layout: 'split' })).toThrow(refusal);
    expect(() => createInstallMarker(root, 'test')).toThrow(refusal);
    expect(() => createInstallMarker(join(root, 'nested'), 'test')).toThrow(refusal);
    if (root.startsWith(account.home)) expect(existsSync(root)).toBe(false);
  }
});

it('refuses before it returns an existing test marker on an account root', () => {
  const marker = JSON.stringify({ installId: '00000000-0000-4000-8000-000000000000', kind: 'test', createdAt: '2026-11-07T17:07:50.000Z' });
  mkdirSync(legacyRoot());
  writeFileSync(join(legacyRoot(), 'install.json'), marker);
  expect(() => Home.sandbox(legacyRoot(), { layout: 'legacy' })).toThrow(refusal);
  expect(() => createInstallMarker(legacyRoot(), 'test')).toThrow(refusal);
  // Prevention only: the wrong marker stays as it was.
  expect(readFileSync(join(legacyRoot(), 'install.json'), 'utf8')).toBe(marker);
});

it('refuses a symlink alias of an account root or of the account home', () => {
  mkdirSync(legacyRoot());
  symlinkSync(legacyRoot(), join(fixture, 'alias'), 'dir');
  symlinkSync(account.home, join(fixture, 'account-alias'), 'dir');
  expect(() => Home.sandbox(join(fixture, 'alias'))).toThrow(refusal);
  expect(() => createInstallMarker(join(fixture, 'alias'), 'test')).toThrow(refusal);
  expect(() => Home.sandbox(join(fixture, 'account-alias', '.cezar'))).toThrow(refusal);
  expect(existsSync(join(legacyRoot(), 'install.json'))).toBe(false);
});

it('a plain process still builds a temp sandbox with a test marker', () => {
  const sandbox = join(fixture, 'sandbox');
  const home = Home.sandbox(sandbox);
  expect(readInstallMarker(home.root)?.kind).toBe('test');
  expect(readInstallMarker(Home.sandbox(sandbox).root)).toEqual(readInstallMarker(home.root));
});

it('keeps live and dev marker creation at an account root unchanged outside test runners', () => {
  expect(createInstallMarker(legacyRoot(), 'live').kind).toBe('live');
  const dev = accountProtectedRoots().find(root => root !== legacyRoot())!;
  expect(createInstallMarker(dev, 'dev').kind).toBe('dev');
});

it('migration from a legacy test marker to an absent target writes a live marker in a plain process', () => {
  const legacy = Home.sandbox(join(fixture, 'legacy'), { layout: 'legacy' });
  Home.seed(legacy, legacy.workspaceConfig, { projects: [] });
  const targetRoot = join(fixture, 'new');
  const target = kindHomePaths(oneRootKinds(targetRoot, nativePathPlatform), 'split', nativePathPlatform, targetRoot);
  expect(readInstallMarker(legacy.root)?.kind).toBe('test');
  expect(existsSync(targetRoot)).toBe(false);
  expect(prepareOperatorHome(target, 'projects', { HOME: fixture, SHELL: '/bin/bash' }, { legacy })).toBe(target);
  expect(readInstallMarker(target.config)).toMatchObject({ kind: 'live', state: 'committed' });
});

it('the before-build marker script keeps the same account roots as the product guard', async () => {
  const script = await import('../../../../scripts/test-install-marker.mjs');
  expect(script.accountProtectedRoots()).toEqual(accountProtectedRoots());
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    for (const env of [{}, { TMPDIR: '/var/folders/x/T' }]) {
      const accountHome = platform === 'win32' ? 'C:\\Users\\someone' : '/home/someone';
      expect(script.protectedRootsFor(accountHome, env, platform)).toEqual(protectedRootsFor(accountHome, env, platform));
    }
  }
});

it('compares an account root without case on Windows and macOS, in the product and the script', async () => {
  const script = await import('../../../../scripts/test-install-marker.mjs');
  const cases: Array<[NodeJS.Platform, string, string, boolean]> = [
    ['linux', '/home/a/.CEZAR', '/home/a/.cezar', false],
    ['linux', '/home/a/.cezar/x', '/home/a/.cezar', true],
    ['darwin', '/Users/a/.CEZAR', '/Users/a/.cezar', true],
    ['darwin', '/Users/a/Library/Caches/HEARSAY SQUAWK/x', '/Users/a/Library/Caches/Hearsay Squawk', true],
    ['darwin', '/Users/a/.cezar-other', '/Users/a/.cezar', false],
    ['win32', 'C:\\Users\\A\\.CEZAR\\install.json', 'C:\\Users\\a\\.cezar', true],
    ['win32', 'C:\\Users\\a\\.cezarx', 'C:\\Users\\a\\.cezar', false],
    ['linux', '/anything', '/', true],
  ];
  for (const [platform, destination, root, inside] of cases) {
    expect(insideRoot(destination, root, platform), `${platform} ${destination}`).toBe(inside);
    expect(script.insideRoot(destination, root, platform), `script ${platform} ${destination}`).toBe(inside);
  }
});

it('refuses an absent account root spelled in another case on a case-insensitive platform', async () => {
  vi.resetModules();
  vi.doMock('./kind-roots.ts', async original => ({ ...await original<typeof import('./kind-roots.ts')>(), nativePathPlatform: 'darwin' }));
  try {
    const darwin = await import('./home.ts');
    const markers = await import('./install-marker.ts');
    const upper = join(account.home, '.CEZAR');
    expect(() => darwin.Home.sandbox(upper, { layout: 'legacy' })).toThrow(refusal);
    expect(() => markers.createInstallMarker(upper, 'test')).toThrow(refusal);
    expect(() => darwin.Home.sandbox(join(account.home, 'Library', 'Caches', 'HEARSAY SQUAWK'))).toThrow(refusal);
    expect(existsSync(upper)).toBe(false);
  } finally { vi.doUnmock('./kind-roots.ts'); vi.resetModules(); }
});

it.each([['an empty', ''], ['a relative', 'relative-home']])('fails closed when the OS gives %s account home', (_kind, home) => {
  account.home = home;
  const sandbox = join(fixture, 'sandbox');
  expect(() => accountProtectedRoots()).toThrow('no absolute account home');
  expect(() => Home.sandbox(sandbox)).toThrow(refusal);
  expect(() => createInstallMarker(sandbox, 'test')).toThrow(refusal);
  expect(existsSync(sandbox)).toBe(false);
});
