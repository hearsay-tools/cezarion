import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Home } from './home.ts';
import { HomeStore } from './store.ts';
import { migrateLegacyHome } from './migrate.ts';
import { readMigrationRecord, writeMigrationRecord } from './migration-record.ts';
import { writeMigrationMarker } from './install-marker.ts';
import { acceptHomeRecovery, getHomeRecovery, importHomeRecovery } from './recovery.ts';
import { subscribeHomeRecovery } from './recovery-watch.ts';
import { legacyWatchDirectories } from './legacy-source.ts';
import { cleanStoreRoots, storeRoot } from './store.testkit.ts';
import { digest, VersionLog } from './version-log.ts';
import { listBackups } from '../workspace/backups.ts';
import * as fs from 'node:fs';

vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, watch: vi.fn(actual.watch) };
});

afterEach(() => { vi.restoreAllMocks(); cleanStoreRoots(); });
const base = { projects: [{ id: 'changed', root: '/old' }, { id: 'removed', root: '/removed' }], liveOnly: 'base', shared: 'base' };

function fixture(fresh = false) {
  const legacy = Home.sandbox(storeRoot(), { layout: 'legacy' });
  const home = Home.sandbox(storeRoot(), { layout: 'split' });
  if (!fresh) Home.seed(legacy, legacy.workspaceConfig, base);
  migrateLegacyHome(legacy, home);
  return { legacy, home, store: new HomeStore(home) };
}

function row(home: Home, file = 'config.json') {
  const legacy = getHomeRecovery(home, true).files.filter(row => row.reason === 'legacy-change');
  return legacy.find(row => row.file === file)!;
}

it('detects legacy changes only for a committed migrated home and leaves the disabled path dark', () => {
  const { legacy, home } = fixture();
  writeFileSync(legacy.workspaceConfig, JSON.stringify({ ...base, late: true })); // Deliberate older-binary write.
  expect(getHomeRecovery(home, false).files).toEqual([]);
  expect(legacyWatchDirectories(home, false)).toEqual([]);
  expect(row(home)).toMatchObject({ file: 'config.json', reason: 'legacy-change', canRestore: false, canImport: true });
  const detected = row(home).detectedAt;
  expect(row(home).detectedAt).toBe(detected);
  writeMigrationMarker(home.config, legacy.root, 'pending');
  expect(row(home)).toBeUndefined();
  expect(legacyWatchDirectories(home, true)).toEqual([]);
});

it('merges legacy deltas, keeps live edits, removes legacy entries, and backs up live bytes first', () => {
  const { legacy, home, store } = fixture();
  store.writeJson(home.workspaceConfig, { ...base, projects: [
    { id: 'changed', root: '/live-edit' }, { id: 'removed', root: '/removed' }, { id: 'live-new', root: '/new' },
  ], liveOnly: 'live edit', liveAdded: true, shared: 'live edit' });
  const previous = readFileSync(home.workspaceConfig);
  const changed = { projects: [{ id: 'changed', root: '/legacy-edit' }, { id: 'legacy-new', root: '/late' }],
    liveOnly: 'base', shared: 'legacy edit', legacyAdded: true };
  writeFileSync(legacy.workspaceConfig, JSON.stringify(changed)); // Deliberate legacy writer.
  importHomeRecovery(home, 'config.json', row(home).detectedAt, true);
  expect(JSON.parse(readFileSync(home.workspaceConfig, 'utf8'))).toEqual({ ...changed,
    projects: [{ id: 'changed', root: '/legacy-edit' }, { id: 'live-new', root: '/new' }, { id: 'legacy-new', root: '/late' }],
    liveOnly: 'live edit', liveAdded: true });
  expect(listBackups('config.json', home).some(backup => readFileSync(backup.path).equals(previous))).toBe(true);
  expect(row(home)).toBeUndefined();
  expect(readMigrationRecord(home)?.files.find(file => file.path === 'config.json')?.hash).toBe(digest(readFileSync(legacy.workspaceConfig)));
  // The retained source, rather than the merged destination, becomes the next three-way base.
  writeFileSync(legacy.workspaceConfig, JSON.stringify({ ...changed, another: true }));
  importHomeRecovery(home, 'config.json', row(home).detectedAt, true);
  expect(JSON.parse(readFileSync(home.workspaceConfig, 'utf8')).liveOnly).toBe('live edit');
});

it('Ignore keeps the live file and records exact legacy bytes as the next merge base', () => {
  const { legacy, home } = fixture();
  const live = readFileSync(home.workspaceConfig);
  writeFileSync(legacy.workspaceConfig, JSON.stringify({ ...base, ignored: true })); // Deliberate legacy writer.
  const flag = row(home);
  acceptHomeRecovery(home, 'config.json', flag.detectedAt, true);
  expect(row(home)).toBeUndefined();
  expect(readFileSync(home.workspaceConfig)).toEqual(live);
  const hash = readMigrationRecord(home)!.files.find(file => file.path === 'config.json')!.hash!;
  expect(readFileSync(join(home.config, '.versions/config.json', hash))).toEqual(readFileSync(legacy.workspaceConfig));
  acceptHomeRecovery(home, 'config.json', flag.detectedAt, true); // Resolved retry.
  writeFileSync(legacy.workspaceConfig, JSON.stringify({ ...base, ignored: true, imported: true }));
  expect(() => importHomeRecovery(home, 'config.json', flag.detectedAt, true)).toThrow(/incident changed/);
  importHomeRecovery(home, 'config.json', row(home).detectedAt, true);
  expect(JSON.parse(readFileSync(home.workspaceConfig, 'utf8'))).toEqual({ ...base, imported: true });
});

it('refuses Import when the base is missing, but still permits Ignore', () => {
  const { legacy, home } = fixture();
  const hash = readMigrationRecord(home)!.files.find(file => file.path === 'config.json')!.hash!;
  rmSync(join(home.config, '.versions/config.json', hash));
  writeFileSync(legacy.workspaceConfig, JSON.stringify({ ...base, late: true }));
  const flag = row(home);
  expect(flag.canImport).toBe(false);
  expect(() => importHomeRecovery(home, 'config.json', flag.detectedAt, true)).toThrow(/merge base is missing/);
  acceptHomeRecovery(home, 'config.json', flag.detectedAt, true);
  expect(row(home)).toBeUndefined();
});

it.each(['unreadable', 'corrupt', 'invalid JSON', 'null', 'array', 'primitive'])('offers only Ignore when the retained base is %s', state => {
  const { legacy, home, store } = fixture();
  const record = readMigrationRecord(home)!;
  const entry = record.files.find(file => file.path === 'config.json')!;
  if (state === 'unreadable') {
    const path = join(home.config, '.versions/config.json', entry.hash!);
    rmSync(path);
    mkdirSync(path); // A directory is unreadable as version bytes, even when tests run as root.
  } else {
    const bytes = Buffer.from(state === 'invalid JSON' ? '{' : state === 'null' ? 'null' : state === 'array' ? '[]' : state === 'primitive' ? '1' : '{}');
    if (state !== 'corrupt') {
      entry.hash = digest(bytes);
      store.transaction(() => writeMigrationRecord(home, record), [home.workspaceConfig, home.workspaceUiState]);
    }
    writeFileSync(join(home.config, '.versions/config.json', entry.hash!), bytes); // Deliberately damaged retained base.
  }
  const live = readFileSync(home.workspaceConfig);
  writeFileSync(legacy.workspaceConfig, JSON.stringify({ ...base, late: true }));
  const flag = row(home);
  expect(flag.canImport).toBe(false);
  expect(getHomeRecovery(home, false).files).toEqual([]); // The shipped switch remains off.
  expect(() => importHomeRecovery(home, 'config.json', flag.detectedAt, true)).toThrow();
  expect(readFileSync(home.workspaceConfig)).toEqual(live);
  acceptHomeRecovery(home, 'config.json', flag.detectedAt, true);
  expect(row(home)).toBeUndefined();
  expect(readFileSync(home.workspaceConfig)).toEqual(live);
});

it('reuses the base check on repeated polls and refreshes it when the retained copy changes', () => {
  const { legacy, home } = fixture();
  const hash = readMigrationRecord(home)!.files.find(file => file.path === 'config.json')!.hash!;
  const path = join(home.config, '.versions/config.json', hash);
  const bytes = readFileSync(path);
  writeFileSync(legacy.workspaceConfig, JSON.stringify({ ...base, late: true }));
  const read = vi.spyOn(fs, 'readFileSync');
  expect(row(home).canImport).toBe(true);
  expect(row(home).canImport).toBe(true);
  expect(read.mock.calls.filter(([file]) => file === path)).toHaveLength(1);
  rmSync(path);
  expect(row(home).canImport).toBe(false);
  writeFileSync(path, bytes);
  expect(row(home).canImport).toBe(true);
  writeFileSync(path, Buffer.alloc(bytes.length, '!')); // Same-size corruption invalidates the successful check.
  expect(row(home).canImport).toBe(false);
  expect(read.mock.calls.filter(([file]) => file === path)).toHaveLength(3);
});

it('retries a transient retained-base read failure without a metadata change', () => {
  const { legacy, home } = fixture();
  writeFileSync(legacy.workspaceConfig, JSON.stringify({ ...base, late: true }));
  vi.spyOn(VersionLog.prototype, 'recoveryBytes').mockImplementationOnce(() => {
    throw Object.assign(new Error('Temporary base read failure'), { code: 'EIO' });
  });
  expect(row(home).canImport).toBe(false);
  expect(row(home).canImport).toBe(true);
});

it('caches invalid JSON after successfully reading and verifying the retained bytes', () => {
  const { legacy, home, store } = fixture();
  const record = readMigrationRecord(home)!;
  const entry = record.files.find(file => file.path === 'config.json')!;
  const bytes = Buffer.from('{');
  entry.hash = digest(bytes);
  store.transaction(() => writeMigrationRecord(home, record), [home.workspaceConfig, home.workspaceUiState]);
  writeFileSync(join(home.config, '.versions/config.json', entry.hash!), bytes);
  writeFileSync(legacy.workspaceConfig, JSON.stringify({ ...base, late: true }));
  const read = vi.spyOn(VersionLog.prototype, 'recoveryBytes');
  expect(row(home).canImport).toBe(false);
  expect(row(home).canImport).toBe(false);
  expect(read).toHaveBeenCalledTimes(1);
});

it('rechecks the base at action time after offering Import', () => {
  const { legacy, home } = fixture();
  writeFileSync(legacy.workspaceConfig, JSON.stringify({ ...base, late: true }));
  const flag = row(home);
  expect(flag.canImport).toBe(true);
  const hash = readMigrationRecord(home)!.files.find(file => file.path === 'config.json')!.hash!;
  rmSync(join(home.config, '.versions/config.json', hash));
  expect(() => importHomeRecovery(home, 'config.json', flag.detectedAt, true)).toThrow(/merge base is missing/);
});

it('offers Ignore only for a deletion and does not delete the live registry', () => {
  const { legacy, home } = fixture();
  rmSync(legacy.workspaceConfig);
  expect(row(home)).toMatchObject({ canImport: false });
  expect(() => importHomeRecovery(home, 'config.json', row(home).detectedAt, true)).toThrow(/cannot be imported/);
  acceptHomeRecovery(home, 'config.json', row(home).detectedAt, true);
  expect(readMigrationRecord(home)!.files.find(file => file.path === 'config.json')).toMatchObject({ hash: null, mtimeMs: null });
  expect(JSON.parse(readFileSync(home.workspaceConfig, 'utf8'))).toEqual(base);
  expect(row(home)).toBeUndefined();
});

it('detects and imports later files after a FRESH migration decision', () => {
  const { legacy, home } = fixture(true);
  expect(readMigrationRecord(home)!.files).toEqual([]);
  writeFileSync(legacy.workspaceConfig, JSON.stringify(base));
  importHomeRecovery(home, 'config.json', row(home).detectedAt, true);
  expect(JSON.parse(readFileSync(home.workspaceConfig, 'utf8'))).toEqual(base);
  expect(row(home)).toBeUndefined();
});

it('does not offer opaque files or observed-only entries for import', () => {
  const { legacy, home } = fixture();
  const record = readMigrationRecord(home)!;
  record.files.find(file => file.path === 'config.json')!.target = null;
  new HomeStore(home).transaction(() => writeMigrationRecord(home, record), [home.workspaceConfig, home.workspaceUiState]);
  mkdirSync(join(legacy.root, 'versions'), { recursive: true });
  writeFileSync(join(legacy.root, 'versions', 'opaque.json'), '{}');
  writeFileSync(legacy.workspaceConfig, JSON.stringify({ late: true }));
  expect(getHomeRecovery(home, true).files).toEqual([]);
});

it('holds legacy watches only while subscribed and observes an older writer without a reload', async () => {
  const { legacy, home } = fixture();
  let ready!: () => void, changed!: () => void;
  const initial = new Promise<void>(resolve => { ready = resolve; });
  const observed = new Promise<void>(resolve => { changed = resolve; });
  const release = subscribeHomeRecovery(home, () => { ready(); if (row(home)) changed(); }, true);
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    await initial;
    writeFileSync(legacy.workspaceConfig, JSON.stringify({ ...base, late: true }));
    await Promise.race([observed, new Promise<never>((_, reject) => {
      // bound: filesystem delivery after the completed older-binary write; not a product delay.
      guard = setTimeout(() => reject(new Error('No legacy change signal')), 5000);
    })]);
    expect(row(home)).toMatchObject({ reason: 'legacy-change' });
  } finally { if (guard) clearTimeout(guard); release(); }
});

it('creates no legacy watcher with the shipped switch off', async () => {
  const { legacy, home } = fixture();
  const watch = vi.mocked(fs.watch);
  watch.mockClear();
  const release = subscribeHomeRecovery(home, () => {}, false);
  await Promise.resolve();
  release();
  expect(watch.mock.calls.some(([path]) => String(path).startsWith(legacy.root))).toBe(false);
});

async function filesystemSignal(signal: Promise<void>): Promise<void> {
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([signal, new Promise<never>((_, reject) => {
      // bound: actual filesystem delivery after a completed write, not a product delay.
      guard = setTimeout(() => reject(new Error('No legacy family change signal')), 5000);
    })]);
  } finally { if (guard) clearTimeout(guard); }
}

it.each(['remote-settings', 'server-instances'])('watches an empty legacy %s directory before its first file', async family => {
  const { legacy, home } = fixture(true);
  const directory = join(legacy.root, family);
  rmSync(directory, { recursive: true, force: true });
  const watch = vi.mocked(fs.watch);
  watch.mockClear();
  let ready!: () => void, rebound!: () => void, changed!: () => void;
  const initial = new Promise<void>(resolve => { ready = resolve; });
  const watching = new Promise<void>(resolve => { rebound = resolve; });
  const observed = new Promise<void>(resolve => { changed = resolve; });
  const file = `${family}/late.json`;
  const release = subscribeHomeRecovery(home, () => {
    ready();
    if (watch.mock.calls.some(([path]) => String(path) === directory)) rebound();
    if (row(home, file)) changed();
  }, true);
  try {
    await filesystemSignal(initial);
    mkdirSync(directory);
    expect(legacyWatchDirectories(home, true)).toContain(directory);
    await filesystemSignal(watching); // The root event has rebound to the empty family.
    writeFileSync(join(directory, 'late.json'), '{}');
    await filesystemSignal(observed);
    expect(row(home, file)).toMatchObject({ reason: 'legacy-change', canImport: true });
  } finally { release(); }
});

it('refuses Import before replacement when a required backup fails, but lets Ignore proceed', () => {
  const { legacy, home } = fixture();
  writeFileSync(legacy.workspaceConfig, JSON.stringify({ ...base, late: true }));
  const flag = row(home);
  const previous = readFileSync(home.workspaceConfig);
  const record = readFileSync(join(home.state, 'migration.json'));
  rmSync(home.backups, { recursive: true, force: true });
  writeFileSync(home.backups, 'a file blocks backup creation');
  expect(() => importHomeRecovery(home, 'config.json', flag.detectedAt, true)).toThrow(/backup.*unavailable/);
  expect(readFileSync(home.workspaceConfig)).toEqual(previous);
  expect(readFileSync(join(home.state, 'migration.json'))).toEqual(record);
  acceptHomeRecovery(home, 'config.json', flag.detectedAt, true);
  expect(row(home)).toBeUndefined();
});

it.each(['claude', 'omp'])('keeps the migration account path policy when importing a changed %s entry', provider => {
  const legacy = Home.sandbox(storeRoot(), { layout: 'legacy' });
  const home = Home.sandbox(storeRoot(), { layout: 'split' });
  const configDir = join(legacy.root, 'credentials', ...(provider === 'omp' ? ['profiles', 'work'] : ['work']));
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'auth.json'), '{}');
  const account = { id: 'work', provider, configDir, label: 'Original' };
  Home.seed(legacy, legacy.agentAccounts, { accounts: [account] });
  migrateLegacyHome(legacy, home);
  writeFileSync(legacy.agentAccounts, JSON.stringify({ accounts: [{ ...account, label: 'Imported' }] }));
  importHomeRecovery(home, 'agent-accounts.json', row(home, 'agent-accounts.json').detectedAt, true);
  expect(JSON.parse(readFileSync(home.agentAccounts, 'utf8')).accounts).toEqual([{ ...account, label: 'Imported',
    configDir: provider === 'omp' ? configDir : join(home.data, 'accounts', 'work') }]);
});

it('refuses a new legacy-internal account with no relocation and leaves Ignore available', () => {
  const { legacy, home } = fixture();
  mkdirSync(join(legacy.root, 'new-account'));
  writeFileSync(legacy.agentAccounts, JSON.stringify({ accounts: [{ id: 'new-account', provider: 'claude', configDir: join(legacy.root, 'new-account') }] }));
  const flag = row(home, 'agent-accounts.json');
  expect(() => importHomeRecovery(home, 'agent-accounts.json', flag.detectedAt, true)).toThrow(/account new-account.*no completed relocation/);
  acceptHomeRecovery(home, 'agent-accounts.json', flag.detectedAt, true);
  expect(row(home, 'agent-accounts.json')).toBeUndefined();
});

it('preserves top-level removal of the accounts key during import', () => {
  const legacy = Home.sandbox(storeRoot(), { layout: 'legacy' });
  const home = Home.sandbox(storeRoot(), { layout: 'split' });
  Home.seed(legacy, legacy.agentAccounts, { accounts: [{ id: 'external', provider: 'claude', configDir: '/external' }], kept: true });
  migrateLegacyHome(legacy, home);
  writeFileSync(legacy.agentAccounts, JSON.stringify({ kept: true }));
  importHomeRecovery(home, 'agent-accounts.json', row(home, 'agent-accounts.json').detectedAt, true);
  expect(JSON.parse(readFileSync(home.agentAccounts, 'utf8'))).toEqual({ kept: true });
});

it('keeps an untouched live account array as found when only another legacy key changed', () => {
  const legacy = Home.sandbox(storeRoot(), { layout: 'legacy' });
  const home = Home.sandbox(storeRoot(), { layout: 'split' });
  Home.seed(legacy, legacy.agentAccounts, { accounts: [], setting: 'base' });
  migrateLegacyHome(legacy, home);
  new HomeStore(home).writeJson(home.agentAccounts, { accounts: [null], setting: 'base' });
  writeFileSync(legacy.agentAccounts, JSON.stringify({ accounts: [], setting: 'legacy' }));
  importHomeRecovery(home, 'agent-accounts.json', row(home, 'agent-accounts.json').detectedAt, true);
  expect(JSON.parse(readFileSync(home.agentAccounts, 'utf8'))).toEqual({ accounts: [null], setting: 'legacy' });
});
