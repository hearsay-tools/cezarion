import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Home } from '../home/home.ts';
import { BINARY_NAMES, productIdentity } from '../home/identity.ts';
import { installFromLocal, installFromRegistry } from './installer.ts';
import { activate, currentEntry, listInstalled, versionDir, versionEntry, writeManifest } from './layout.ts';
import { posixLauncher, windowsLauncher, writeLaunchers } from './launcher.ts';
import { SelfUpdateService } from './service.ts';
import { checkForUpdate } from '../update-check.ts';

const roots: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'managed-package-identity-')); roots.push(root);
  return Home.sandbox(root, { layout: 'legacy' });
}
function plant(home: Home, id: string, rebrand: boolean) {
  const entry = join(versionDir(id, {}, home), 'node_modules', productIdentity(rebrand).npmPackage, 'dist/index.js');
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, 'console.log(JSON.stringify({args:process.argv.slice(2)}));');
  writeManifest(id, { version: id, source: 'registry', installedAt: '2026-11-08T00:00:00Z' }, {}, home);
  return entry;
}

it.each([false, true])('switch %s: new registry installs use its scoped identity, legacy installs remain readable', async rebrand => {
  const home = sandbox();
  const old = plant(home, '1.0.0', false);
  const name = productIdentity(rebrand).npmPackage;
  const npm = vi.fn(async (args: string[]) => {
    expect(args.at(-1)).toBe(`${name}@2.0.0`);
    const entry = join(args[args.indexOf('--prefix') + 1]!, 'node_modules', name, 'dist/index.js');
    mkdirSync(dirname(entry), { recursive: true }); writeFileSync(entry, 'new');
  });
  const result = await installFromRegistry('2.0.0', { home, rebrand, runNpm: npm });
  expect(result.entry).toBe(join(versionDir('2.0.0', undefined, home), 'node_modules', name, 'dist/index.js'));
  expect(listInstalled({}, home, rebrand).map(x => x.id)).toEqual(['2.0.0', '1.0.0']);
  activate('2.0.0', {}, home, rebrand);
  expect(readFileSync(currentEntry({}, home, rebrand), 'utf8')).toBe('new');
  activate('1.0.0', {}, home, rebrand);
  expect(readFileSync(currentEntry({}, home, rebrand), 'utf8')).toBe(readFileSync(old, 'utf8'));
  await installFromRegistry('1.0.0', { home, rebrand, runNpm: npm });
  expect(npm).toHaveBeenCalledTimes(1);
});

it('prefers the active scoped tree; switch off ignores a new-only managed layout without failing', () => {
  const home = sandbox();
  const old = plant(home, '1.0.0', false), renamed = plant(home, '1.0.0', true);
  expect(versionEntry('1.0.0', {}, home, true)).toBe(renamed);
  expect(versionEntry('1.0.0', {}, home, false)).toBe(old);
  plant(home, '2.0.0', true);
  expect(listInstalled({}, home, false).map(x => x.id)).toEqual(['1.0.0']);
  expect(() => activate('2.0.0', {}, home, false)).toThrow('not installed');
});

it.each([false, true])('switch %s: failed staging keeps the previous managed version active', async rebrand => {
  const home = sandbox(); plant(home, '1.0.0', false); activate('1.0.0', {}, home);
  await expect(installFromRegistry('2.0.0', { home, rebrand, runNpm: async () => { throw new Error('offline'); } })).rejects.toThrow('offline');
  expect(existsSync(versionDir('2.0.0', {}, home))).toBe(false);
  expect(readFileSync(currentEntry({}, home, rebrand), 'utf8')).toContain('console.log');
});

it.each([false, true])('switch %s: local packs retain the source package identity', async rebrand => {
  const home = sandbox(); const source = join(home.root, 'source'); mkdirSync(source);
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: productIdentity(false).npmPackage, version: '1.0.0' }));
  await installFromLocal(source, { home, rebrand, runNpm: async args => {
    if (args[0] === 'pack') { writeFileSync(join(args[args.indexOf('--pack-destination') + 1]!, 'local.tgz'), 'fixture'); return; }
    const entry = join(args[args.indexOf('--prefix') + 1]!, 'node_modules', productIdentity(false).npmPackage, 'dist/index.js');
    mkdirSync(dirname(entry), { recursive: true }); writeFileSync(entry, 'local');
  } });
  expect(readFileSync(versionEntry('1.0.0+local', {}, home, rebrand), 'utf8')).toBe('local');
});

it.each([false, true])('switch %s: registry discovery uses its identity for a legacy running install', async rebrand => {
  const home = sandbox(); const entry = plant(home, '1.0.0', false);
  const fetch = vi.fn(async (_url: string | URL | Request) => Response.json({ 'dist-tags': { latest: '2.0.0' }, versions: { '2.0.0': {} }, version: '2.0.0' }));
  vi.stubGlobal('fetch', fetch);
  const service = new SelfUpdateService({ home, pkgName: productIdentity(false).npmPackage, version: '1.0.0', entry, restart: () => {}, rebrand });
  await service.status();
  expect(fetch.mock.calls[0]?.[0]).toContain(encodeURIComponent(productIdentity(rebrand).npmPackage.slice(1)));
  fetch.mockClear();
  await checkForUpdate(productIdentity(false).npmPackage, '1.0.0', rebrand);
  expect(fetch.mock.calls[0]?.[0]).toContain(encodeURIComponent(productIdentity(rebrand).npmPackage));
});

it('keeps switch-off launcher bytes equal to the accepted unit A baseline', () => {
  const golden = JSON.parse(readFileSync(new URL('../../test/fixtures/managed-launchers-off.json', import.meta.url), 'utf8')) as Record<string, { posix: string; windows: string }>;
  const home = sandbox();
  const normalize = (value: string) => value.replaceAll(home.root, '/fixture-home');
  for (const name of [undefined, ...BINARY_NAMES]) {
    expect(normalize(posixLauncher({}, home, name, false))).toBe(golden[name ?? 'unnamed']!.posix);
    expect(normalize(windowsLauncher({}, home, name, false)).replaceAll('\\', '/')).toBe(golden[name ?? 'unnamed']!.windows);
  }
});

it.skipIf(process.platform === 'win32')('one switch-on launcher starts new and legacy versions and uses the shell rollback escape hatch', () => {
  const home = sandbox(); plant(home, '1.0.0', false); plant(home, '2.0.0', true);
  const script = join(home.root, 'launcher'); writeFileSync(script, posixLauncher({}, home, 'hsq', true));
  expect(readFileSync(script, 'utf8')).toContain('# hsq managed install');
  for (const id of ['2.0.0', '1.0.0']) {
    execFileSync('/bin/sh', [script, 'use', id]);
    expect(JSON.parse(execFileSync('/bin/sh', [script, 'schema', 'literal $()'], { encoding: 'utf8' }))).toEqual({ args: ['schema', 'literal $()'] });
  }
});

it('switch-on Windows launchers select the active package with a legacy fallback', () => {
  const home = sandbox(); const text = windowsLauncher({}, home, 'hsq', true);
  expect(text).toContain(productIdentity(true).npmPackage.replaceAll('/', process.platform === 'win32' ? '\\' : '/'));
  expect(text).toContain('if not exist "%CEZ_ENTRY%"');
  expect(text).toContain('%CEZ_ENTRY:index.js=hsq.js%');
});

it.each([false, true])('switch %s: published local packs use their manifest identity only when enabled', async rebrand => {
  const home = sandbox(); const source = join(home.root, 'published'); mkdirSync(source);
  const name = productIdentity(true).npmPackage;
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name, version: '2.0.0' }));
  const npm = vi.fn(async (args: string[]) => {
    if (args[0] === 'pack') { writeFileSync(join(args[args.indexOf('--pack-destination') + 1]!, 'local.tgz'), 'fixture'); return; }
    const entry = join(args[args.indexOf('--prefix') + 1]!, 'node_modules', name, 'dist/index.js');
    mkdirSync(dirname(entry), { recursive: true }); writeFileSync(entry, 'published local');
  });
  const result = installFromLocal(source, { home, rebrand, runNpm: npm });
  if (!rebrand) { await expect(result).rejects.toThrow('not a built'); expect(npm).not.toHaveBeenCalled(); return; }
  expect(readFileSync((await result).entry, 'utf8')).toBe('published local');
});

it.each([false, true])('switch %s: managed apply restarts the selected version and can roll back to legacy', async rebrand => {
  vi.useFakeTimers();
  const home = sandbox(); const old = plant(home, '1.0.0', false); plant(home, '2.0.0', rebrand);
  activate('1.0.0', {}, home);
  const launcherDir = writeLaunchers({}, home, false);
  const launcherPath = join(launcherDir, process.platform === 'win32' ? 'hsq.cmd' : 'hsq');
  const originalLauncher = readFileSync(launcherPath, 'utf8');
  const restart = vi.fn();
  const service = new SelfUpdateService({ home, rebrand, pkgName: productIdentity(false).npmPackage, version: '1.0.0', entry: old, restart });
  const job = service.apply('2.0.0');
  await vi.advanceTimersByTimeAsync(750);
  expect(job.status).toBe('restarting');
  expect(restart).toHaveBeenCalledTimes(1);
  const updatedLauncher = readFileSync(launcherPath, 'utf8');
  if (rebrand) expect(updatedLauncher).toContain('# hsq managed install');
  else expect(updatedLauncher).toBe(originalLauncher);
  expect(readlinkSync(join(home.data, 'versions/current')).replaceAll('\\', '/')).toContain('2.0.0');
  const nextEntry = currentEntry({}, home, rebrand);
  expect(readFileSync(nextEntry, 'utf8')).toContain('console.log');
  // Restart creates a new updater with no in-flight job. It can select the legacy version.
  const previous = new SelfUpdateService({ home, rebrand, pkgName: productIdentity(false).npmPackage, version: '2.0.0', entry: nextEntry, restart });
  const rollback = previous.apply('1.0.0');
  await vi.advanceTimersByTimeAsync(750);
  expect(rollback.status).toBe('restarting');
  expect(restart).toHaveBeenCalledTimes(2);
  expect(readFileSync(currentEntry({}, home, rebrand), 'utf8')).toBe(readFileSync(old, 'utf8'));
  expect(readlinkSync(join(home.data, 'versions/current')).replaceAll('\\', '/')).toContain('1.0.0');
});
