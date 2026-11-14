import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveHome } from './resolve.ts'; // test-home-read: entry tests need unresolved scratch paths without a sandbox marker.
import { cleanStoreRoots, storeRoot } from './store.testkit.ts';
import { rawJson } from './migration.testkit.ts';
import { operatorHomeEntry, prepareOperatorHome } from './entry.ts';

afterEach(() => { vi.restoreAllMocks(); cleanStoreRoots(); });

function fixture(nested = false) {
  const dir = storeRoot();
  const env = { CEZ_HOME: join(dir, 'legacy'), HSQ_HOME: join(dir, nested ? 'legacy' : 'new') };
  const legacy = resolveHome({ purpose: 'cli', env, layout: 'legacy' }); // test-home-read: both overrides are scratch paths.
  const home = resolveHome({ purpose: 'cli', env, layout: 'split' }); // test-home-read: absent-home behavior requires no marker.
  return { dir, env, legacy, home, prepareOperatorHome, operatorHomeEntry };
}

it('leaves absent homes untouched for conditional reads and invalid commands', () => {
  const f = fixture(true);
  for (const command of ['projects', 'remote-settings', 'install', 'update', 'use', 'link', 'unlink', 'server-install', 'server-deploy', 'server-uninstall', 'backup-read', 'unknown']) {
    f.prepareOperatorHome(f.home, command, f.env);
    expect(readdirSync(f.dir)).toEqual([]);
  }
});

it.each(['serve', 'init', 'run', 'backup', 'projects'])('only the %s writer prepares a fresh split home', async command => {
  const f = fixture();
  f.prepareOperatorHome(f.home, command, f.env);
  if (command === 'projects') {
    expect(readdirSync(f.dir)).toEqual([]);
    const { HomeStore } = await import('./store.ts');
    new HomeStore(f.home).writeJson(f.home.workspaceConfig, { projects: [], saved: true });
  }
  expect(existsSync(join(f.home.config, 'install.json'))).toBe(true);
  expect(existsSync(f.legacy.root)).toBe(false);
  // An old binary appears after the fresh decision. It must never replace live data.
  mkdirSync(f.legacy.root, { recursive: true }); // Intentional old-binary fixture.
  writeFileSync(f.legacy.workspaceConfig, '{"oldWriter":true}'); // Intentional old-binary write.
  f.prepareOperatorHome(f.home, 'serve', f.env);
  expect(existsSync(f.home.workspaceConfig) ? readFileSync(f.home.workspaceConfig, 'utf8') : '').not.toContain('oldWriter');
  const { getHomeRecovery } = await import('./recovery.ts');
  expect(getHomeRecovery(f.home).files.some(file => file.reason === 'legacy-change')).toBe(true);
});

it('lists unmigrated legacy backups without writing', async () => {
  const f = fixture();
  mkdirSync(f.legacy.root, { recursive: true }); // Intentional old-binary fixture.
  writeFileSync(`${f.legacy.workspaceConfig}.bak`, '{"projects":[]}'); // Intentional pre-migration fixture.
  const before = readdirSync(f.legacy.root);
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const { loadSubcommand } = await import('../subcommands.ts');
  const run = await loadSubcommand('backup', () => f.home);
  expect(await run!(['list'], f.env)).toBe(0);
  expect(JSON.parse(output.mock.calls[0]![0])).toEqual(expect.arrayContaining([expect.objectContaining({ file: 'config.json' })]));
  expect(readdirSync(f.legacy.root)).toEqual(before);
  expect(existsSync(f.home.config)).toBe(false);
});

it('keeps the existing-empty legacy decision and MOVED canary publication', () => {
  const f = fixture();
  mkdirSync(f.legacy.root, { recursive: true }); // Intentional empty legacy install.
  f.prepareOperatorHome(f.home, 'projects', f.env);
  expect(JSON.parse(readFileSync(join(f.home.config, 'install.json'), 'utf8'))).toMatchObject({ state: 'committed', migratedFrom: f.legacy.root });
  expect(existsSync(join(f.legacy.root, 'MOVED.json'))).toBe(true);
});

it('does not mistake the new nested split directories for a pre-existing legacy install', () => {
  const f = fixture(true);
  f.prepareOperatorHome(f.home, 'serve', f.env);
  expect(existsSync(join(f.legacy.root, 'MOVED.json'))).toBe(false);
});

it('consumes deferred preparation before it writes through the same store', async () => {
  const f = fixture();
  const { HomeStore } = await import('./store.ts');
  const { authorizeHomeEntry } = await import('./entry-authorization.ts');
  // Deferred accounts finish through a store transaction; that write must not run the preparation again.
  const prepare = vi.fn(() => new HomeStore(f.home).transaction(() => {}));
  authorizeHomeEntry(f.home, 'projects', 'test', prepare);
  new HomeStore(f.home).writeJson(f.home.workspaceConfig, { projects: [], saved: true });
  expect(prepare).toHaveBeenCalledOnce();
});

it('keeps a refusing deferred preparation armed for the next write', async () => {
  const f = fixture();
  const { HomeStore } = await import('./store.ts');
  const { authorizeHomeEntry } = await import('./entry-authorization.ts');
  const prepare = vi.fn(() => { throw new Error('refused'); });
  authorizeHomeEntry(f.home, 'projects', 'test', prepare);
  const write = () => new HomeStore(f.home).writeJson(f.home.workspaceConfig, { projects: [], saved: true });
  expect(write).toThrow('refused');
  expect(write).toThrow('refused');
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(readdirSync(f.dir)).toEqual([]);
});

it.each(['installed', 'rolled-back'])('refuses the deferred split write when an %s legacy server appears first', async state => {
  const f = fixture();
  f.prepareOperatorHome(f.home, 'projects', f.env);
  expect(readdirSync(f.dir)).toEqual([]);
  // Another binary installs a server in the legacy home before this command's first write.
  rawJson(f.legacy.serverState(), { schema: 1, instance: 'default', installed: true, platform: 'ubuntu-vps', primaryPort: 4321, steps: {} });
  if (state === 'rolled-back') rawJson(join(f.home.config, 'install.json.failed'), { kind: 'live', state: 'pending' });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { HomeStore } = await import('./store.ts');
  const write = () => new HomeStore(f.home).writeJson(f.home.workspaceConfig, { projects: [], saved: true });
  expect(write).toThrow(/Run hsq server-migrate/);
  expect(write).toThrow(/Run hsq server-migrate/);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('hsq server-migrate'));
  expect(existsSync(join(f.home.config, 'install.json'))).toBe(false);
  expect(existsSync(f.home.workspaceConfig)).toBe(false);
  expect(existsSync(join(f.legacy.root, 'MOVED.json'))).toBe(false);
});

it('invalid backup restore input prepares nothing', async () => {
  const f = fixture(true);
  const invalid = [['restore'], ['restore', 'invalid.json'], ['restore', 'config.json', 'extra'],
    ['restore', 'config.json', '--at', 'yesterday'], ['restore', 'config.json', '--unknown'], ['restore', '--help']];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { runSubcommand } = await import('../subcommands.ts');
  for (const args of invalid) {
    const argv = ['backup', ...args];
    const entry = f.operatorHomeEntry(argv);
    expect(entry, args.join(' ')).toBe('backup-read');
    const exit = await runSubcommand(argv, f.env, () => f.prepareOperatorHome(f.home, entry, f.env));
    expect(exit, args.join(' ')).toBe(args.includes('--help') ? 0 : 1);
    expect(readdirSync(f.dir), args.join(' ')).toEqual([]);
  }
  expect(error).toHaveBeenCalled();
  expect(f.operatorHomeEntry(['backup', 'restore', 'config.json', '--at', '2026-11-10T00:00:00Z'])).toBe('backup');
});

it('lists only legacy backups inside the legacy home', async () => {
  const f = fixture();
  const outside = join(f.dir, 'outside');
  mkdirSync(outside); // Intentional escape target.
  const snapshot = (content: string) => `2026-11-10T00-00-00.000Z-${createHash('sha256').update(content).digest('hex').slice(0, 8)}.json`;
  const inner = '{"projects":[],"inside":true}', outer = '{"projects":[],"outside":true}';
  writeFileSync(join(outside, 'config.json.bak'), outer);
  writeFileSync(join(outside, snapshot(outer)), outer);
  mkdirSync(join(f.legacy.backups, 'config.json'), { recursive: true }); // Intentional pre-migration fixture.
  writeFileSync(join(f.legacy.backups, 'config.json', snapshot(inner)), inner);
  // Old-binary layouts can hold links; a list must never follow one out of the legacy home.
  symlinkSync(join(outside, 'config.json.bak'), `${f.legacy.workspaceConfig}.bak`);
  symlinkSync(outside, join(f.legacy.backups, 'ui-state.json'));
  mkdirSync(join(f.legacy.backups, 'agent-accounts.json'));
  symlinkSync(join(outside, snapshot(outer)), join(f.legacy.backups, 'agent-accounts.json', snapshot(outer)));
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const { loadSubcommand } = await import('../subcommands.ts');
  const run = await loadSubcommand('backup', () => f.home);
  expect(await run!(['list'], f.env)).toBe(0);
  const listed: Array<{ file: string; path: string }> = JSON.parse(output.mock.calls[0]![0]);
  expect(listed).toEqual([expect.objectContaining({ file: 'config.json', path: join(f.legacy.backups, 'config.json', snapshot(inner)) })]);
});

it('takes the fresh decision before seeding split files that have no marker', async () => {
  const f = fixture();
  // A split home whose install.json was deleted: registry data, no marker, no legacy home.
  rawJson(f.home.workspaceConfig, { projects: [], saved: 'split' });
  f.prepareOperatorHome(f.home, 'projects', f.env);
  expect(JSON.parse(readFileSync(join(f.home.config, 'install.json'), 'utf8'))).toMatchObject({ state: 'committed', migratedFrom: f.legacy.root });
  expect(existsSync(f.legacy.root)).toBe(false);
  // An old binary then creates the legacy home: the canary reports it; boot does not refuse.
  mkdirSync(f.legacy.root, { recursive: true }); // Intentional old-binary fixture.
  writeFileSync(f.legacy.workspaceConfig, '{"oldWriter":true}'); // Intentional old-binary write.
  f.prepareOperatorHome(f.home, 'serve', f.env);
  expect(readFileSync(f.home.workspaceConfig, 'utf8')).not.toContain('oldWriter');
  const { getHomeRecovery } = await import('./recovery.ts');
  expect(getHomeRecovery(f.home).files.some(file => file.reason === 'legacy-change')).toBe(true);
});

it('lists the split home when its install marker is unreadable', async () => {
  const f = fixture();
  mkdirSync(f.home.config, { recursive: true }); // Intentional corrupt-marker fixture.
  writeFileSync(join(f.home.config, 'install.json'), '{corrupt'); // Intentional corrupt marker.
  mkdirSync(f.legacy.root, { recursive: true }); // Intentional pre-migration fixture.
  writeFileSync(`${f.legacy.workspaceConfig}.bak`, '{"projects":[]}'); // Intentional pre-migration fixture.
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const { loadSubcommand } = await import('../subcommands.ts');
  const run = await loadSubcommand('backup', () => f.home);
  expect(await run!(['list'], f.env)).toBe(0);
  const listed: Array<{ path: string }> = JSON.parse(output.mock.calls[0]![0]);
  expect(listed.every(entry => !entry.path.startsWith(f.legacy.root))).toBe(true);
});

it('refuses the deferred split write when another process stages a server group first', async () => {
  const f = fixture();
  f.prepareOperatorHome(f.home, 'projects', f.env);
  expect(readdirSync(f.dir)).toEqual([]);
  // hsq server-migrate stages the copy (commit:false) before this command's first write.
  rawJson(f.legacy.workspaceConfig, { projects: [], saved: 'legacy' });
  const { migrateLegacyHome } = await import('./migrate.ts');
  migrateLegacyHome(f.legacy, f.home, { commit: false, env: f.env });
  const staged = readFileSync(f.home.workspaceConfig);
  const { HomeStore } = await import('./store.ts');
  const write = () => new HomeStore(f.home).writeJson(f.home.workspaceConfig, { projects: [], saved: 'split' });
  expect(write).toThrow(/Run hsq server-migrate/);
  expect(readFileSync(f.home.workspaceConfig)).toEqual(staged);
  expect(JSON.parse(readFileSync(join(f.home.config, 'install.json'), 'utf8')).state).toBe('pending');
});
