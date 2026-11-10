import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveHome } from './resolve.ts'; // test-home-read: entry tests need unresolved scratch paths without a sandbox marker.
import { cleanStoreRoots, storeRoot } from './store.testkit.ts';

afterEach(() => { vi.doUnmock('./switch.ts'); vi.resetModules(); vi.restoreAllMocks(); cleanStoreRoots(); });

async function fixture(enabled: boolean, nested = false) {
  vi.resetModules();
  vi.doMock('./switch.ts', () => ({ REBRAND_SWITCH: enabled }));
  const dir = storeRoot();
  const env = { CEZ_HOME: join(dir, 'legacy'), HSQ_HOME: join(dir, nested ? 'legacy' : 'new') };
  const legacy = resolveHome({ purpose: 'cli', env, layout: 'legacy' }); // test-home-read: both overrides are scratch paths.
  const home = resolveHome({ purpose: 'cli', env, layout: enabled ? 'split' : 'legacy' }); // test-home-read: absent-home behavior requires no marker.
  return { dir, env, legacy, home, ...await import('./entry.ts') };
}

it.each([false, true])('leaves absent homes untouched for conditional reads and invalid commands (switch %s)', async enabled => {
  const f = await fixture(enabled, true);
  for (const command of ['projects', 'remote-settings', 'install', 'update', 'use', 'link', 'unlink', 'server-install', 'server-deploy', 'server-uninstall', 'backup-read', 'unknown']) {
    f.prepareOperatorHome(f.home, command, f.env);
    expect(readdirSync(f.dir)).toEqual([]);
  }
});

it.each(['serve', 'init', 'run', 'backup', 'projects'])('only the %s writer prepares a fresh split home', async command => {
  const f = await fixture(true);
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
  expect(getHomeRecovery(f.home, true).files.some(file => file.reason === 'legacy-change')).toBe(true);
});

it.each([false, true])('lists unmigrated legacy backups without writing (switch %s)', async enabled => {
  const f = await fixture(enabled);
  mkdirSync(f.legacy.root, { recursive: true }); // Intentional old-binary fixture.
  writeFileSync(`${f.legacy.workspaceConfig}.bak`, '{"projects":[]}'); // Intentional pre-migration fixture.
  const before = readdirSync(f.legacy.root);
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const { loadSubcommand } = await import('../subcommands.ts');
  const run = await loadSubcommand('backup', () => f.home);
  expect(await run!(['list'], f.env)).toBe(0);
  expect(JSON.parse(output.mock.calls[0]![0])).toEqual(expect.arrayContaining([expect.objectContaining({ file: 'config.json' })]));
  expect(readdirSync(f.legacy.root)).toEqual(before);
  if (enabled) expect(existsSync(f.home.config)).toBe(false);
});

it('keeps the existing-empty legacy decision and MOVED canary publication', async () => {
  const f = await fixture(true);
  mkdirSync(f.legacy.root, { recursive: true }); // Intentional empty legacy install.
  f.prepareOperatorHome(f.home, 'projects', f.env);
  expect(JSON.parse(readFileSync(join(f.home.config, 'install.json'), 'utf8'))).toMatchObject({ state: 'committed', migratedFrom: f.legacy.root });
  expect(existsSync(join(f.legacy.root, 'MOVED.json'))).toBe(true);
});

it('does not mistake the new nested split directories for a pre-existing legacy install', async () => {
  const f = await fixture(true, true);
  f.prepareOperatorHome(f.home, 'serve', f.env);
  expect(existsSync(join(f.legacy.root, 'MOVED.json'))).toBe(false);
});

it('consumes deferred preparation before it writes through the same store', async () => {
  const f = await fixture(true);
  const { HomeStore } = await import('./store.ts');
  const { authorizeHomeEntry } = await import('./entry-authorization.ts');
  // Deferred accounts finish through a store transaction; that write must not run the preparation again.
  const prepare = vi.fn(() => new HomeStore(f.home).transaction(() => {}));
  authorizeHomeEntry(f.home, 'projects', 'test', prepare);
  new HomeStore(f.home).writeJson(f.home.workspaceConfig, { projects: [], saved: true });
  expect(prepare).toHaveBeenCalledOnce();
});

it('keeps a refusing deferred preparation armed for the next write', async () => {
  const f = await fixture(true);
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
