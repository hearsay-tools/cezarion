import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Home } from '../home/home.ts';
import { productIdentity } from '../home/identity.ts';
import { runSelfUpdateCommand } from './cli.ts';
import * as installer from './installer.ts';
import { activate, activeId, currentEntry, versionDir, writeManifest } from './layout.ts';
import { writeLaunchers } from './launcher.ts';
import { RegistryCache } from './registry.ts';
import { SelfUpdateService } from './service.ts';

const gate = vi.hoisted(() => ({ rebrand: true }));
vi.mock('../home/switch.ts', () => ({ get REBRAND_SWITCH() { return gate.rebrand; } }));
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function plant(home: Home, id: string, rebrand: boolean) {
  const entry = join(versionDir(id, {}, home), 'node_modules', productIdentity(rebrand).npmPackage, 'dist/index.js');
  mkdirSync(dirname(entry), { recursive: true }); writeFileSync(entry, `console.log(${JSON.stringify(id)});`);
  writeManifest(id, { version: id.split('+')[0]!, source: id.endsWith('+local') ? 'local' : 'registry', installedAt: '2026-11-08T00:00:00Z' }, {}, home);
  return entry;
}

function fixture(rebrand: boolean, local = false) {
  gate.rebrand = rebrand;
  const root = mkdtempSync(join(tmpdir(), 'managed-activation-failure-')); roots.push(root);
  const home = Home.sandbox(root, { layout: 'legacy' });
  const oldEntry = plant(home, '1.0.0', false);
  activate('1.0.0', {}, home, false);
  const id = local ? '2.0.0+local' : '2.0.0';
  const newEntry = plant(home, id, rebrand);
  const bins = writeLaunchers({}, home, false);
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  const oldLauncher = join(bins, `hsq${suffix}`), oldBytes = readFileSync(oldLauncher);
  // A directory at the first launcher path makes the refresh fail even when tests run as root.
  const blocked = join(bins, `cezarion${suffix}`);
  rmSync(blocked); mkdirSync(blocked);
  const restart = vi.fn();
  const service = new SelfUpdateService({ home, entry: oldEntry, version: '1.0.0', pkgName: productIdentity(false).npmPackage, restart,
    registry: new RegistryCache(productIdentity(rebrand).npmPackage, async () => Response.json({ 'dist-tags': { latest: '2.0.0' }, versions: { '2.0.0': {} } })) });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return { home, service, id, oldEntry, newEntry, oldLauncher, oldBytes, blocked, restart };
}

for (const rebrand of [false, true]) for (const command of ['install', 'update'] as const) {
  it(`switch ${rebrand}: CLI ${command} preserves a usable current version after launcher refresh fails`, async () => {
    const f = fixture(rebrand, command === 'install');
    const pack = vi.spyOn(installer, 'installFromLocal').mockResolvedValue({ id: f.id, version: '2.0.0', entry: f.newEntry });
    const code = await runSelfUpdateCommand(command, [], { home: f.home, service: f.service, modifyPath: false });
    expect(code).toBe(1);
    // Off keeps the shipped order: both versions use the legacy scoped path, so the old launcher works.
    expect(activeId({}, f.home)).toBe(rebrand ? '1.0.0' : f.id);
    expect(readFileSync(currentEntry({}, f.home), 'utf8')).toBe(readFileSync(rebrand ? f.oldEntry : f.newEntry, 'utf8'));
    expect(readFileSync(f.oldLauncher)).toEqual(f.oldBytes);
    if (process.platform !== 'win32') expect(execFileSync('/bin/sh', [f.oldLauncher], { encoding: 'utf8' }).trim()).toBe(rebrand ? '1.0.0' : f.id);
    expect(f.restart).not.toHaveBeenCalled();
    expect(pack).toHaveBeenCalledTimes(command === 'install' && !rebrand ? 1 : 0);
  });
}

it('cockpit apply keeps current unchanged and reports failure when launcher refresh fails', () => {
  const f = fixture(true);
  expect(f.service.apply(f.id).status).toBe('failed');
  expect(activeId({}, f.home)).toBe('1.0.0');
  expect(readFileSync(f.oldLauncher)).toEqual(f.oldBytes);
  expect(f.restart).not.toHaveBeenCalled();
});

it('CLI use reports failure and keeps current unchanged when launcher refresh fails', async () => {
  const f = fixture(true);
  expect(await runSelfUpdateCommand('use', [f.id], { home: f.home, service: f.service, modifyPath: false })).toBe(1);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('use failed:'));
  expect(activeId({}, f.home)).toBe('1.0.0');
  expect(readFileSync(f.oldLauncher)).toEqual(f.oldBytes);
});

it('a failed install launcher refresh prevents replacement of the already active local tree', async () => {
  const f = fixture(true, true);
  const local = plant(f.home, '1.0.0+local', false);
  activate('1.0.0+local', {}, f.home, false);
  const pack = vi.spyOn(installer, 'installFromLocal').mockImplementation(async () => {
    rmSync(dirname(dirname(local)), { recursive: true });
    return { id: '1.0.0+local', version: '1.0.0', entry: plant(f.home, '1.0.0+local', true) };
  });
  await expect(f.service.installSelf(() => {})).rejects.toThrow();
  expect(pack).not.toHaveBeenCalled();
  expect(activeId({}, f.home)).toBe('1.0.0+local');
  expect(readFileSync(local, 'utf8')).toContain(JSON.stringify('1.0.0+local'));
  expect(readFileSync(f.oldLauncher)).toEqual(f.oldBytes);
});

it.each([false, true])('switch %s: CLI install activates successfully after launcher refresh', async rebrand => {
  const f = fixture(rebrand, true);
  rmSync(f.blocked, { recursive: true });
  const pack = vi.spyOn(installer, 'installFromLocal').mockResolvedValue({ id: f.id, version: '2.0.0', entry: f.newEntry });
  expect(await runSelfUpdateCommand('install', [], { home: f.home, service: f.service, modifyPath: false })).toBe(0);
  expect(activeId({}, f.home)).toBe(f.id);
  expect(readFileSync(currentEntry({}, f.home), 'utf8')).toBe(readFileSync(f.newEntry, 'utf8'));
  if (rebrand) expect(readFileSync(f.oldLauncher, 'utf8')).toContain('# hsq managed install');
  else expect(readFileSync(f.oldLauncher)).toEqual(f.oldBytes);
  expect(pack).toHaveBeenCalledTimes(1);
});

it('CLI link --use keeps current unchanged when launcher refresh fails', async () => {
  const f = fixture(true);
  const source = join(f.home.root, 'source');
  mkdirSync(join(source, 'dist'), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: productIdentity(false).npmPackage, version: '3.0.0' }));
  writeFileSync(join(source, 'dist/index.js'), 'console.log("source");');
  expect(await runSelfUpdateCommand('link', [source], { home: f.home, service: f.service, modifyPath: false, use: true })).toBe(1);
  expect(activeId({}, f.home)).toBe('1.0.0');
  expect(readFileSync(f.oldLauncher)).toEqual(f.oldBytes);
});
