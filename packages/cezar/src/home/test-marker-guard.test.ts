import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Home } from './home.ts';
import { createInstallMarker, readInstallMarker, underTestRunner } from './install-marker.ts';
import { accountProtectedRoots, protectedRootsFor } from './protected-roots.ts';

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

it('switch-on migration from a legacy test marker to an absent target writes a live marker in a plain process', async () => {
  vi.resetModules();
  vi.doMock('./switch.ts', () => ({ REBRAND_SWITCH: true }));
  try {
    const { prepareOperatorHome } = await import('./entry.ts');
    const switched = await import('./home.ts');
    const { nativePathPlatform, oneRootKinds } = await import('./kind-roots.ts');
    const markers = await import('./install-marker.ts');
    const legacy = switched.Home.sandbox(join(fixture, 'legacy'), { layout: 'legacy' });
    switched.Home.seed(legacy, legacy.workspaceConfig, { projects: [] });
    const targetRoot = join(fixture, 'new');
    const target = switched.kindHomePaths(oneRootKinds(targetRoot, nativePathPlatform), 'split', nativePathPlatform, targetRoot);
    expect(markers.readInstallMarker(legacy.root)?.kind).toBe('test');
    expect(existsSync(targetRoot)).toBe(false);
    expect(prepareOperatorHome(target, 'projects', { HOME: fixture, SHELL: '/bin/bash' }, { legacy })).toBe(target);
    expect(markers.readInstallMarker(target.config)).toMatchObject({ kind: 'live', state: 'committed' });
  } finally { vi.doUnmock('./switch.ts'); vi.resetModules(); }
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
