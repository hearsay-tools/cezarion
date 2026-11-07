import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Home } from './home.ts';
import { migrateLegacyHome } from './migrate.ts';
import { readMigrationRecord } from './migration-record.ts';
import { prepareMigrationHome } from './migration-boot.ts';
import { HomeStore } from './store.ts';
import { getHomeRecovery } from './recovery.ts';
import { resolveHome } from './resolve.ts'; // test-home-read: injected CEZ_HOME selects only the sandbox.
import { writeLaunchers } from '../self-update/launcher.ts';
import { RunStore } from '../runs/store.ts';
import { migrationFixture, rawJson, json } from './migration.testkit.ts';
import { cleanStoreRoots, storeRoot } from './store.testkit.ts';
import { planLegacyMigration } from './migration-plan.ts';
import * as privateFiles from './private-files.ts';

afterEach(() => { vi.restoreAllMocks(); cleanStoreRoots(); });

function accountFixture(provider = 'claude') {
  const fixture = migrationFixture();
  const configDir = join(fixture.legacy.root, 'credentials', ...(provider === 'omp' ? ['profiles', 'work'] : ['work']));
  rawJson(join(configDir, 'auth.json'), { secret: 'old-credentials' });
  writeFileSync(join(configDir, 'settings.json'), '{ // vendor JSONC\n "settings": true,\n}');
  const account = { id: 'work', provider, configDir };
  Home.seed(fixture.legacy, fixture.legacy.agentAccounts, { accounts: [account], unknown: 'kept' });
  return { ...fixture, account };
}

it('step 7: copies internal account credentials, rewrites configDir with HEAD, and leaves legacy untouched', () => {
  const { legacy, target, account } = accountFixture();
  const before = readFileSync(legacy.agentAccounts);
  let refused = false;
  migrateLegacyHome(legacy, target, { onStep(step) {
    if (step !== 'accounts') return;
    expect(() => new HomeStore(target).writeJson(target.agentAccounts, {})).toThrow(/pending migration/);
    refused = true;
  } });
  expect(refused).toBe(true);
  const saved = JSON.parse(new HomeStore(target).read(target.agentAccounts));
  expect(saved.accounts[0].configDir).toBe(join(target.data, 'accounts', account.id));
  expect(saved.unknown).toBe('kept');
  expect(json(join(saved.accounts[0].configDir, 'auth.json')).secret).toBe('old-credentials');
  expect(readFileSync(join(saved.accounts[0].configDir, 'settings.json'))).toEqual(readFileSync(join(account.configDir, 'settings.json')));
  expect(readFileSync(legacy.agentAccounts)).toEqual(before);
  expect(json(join(account.configDir, 'auth.json')).secret).toBe('old-credentials');
  expect(getHomeRecovery(target)).toEqual({ files: [] });
});

it('step 7: a live registered run defers its account; the next boot copies it after the owner closes', () => {
  const { legacy, target, account, env } = accountFixture();
  const project = storeRoot();
  Home.seed(legacy, legacy.workspaceConfig, { projects: [{ id: 'project', root: project }] });
  const store = RunStore.open(join(project, '.ai', 'cezar'), { keepLive: true });
  const run = store.createRun({ title: 'live account', workflow: 'quick-task', task: 'test', steps: [], agentProfile: account.id });
  store.move(run.id, 'start');
  store.flush();
  try {
    expect(planLegacyMigration(legacy, target).deferredAccounts).toEqual([{ id: account.id, configDir: account.configDir }]);
    migrateLegacyHome(legacy, target);
    expect(readMigrationRecord(target)!.deferredAccounts).toEqual([{ id: account.id, configDir: account.configDir }]);
    expect(json(target.agentAccounts).accounts[0].configDir).toBe(account.configDir);
    expect(existsSync(join(target.data, 'accounts', account.id))).toBe(false);
    prepareMigrationHome(target, env, { enabled: true, legacy });
    expect(readMigrationRecord(target)!.deferredAccounts).toHaveLength(1);
  } finally { store.close(); }
  prepareMigrationHome(target, env, { enabled: true, legacy });
  expect(readMigrationRecord(target)!.deferredAccounts).toEqual([]);
  expect(json(target.agentAccounts).accounts[0].configDir).toBe(join(target.data, 'accounts', account.id));
  expect(getHomeRecovery(target)).toEqual({ files: [] });
});

it('step 7: accounts outside the legacy realpath keep their configDir', () => {
  const { legacy, target } = migrationFixture();
  const outside = storeRoot();
  rawJson(join(outside, 'auth.json'), { token: 'external' });
  Home.seed(legacy, legacy.agentAccounts, { accounts: [{ id: 'external', provider: 'codex', configDir: outside }] });
  migrateLegacyHome(legacy, target);
  expect(json(target.agentAccounts).accounts[0].configDir).toBe(outside);
  expect(existsSync(join(target.data, 'accounts'))).toBe(false);
});

it('step 7: an internal omp account stays in place, records notMoved, warns, and is visible in dry-run', () => {
  const { legacy, target, account } = accountFixture('omp');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(planLegacyMigration(legacy, target).notMoved).toEqual([{ id: account.id, configDir: account.configDir, reason: 'omp-profile-root-inside-legacy-home' }]);
  expect(migrateLegacyHome(legacy, target).status).toBe('migrated');
  expect(json(target.agentAccounts).accounts[0].configDir).toBe(account.configDir);
  expect(readMigrationRecord(target)!.notMoved).toHaveLength(1);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('work stays at'));
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('PI_CONFIG_DIR'));
});

it('a custom CEZ_HOME migrates in place into one-root kind directories', () => {
  const { legacy } = migrationFixture();
  const target = resolveHome({ purpose: 'cli', env: { CEZ_HOME: legacy.root }, layout: 'split' }); // test-home-read: injected sandbox root.
  migrateLegacyHome(legacy, target);
  expect(target.config).toBe(join(legacy.root, 'config'));
  expect(target.state).toBe(join(legacy.root, 'state'));
  expect(json(target.workspaceConfig).saved).toBe('original');
  expect(json(legacy.workspaceConfig).saved).toBe('original');
  expect(migrateLegacyHome(legacy, target).status).toBe('unchanged');
});

it.skipIf(process.platform === 'win32')('managed install copies offline, replaces the marked PATH line, and both launchers still run', () => {
  const { legacy, target, env, directory } = migrationFixture();
  const entry = join(legacy.versions, 'v1/node_modules/@wjarka/cezarion/dist/index.js');
  mkdirSync(join(entry, '..'), { recursive: true });
  writeFileSync(entry, "process.stdout.write('launcher-ok')");
  const jsonc = join(legacy.versions, 'v1/tsconfig.json');
  writeFileSync(jsonc, '{ // vendor JSONC\n "compilerOptions": {},\n}');
  symlinkSync('v1', join(legacy.versions, 'current'));
  writeLaunchers({}, legacy);
  const oldLauncher = readFileSync(join(legacy.bin, 'cez'));
  writeFileSync(join(directory, '.bashrc'), `# user setting\nexport PATH='${legacy.bin}':"$PATH" # cezar managed install\n`);
  migrateLegacyHome(legacy, target, { env });
  expect(readFileSync(join(target.versions, 'current/node_modules/@wjarka/cezarion/dist/index.js'))).toEqual(readFileSync(entry));
  expect(readFileSync(join(target.versions, 'current/tsconfig.json'))).toEqual(readFileSync(jsonc));
  expect(readFileSync(join(legacy.bin, 'cez'))).toEqual(oldLauncher);
  expect(readFileSync(join(directory, '.bashrc'), 'utf8')).toContain(target.bin);
  expect(readFileSync(join(directory, '.bashrc'), 'utf8')).toContain('# user setting');
  for (const bin of [legacy.bin, target.bin]) expect(execFileSync(join(bin, 'cez'), [], { env: { ...process.env, ...env }, encoding: 'utf8' })).toBe('launcher-ok');
});

it.skipIf(process.platform === 'win32').each(['matched', 'mismatched', 'unmanifested'])(
  'a %s linked development version preserves only its recorded external checkout', kind => {
    const { legacy, target, env } = migrationFixture();
    const checkout = storeRoot(), packageLink = join(legacy.versions, 'v1/node_modules/@wjarka/cezarion');
    mkdirSync(join(checkout, 'dist'));
    writeFileSync(join(checkout, 'dist/index.js'), "process.stdout.write('same-checkout')");
    mkdirSync(join(packageLink, '..'), { recursive: true });
    symlinkSync(checkout, packageLink, 'dir');
    symlinkSync('v1', join(legacy.versions, 'current'));
    if (kind !== 'unmanifested') rawJson(join(legacy.versions, 'v1/.cezar-install.json'), {
      version: '1.0.0', source: 'link', installedAt: new Date().toISOString(), checkout: kind === 'matched' ? checkout : storeRoot(),
    });
    if (kind === 'matched') {
      migrateLegacyHome(legacy, target, { env });
      expect(readlinkSync(join(target.versions, 'v1/node_modules/@wjarka/cezarion'))).toBe(checkout);
      expect(execFileSync(join(target.bin, 'cez'), [], { env: { ...process.env, ...env }, encoding: 'utf8' })).toBe('same-checkout');
    } else expect(() => migrateLegacyHome(legacy, target, { env })).toThrow(/escapes source/);
    expect(readFileSync(join(checkout, 'dist/index.js'), 'utf8')).toContain('same-checkout');
  });

it.skipIf(process.platform === 'win32').each(['outside', 'legacy', 'retry'])(
  'managed PATH preserves profile symlinks (%s) and retries a failed postcommit update', kind => {
    const { legacy, target, env, directory } = migrationFixture();
    mkdirSync(join(legacy.versions, 'v1'), { recursive: true });
    const profile = join(kind === 'legacy' ? legacy.root : storeRoot(), 'bashrc');
    const before = `export PATH='${legacy.bin}':"$PATH" # cezar managed install\n`;
    writeFileSync(profile, before);
    symlinkSync(profile, join(directory, '.bashrc'));
    if (kind === 'retry') {
      const replace = privateFiles.replacePrivate;
      vi.spyOn(privateFiles, 'replacePrivate').mockImplementation((path, bytes, options) => {
        if (path === profile) throw new Error('profile write failed');
        replace(path, bytes, options);
      });
      expect(() => migrateLegacyHome(legacy, target, { env })).toThrow('profile write failed');
      vi.restoreAllMocks();
      expect(migrateLegacyHome(legacy, target, { env }).status).toBe('unchanged');
    } else migrateLegacyHome(legacy, target, { env });
    expect(readlinkSync(join(directory, '.bashrc'))).toBe(profile);
    expect(readFileSync(profile, 'utf8')).toBe(kind === 'legacy' ? before : `export PATH='${target.bin}':"$PATH" # cezar managed install\n`);
  });
