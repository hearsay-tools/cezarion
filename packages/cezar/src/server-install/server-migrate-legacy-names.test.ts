import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Home } from '../home/home.ts';
import { serverInstanceForPort } from '../home/entry.ts';
import { cleanStoreRoots, storeRoot } from '../home/store.testkit.ts';
import { runDeploy, runUninstall, type RunOptions } from './engine.ts';
import { runServerMigrateCommand } from './migrate-cli.ts';
import { createUbuntuVps } from './platforms/ubuntu-vps.ts';
import { installInstance, serverFixture, sharedHome, type ServerFixture } from './server-migrate.testkit.ts';
import { createAutoUi } from './ui.ts';
import type { InstallContext, Ui } from './types.ts';

afterEach(() => { cleanStoreRoots(); vi.restoreAllMocks(); });

function runOptions(f: ServerFixture, instance: string): RunOptions {
  return { home: f.legacy, dryRun: false, assumeYes: true, reconfigure: new Set(), repoRoot: '/srv/repo',
    now: '2026-11-07T00:00:00.000Z', ui: createAutoUi(), runner: f.host, instance };
}

describe('an install made before the rename keeps its recorded cezar names', () => {
  const strategy = createUbuntuVps();

  it('server-uninstall removes the recorded cezar unit, site and htpasswd', async () => {
    const f = sharedHome();
    await expect(runUninstall(strategy, runOptions(f, 'shop'))).resolves.toMatchObject({ status: 'complete' });
    expect(f.host.exists('/etc/systemd/system/cezar-shop.service')).toBe(false);
    expect(f.host.exists('/etc/nginx/sites-available/cezar-shop')).toBe(false);
    expect(f.host.exists('/etc/cezar/htpasswd-shop')).toBe(false);
    expect(f.host.enabledSites()).toEqual(['cezar']);
    expect(f.host.commands.join('\n')).toContain('cezar-shop.service');
    expect(f.host.commands.join('\n')).not.toContain('hearsay-squawk');
  });

  it('server-deploy restarts the recorded cezar unit', async () => {
    const f = sharedHome();
    await expect(runDeploy(strategy, runOptions(f, 'default'))).resolves.toMatchObject({ status: 'complete' });
    expect(f.host.commands).toContain('systemctl --user restart cezar.service');
    expect(f.host.commands.join('\n')).not.toContain('hearsay-squawk');
  });

  it('a fresh install gets the new unit, site and htpasswd names', async () => {
    const ctx = { home: Home.sandbox(storeRoot()), state: { schema: 1, installed: false, primaryPort: 4321, steps: {} }, instance: 'default',
      ui: { ...createAutoUi(), text: async () => 'ops', password: async () => 'longenough' } as Ui, runner: serverFixture().host,
      save: async () => {}, dryRun: true, assumeYes: true, reconfigure: new Set(), repoRoot: '/srv/repo', now: '2026-11-07T00:00:00.000Z', prefs: {} } as InstallContext;
    const step = (id: string) => strategy.steps(ctx).find(s => s.id === id)!;
    const proxy = (await step('nginx-proxy').run(ctx))?.artifacts.flatMap(a => a.kind === 'owned' && a.path ? [a.path] : []);
    expect(proxy).toEqual(['/etc/nginx/sites-available/hearsay-squawk', '/etc/nginx/sites-enabled/hearsay-squawk', '/etc/hearsay-squawk/htpasswd']);
    expect((await step('autostart').run(ctx))?.artifacts[0]?.name).toBe('hearsay-squawk.service');
  });

  it('service hints name the new unit', async () => {
    const lines: string[] = [];
    const ctx = { home: Home.sandbox(storeRoot()), state: { schema: 1, installed: false, primaryPort: 4322, steps: {} }, instance: 'shop',
      ui: { ...createAutoUi(), info: (m: string) => { lines.push(m); } } as Ui, runner: serverFixture().host,
      save: async () => {}, dryRun: true, assumeYes: true, reconfigure: new Set(), repoRoot: '/srv/repo', now: '2026-11-07T00:00:00.000Z', prefs: {} } as InstallContext;
    await createUbuntuVps().steps(ctx).find(s => s.id === 'autostart')!.run(ctx);
    expect(lines.join('\n')).toContain('systemctl --user enable --now hearsay-squawk-shop)');
  });
});

describe('cez server-migrate', () => {
  it('prints the plan for --dry-run and exits 0 without changing the host', async () => {
    const f = serverFixture();
    installInstance(f, { instance: 'default', port: 4321 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const homes = { legacy: f.legacy, target: f.target, runner: f.host, strategy: () => createUbuntuVps() };
    await expect(runServerMigrateCommand(['--dry-run'], f.env, homes)).resolves.toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('default: file /etc/cezar/htpasswd → /etc/hearsay-squawk/htpasswd (copied; old file kept)');
    expect(f.host.commands).toEqual([]);
    await expect(runServerMigrateCommand(['--help'], f.env, homes)).resolves.toBe(0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runServerMigrateCommand(['--nope'], f.env, homes)).resolves.toBe(1);
  });
});

/** Every entry under root with its kind, mode and content hash: any created, changed or removed entry shows. */
function tree(root: string, dir = root): string[] {
  return readdirSync(dir).sort().flatMap(name => {
    const path = join(dir, name);
    const stat = lstatSync(path);
    const key = `${relative(root, path)} ${(stat.mode & 0o7777).toString(8)}`;
    if (stat.isDirectory()) return [`${key}/`, ...tree(root, path)];
    const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(path)) : readFileSync(path);
    return [`${key} ${createHash('sha256').update(bytes).digest('hex')}`];
  });
}

describe('cez server-migrate --dry-run writes nothing', () => {
  it.each(['unmarked', 'unjournaled', 'current'])('leaves every file unchanged across repeated dry runs of a %s home', async mode => {
    const f = sharedHome();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const homes = { legacy: f.legacy, target: f.target, runner: f.host, strategy: () => createUbuntuVps() };
    // Simulate old homes and upgrades that have no version history yet.
    if (mode !== 'current') rmSync(join(f.legacy.root, '.versions'), { recursive: true, force: true });
    if (mode === 'unmarked') rmSync(join(f.legacy.root, 'install.json'));
    const before = tree(f.directory);
    await expect(runServerMigrateCommand(['--dry-run'], f.env, homes)).resolves.toBe(0);
    await expect(runServerMigrateCommand(['--dry-run'], f.env, homes)).resolves.toBe(0);
    expect(tree(f.directory)).toEqual(before);
    expect(f.host.commands).toEqual([]);
  });

  it('a real run leaves no rotating backup of the install locks it took', async () => {
    const f = sharedHome();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const homes = { legacy: f.legacy, target: f.target, runner: f.host, strategy: () => createUbuntuVps() };
    await expect(runServerMigrateCommand(['--yes'], f.env, homes)).resolves.toBe(0);
    expect(tree(f.directory).filter(entry => entry.includes('backups/') && entry.includes('install.lock'))).toEqual([]);
  });
});

describe('cockpit lease instance', () => {
  it('names the server record whose port the cockpit serves', () => {
    const home = Home.sandbox(storeRoot());
    Home.seed(home, home.serverState(), { primaryPort: 4321 });
    Home.seed(home, join(home.serverInstances, 'shop.json'), { primaryPort: 4400 });
    expect(serverInstanceForPort(home, 4400)).toBe('shop');
    expect(serverInstanceForPort(home, 4321)).toBe('default');
    expect(serverInstanceForPort(home, 9999)).toBe('default');
  });
});
