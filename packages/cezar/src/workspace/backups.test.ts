import { logPrefix } from '../home/display.ts';
import { Home } from '../home/home.ts';
import { homeFileLocation } from '../home/file-location.ts';
import { useTestHome } from '../home/test-home.testkit.ts';
import { testHome } from '../home/test-home.testkit.ts';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mergeWriteWorkspaceConfig, loadWorkspaceConfig } from './config.ts';
import { mergeWriteAgentAccounts, loadAgentAccounts } from './agent-accounts.ts';
import { listBackups as allBackups, isValidRestore } from './backups.ts';
import { runBackupCommand } from './backup-cli.ts';


// Rotation retains P0's guarantees. The separate .bak is now also listed for restore.
const listBackups: typeof allBackups = (file, home) => allBackups(file, home).filter(entry => entry.path !== join(typeof home === 'string' ? home : home.root, 'config.json.bak'));

let home: string;
const originalHome = process.env.CEZ_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cez-backups-'));
  useTestHome(home ? Home.sandbox(home) : undefined);
});
afterEach(() => {
  useTestHome(originalHome ? Home.sandbox(originalHome) : undefined);
  rmSync(home, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

it.each(['config.json', 'agent-accounts.json'] as const)('backs up changed %s once, and skips unchanged writes', async (file) => {
  const write = file === 'config.json' ? mergeWriteWorkspaceConfig : mergeWriteAgentAccounts;
  await write(() => undefined, testHome());
  expect(listBackups(file, testHome())).toEqual([]);
  const old = readFileSync(homeFileLocation(testHome(), file).path);
  await write((value) => { value.extra = 'changed'; }, testHome());
  const [entry] = listBackups(file, testHome());
  expect(listBackups(file, testHome())).toHaveLength(1);
  expect(readFileSync(entry!.path)).toEqual(old);
  expect(entry!.path).toContain(createHash('sha256').update(old).digest('hex').slice(0, 8));
  await write(() => undefined, testHome());
  expect(listBackups(file, testHome())).toHaveLength(1);
  if (process.platform !== 'win32') {
    expect(statSync(entry!.path).mode & 0o777).toBe(0o600);
    expect(statSync(testHome().backups).mode & 0o777).toBe(0o700);
    expect(statSync(join(testHome().backups, file)).mode & 0o777).toBe(0o700);
  }
});

it('prunes in the write: last 20 plus the newest per day within 30 days', () => {
  vi.useFakeTimers();
  const path = testHome().workspaceConfig;
  for (let day = 0; day < 40; day++) {
    for (let hour = 0; hour < 3; hour++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 0, day + 1, hour)));
      Home.seedBytes(testHome(), path, Buffer.from(`${JSON.stringify({ day, hour }, null, 2)}\n`));
    }
  }
  const retained = listBackups('config.json', testHome());
  const recent = retained.slice(0, 20);
  expect(recent).toHaveLength(20);
  const older = retained.slice(20);
  expect(new Set(older.map((entry) => entry.time.slice(0, 10))).size).toBe(older.length);
  expect(older.every((entry) => Date.parse(entry.time) >= Date.now() - 30 * 86_400_000)).toBe(true);
  // All days in range survive, including days older than the last 20 writes.
  expect(new Set(retained.map((entry) => entry.time.slice(0, 10))).size).toBe(31);
});

it('restores pre-change account JSON through the CLI and backs up the replaced version', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
  const old = { version: 1, accounts: [{ id: 'work', provider: 'claude', configDir: '/old/account' }], future: { token: 'fixture' } };
  Home.seedBytes(Home.sandbox(home), testHome().agentAccounts, Buffer.from(JSON.stringify(old)));
  await mergeWriteAgentAccounts((store) => { store.accounts = []; }, testHome());
  vi.setSystemTime(new Date('2026-11-02T00:00:00Z'));
  const replaced = readFileSync(testHome().agentAccounts);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runBackupCommand(['list', 'agent-accounts.json'], process.env, testHome())).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0])).toHaveLength(1);
  expect(await runBackupCommand(['restore', 'agent-accounts.json', '--at', '2026-11-01T00:00:00Z'], process.env, testHome())).toBe(0);
  expect((await loadAgentAccounts(testHome())).accounts[0]!.id).toBe('work');
  expect((await loadAgentAccounts(testHome())).future).toEqual(old.future);
  expect(listBackups('agent-accounts.json', testHome())).toHaveLength(2);
  expect(readFileSync(listBackups('agent-accounts.json', testHome())[0]!.path)).toEqual(replaced);
});

it('keeps config.json.bak recovery and restores an older registry without losing unknown fields', async () => {
  Home.seedBytes(Home.sandbox(home), testHome().workspaceConfig, Buffer.from(JSON.stringify({ projects: [], future: 'old' })));
  await mergeWriteWorkspaceConfig((config) => { config.future = 'new'; }, testHome());
  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runBackupCommand(['restore', 'config.json', '--at', listBackups('config.json', testHome())[0]!.time], process.env, testHome())).toBe(0);
  expect((await loadWorkspaceConfig(testHome().workspaceConfig)).future).toBe('old');
  expect(JSON.parse(readFileSync(`${testHome().workspaceConfig}.bak`, 'utf8')).future).toBe('old');
});

it('creates a missing backup directory and warns once for an unusable one without blocking writes', async () => {
  await mergeWriteWorkspaceConfig(() => undefined, testHome());
  mkdirSync(dirname(testHome().backups), { recursive: true });
  writeFileSync(testHome().backups, 'not a directory');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await mergeWriteWorkspaceConfig((value) => { value.extra = 1; }, testHome());
  await mergeWriteWorkspaceConfig((value) => { value.extra = 2; }, testHome());
  // The primary and its .bak each warn once; neither auxiliary failure blocks the save.
  expect(warning).toHaveBeenCalledTimes(2);
  expect((await loadWorkspaceConfig(testHome().workspaceConfig)).extra).toBe(2);
  rmSync(testHome().backups);
  await mergeWriteWorkspaceConfig((value) => { value.extra = 3; }, testHome());
  expect(listBackups('config.json', testHome())).toHaveLength(1);
});

it('backs up ui-state and leaves account config directories outside backup scope', () => {
  mkdirSync(join(home, 'claude-work'));
  Home.seed(testHome(), testHome().workspaceUiState, { tab: 1 });
  Home.seed(testHome(), testHome().workspaceUiState, { tab: 2 });
  expect(listBackups(undefined, testHome()).map(entry => entry.file)).toEqual(['ui-state.json']);
});

it.each([['restore', '../config.json'], ['restore', 'config.json', '--at', 'invalid'], ['restore', 'config.json'], ['list', 'config.json', '--at', '2026-01-01']])('rejects invalid or unavailable backups: %j', async (...args) => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await runBackupCommand(args, process.env, testHome())).toBe(1);
});


it('orders same-clock writes and keeps a snapshot for repeated content', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
  await mergeWriteAgentAccounts((store) => { store.marker = 'a'; }, testHome());
  await mergeWriteAgentAccounts((store) => { store.marker = 'b'; }, testHome());
  await mergeWriteAgentAccounts((store) => { store.marker = 'a'; }, testHome());
  await mergeWriteAgentAccounts((store) => { store.marker = 'c'; }, testHome());
  await mergeWriteAgentAccounts((store) => { store.marker = 'd'; }, testHome());
  const snapshots = listBackups('agent-accounts.json', testHome());
  expect(snapshots).toHaveLength(4);
  expect(snapshots.map((entry) => JSON.parse(readFileSync(entry.path, 'utf8')).marker)).toEqual(['c', 'a', 'b', 'a']);
  expect(new Set(snapshots.map((entry) => entry.time)).size).toBe(4);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runBackupCommand(['restore', 'agent-accounts.json'], process.env, testHome())).toBe(0);
  expect((await loadAgentAccounts(testHome())).marker).toBe('c');
  expect(listBackups('agent-accounts.json', testHome())).toHaveLength(5);
});

it('rejects a zone-less restore time without changing live JSON', async () => {
  await mergeWriteAgentAccounts((store) => { store.marker = 'before'; }, testHome());
  await mergeWriteAgentAccounts((store) => { store.marker = 'after'; }, testHome());
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await runBackupCommand(['restore', 'agent-accounts.json', '--at', '2026-11-01T00:00:00'], process.env, testHome())).toBe(1);
  expect(error).toHaveBeenCalledWith('Invalid --at time; use an ISO UTC time');
  expect((await loadAgentAccounts(testHome())).marker).toBe('after');
});

it.each(['config.json', 'agent-accounts.json'] as const)('warns when restoring %s drops invalid snapshot rows', async (file) => {
  const key = file === 'config.json' ? 'projects' : 'accounts';
  Home.seedBytes(Home.sandbox(home), homeFileLocation(testHome(), file).path, Buffer.from(JSON.stringify({ [key]: [{ broken: true }], future: 'preserved' })));
  const write = file === 'config.json' ? mergeWriteWorkspaceConfig : mergeWriteAgentAccounts;
  await write((value) => { value.future = 'new'; }, testHome());
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runBackupCommand(['restore', file, '--at', listBackups(file, testHome())[0]!.time], process.env, testHome())).toBe(0);
  expect(warning).toHaveBeenCalledWith(`${logPrefix()} restore dropped 1 invalid ${key} entries from the snapshot`);
  expect(JSON.parse(readFileSync(homeFileLocation(testHome(), file).path, 'utf8')).future).toBe('preserved');
});

it('ignores incomplete or changed snapshots when listing and selecting a restore', async () => {
  await mergeWriteAgentAccounts((store) => { store.marker = 'original'; }, testHome());
  await mergeWriteAgentAccounts((store) => { store.marker = 'second'; }, testHome());
  const good = listBackups('agent-accounts.json', testHome())[0]!;
  const dir = join(testHome().backups, 'agent-accounts.json');
  writeFileSync(join(dir, '2099-01-01T00-00-00.000Z-deadbeef.json'), '{');
  writeFileSync(join(dir, 'unfinished.tmp'), '{');
  expect(listBackups('agent-accounts.json', testHome())).toEqual([good]);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runBackupCommand(['restore', 'agent-accounts.json'], process.env, testHome())).toBe(0);
  expect((await loadAgentAccounts(testHome())).marker).toBe('original');
});


it('cleans a failed partial staging write without publishing it or blocking the live write', async () => {
  await mergeWriteWorkspaceConfig(() => undefined, testHome());
  const original = fs.writeFileSync;
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(fs, 'writeFileSync').mockImplementation((path, data, options) => {
    if (dirname(String(path)) === join(testHome().backups, 'config.json') && String(path).endsWith('.tmp')) {
      original(path, '{', options);
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    }
    original(path, data, options);
  });
  syncBuiltinESMExports();
  await mergeWriteWorkspaceConfig((config) => { config.marker = 'saved'; }, testHome());
  expect((await loadWorkspaceConfig(testHome().workspaceConfig)).marker).toBe('saved');
  expect(listBackups('config.json', testHome())).toEqual([]);
  expect(fs.readdirSync(join(testHome().backups, 'config.json'))).toEqual([]);
  expect(warning).toHaveBeenCalledTimes(1);
});

it('publishes only completed staging bytes and retries an exclusive publication collision', async () => {
  await mergeWriteWorkspaceConfig(() => undefined, testHome());
  const previous = readFileSync(testHome().workspaceConfig);
  const link = fs.linkSync;
  let attempts = 0;
  vi.spyOn(fs, 'linkSync').mockImplementation((stage, target) => {
    if (dirname(String(target)) !== join(testHome().backups, 'config.json')) { link(stage, target); return; }
    expect(readFileSync(stage)).toEqual(previous);
    expect(listBackups('config.json', testHome())).toEqual([]);
    if (attempts++ === 0) throw Object.assign(new Error('collision'), { code: 'EEXIST' });
    link(stage, target);
  });
  syncBuiltinESMExports();
  await mergeWriteWorkspaceConfig((config) => { config.marker = 'changed'; }, testHome());
  expect(attempts).toBe(2);
  const snapshots = listBackups('config.json', testHome());
  expect(snapshots).toHaveLength(1);
  expect(readFileSync(snapshots[0]!.path)).toEqual(previous);
  expect(fs.readdirSync(join(testHome().backups, 'config.json'))).toHaveLength(1);
});

it('the home entry calls an argument list a restore exactly when the command restores', async () => {
  await mergeWriteAgentAccounts((store) => { store.marker = 'a'; }, testHome());
  await mergeWriteAgentAccounts((store) => { store.marker = 'b'; }, testHome());
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const forms = [['restore', 'agent-accounts.json'], ['restore', 'agent-accounts.json', '--at', '2099-01-01T00:00:00Z'],
    ['restore', 'agent-accounts.json', '--at=2099-01-01T00:00:00.000Z'], ['restore', 'agent-accounts.json', '--at', 'yesterday'],
    ['restore', 'invalid.json'], ['restore'], ['restore', 'agent-accounts.json', 'extra'], ['restore', 'agent-accounts.json', '-h'],
    ['restore', 'agent-accounts.json', '--unknown'], ['list', 'agent-accounts.json'], ['agent-accounts.json', 'restore']];
  for (const argv of forms) {
    log.mockClear();
    await runBackupCommand(argv, process.env, testHome());
    const restored = log.mock.calls.some(([line]) => String(line).startsWith('Restored '));
    expect(isValidRestore(argv), argv.join(' ')).toBe(restored);
  }
});
