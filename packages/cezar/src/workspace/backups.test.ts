import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mergeWriteWorkspaceConfig, loadWorkspaceConfig, atomicWriteJsonSync } from './config.ts';
import { mergeWriteAgentAccounts, loadAgentAccounts } from './agent-accounts.ts';
import { backupBeforeWrite, listBackups } from './backups.ts';
import { runBackupCommand } from './backup-cli.ts';

vi.mock('node:fs', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs')>() }));

let home: string;
const originalHome = process.env.CEZ_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cez-backups-'));
  process.env.CEZ_HOME = home;
});
afterEach(() => {
  process.env.CEZ_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(['config.json', 'agent-accounts.json'] as const)('backs up changed %s once, and skips unchanged writes', async (file) => {
  const write = file === 'config.json' ? mergeWriteWorkspaceConfig : mergeWriteAgentAccounts;
  await write(() => undefined);
  expect(listBackups(file)).toEqual([]);
  const old = readFileSync(join(home, file));
  await write((value) => { value.extra = 'changed'; });
  const [entry] = listBackups(file);
  expect(listBackups(file)).toHaveLength(1);
  expect(readFileSync(entry!.path)).toEqual(old);
  expect(entry!.path).toContain(createHash('sha256').update(old).digest('hex').slice(0, 8));
  await write(() => undefined);
  expect(listBackups(file)).toHaveLength(1);
  if (process.platform !== 'win32') {
    expect(statSync(entry!.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'backups')).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, 'backups', file)).mode & 0o777).toBe(0o700);
  }
});

it('prunes in the write: last 20 plus the newest per day within 30 days', () => {
  vi.useFakeTimers();
  const path = join(home, 'config.json');
  for (let day = 0; day < 40; day++) {
    for (let hour = 0; hour < 3; hour++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 0, day + 1, hour)));
      backupBeforeWrite(path, { day, hour });
      atomicWriteJsonSync(path, { day, hour });
    }
  }
  const retained = listBackups('config.json');
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
  writeFileSync(join(home, 'agent-accounts.json'), JSON.stringify(old));
  await mergeWriteAgentAccounts((store) => { store.accounts = []; });
  vi.setSystemTime(new Date('2026-11-02T00:00:00Z'));
  const replaced = readFileSync(join(home, 'agent-accounts.json'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runBackupCommand(['list', 'agent-accounts.json'], process.env)).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0])).toHaveLength(1);
  expect(await runBackupCommand(['restore', 'agent-accounts.json', '--at', '2026-11-01T00:00:00Z'], process.env)).toBe(0);
  expect((await loadAgentAccounts()).accounts[0]!.id).toBe('work');
  expect((await loadAgentAccounts()).future).toEqual(old.future);
  expect(listBackups('agent-accounts.json')).toHaveLength(2);
  expect(readFileSync(listBackups('agent-accounts.json')[0]!.path)).toEqual(replaced);
});

it('keeps config.json.bak recovery and restores an older registry without losing unknown fields', async () => {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ projects: [], future: 'old' }));
  await mergeWriteWorkspaceConfig((config) => { config.future = 'new'; });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runBackupCommand(['restore', 'config.json'], process.env)).toBe(0);
  expect((await loadWorkspaceConfig()).future).toBe('old');
  expect(JSON.parse(readFileSync(join(home, 'config.json.bak'), 'utf8')).future).toBe('old');
});

it('creates a missing backup directory and warns once for an unusable one without blocking writes', async () => {
  await mergeWriteWorkspaceConfig(() => undefined);
  writeFileSync(join(home, 'backups'), 'not a directory');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await mergeWriteWorkspaceConfig((value) => { value.extra = 1; });
  await mergeWriteWorkspaceConfig((value) => { value.extra = 2; });
  expect(warning).toHaveBeenCalledTimes(1);
  expect((await loadWorkspaceConfig()).extra).toBe(2);
  rmSync(join(home, 'backups'));
  await mergeWriteWorkspaceConfig((value) => { value.extra = 3; });
  expect(listBackups('config.json')).toHaveLength(1);
});

it('does not back up ui-state or account config directories', () => {
  mkdirSync(join(home, 'claude-work'));
  atomicWriteJsonSync(join(home, 'ui-state.json'), { tab: 1 });
  atomicWriteJsonSync(join(home, 'ui-state.json'), { tab: 2 });
  expect(listBackups()).toEqual([]);
});

it.each([['restore', '../config.json'], ['restore', 'config.json', '--at', 'invalid'], ['restore', 'config.json'], ['list', 'config.json', '--at', '2026-01-01']])('rejects invalid or unavailable backups: %j', async (...args) => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await runBackupCommand(args, process.env)).toBe(1);
});


it('orders same-clock writes and keeps a snapshot for repeated content', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
  await mergeWriteAgentAccounts((store) => { store.marker = 'a'; });
  await mergeWriteAgentAccounts((store) => { store.marker = 'b'; });
  await mergeWriteAgentAccounts((store) => { store.marker = 'a'; });
  await mergeWriteAgentAccounts((store) => { store.marker = 'c'; });
  await mergeWriteAgentAccounts((store) => { store.marker = 'd'; });
  const snapshots = listBackups('agent-accounts.json');
  expect(snapshots).toHaveLength(4);
  expect(snapshots.map((entry) => JSON.parse(readFileSync(entry.path, 'utf8')).marker)).toEqual(['c', 'a', 'b', 'a']);
  expect(new Set(snapshots.map((entry) => entry.time)).size).toBe(4);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runBackupCommand(['restore', 'agent-accounts.json'], process.env)).toBe(0);
  expect((await loadAgentAccounts()).marker).toBe('c');
  expect(listBackups('agent-accounts.json')).toHaveLength(5);
});

it('rejects a zone-less restore time without changing live JSON', async () => {
  await mergeWriteAgentAccounts((store) => { store.marker = 'before'; });
  await mergeWriteAgentAccounts((store) => { store.marker = 'after'; });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await runBackupCommand(['restore', 'agent-accounts.json', '--at', '2026-11-01T00:00:00'], process.env)).toBe(1);
  expect(error).toHaveBeenCalledWith('Invalid --at time; use an ISO UTC time');
  expect((await loadAgentAccounts()).marker).toBe('after');
});

it.each(['config.json', 'agent-accounts.json'] as const)('warns when restoring %s drops invalid snapshot rows', async (file) => {
  const key = file === 'config.json' ? 'projects' : 'accounts';
  writeFileSync(join(home, file), JSON.stringify({ [key]: [{ broken: true }], future: 'preserved' }));
  const write = file === 'config.json' ? mergeWriteWorkspaceConfig : mergeWriteAgentAccounts;
  await write((value) => { value.future = 'new'; });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runBackupCommand(['restore', file], process.env)).toBe(0);
  expect(warning).toHaveBeenCalledWith(`[cez] restore dropped 1 invalid ${key} entries from the snapshot`);
  expect(JSON.parse(readFileSync(join(home, file), 'utf8')).future).toBe('preserved');
});

it('ignores incomplete or changed snapshots when listing and selecting a restore', async () => {
  await mergeWriteAgentAccounts((store) => { store.marker = 'original'; });
  await mergeWriteAgentAccounts((store) => { store.marker = 'second'; });
  const good = listBackups('agent-accounts.json')[0]!;
  const dir = join(home, 'backups', 'agent-accounts.json');
  writeFileSync(join(dir, '2099-01-01T00-00-00.000Z-deadbeef.json'), '{');
  writeFileSync(join(dir, 'unfinished.tmp'), '{');
  expect(listBackups('agent-accounts.json')).toEqual([good]);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runBackupCommand(['restore', 'agent-accounts.json'], process.env)).toBe(0);
  expect((await loadAgentAccounts()).marker).toBe('original');
});


it('cleans a failed partial staging write without publishing it or blocking the live write', async () => {
  await mergeWriteWorkspaceConfig(() => undefined);
  const original = fs.writeFileSync;
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(fs, 'writeFileSync').mockImplementation((path, data, options) => {
    if (dirname(String(path)) === join(home, 'backups', 'config.json') && String(path).endsWith('.tmp')) {
      original(path, '{', options);
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    }
    original(path, data, options);
  });
  await mergeWriteWorkspaceConfig((config) => { config.marker = 'saved'; });
  expect((await loadWorkspaceConfig()).marker).toBe('saved');
  expect(listBackups('config.json')).toEqual([]);
  expect(fs.readdirSync(join(home, 'backups', 'config.json'))).toEqual([]);
  expect(warning).toHaveBeenCalledTimes(1);
});

it('publishes only completed staging bytes and retries an exclusive publication collision', async () => {
  await mergeWriteWorkspaceConfig(() => undefined);
  const previous = readFileSync(join(home, 'config.json'));
  const link = fs.linkSync;
  let attempts = 0;
  vi.spyOn(fs, 'linkSync').mockImplementation((stage, target) => {
    expect(readFileSync(stage)).toEqual(previous);
    expect(listBackups('config.json')).toEqual([]);
    if (attempts++ === 0) throw Object.assign(new Error('collision'), { code: 'EEXIST' });
    link(stage, target);
  });
  await mergeWriteWorkspaceConfig((config) => { config.marker = 'changed'; });
  expect(attempts).toBe(2);
  const snapshots = listBackups('config.json');
  expect(snapshots).toHaveLength(1);
  expect(readFileSync(snapshots[0]!.path)).toEqual(previous);
  expect(fs.readdirSync(join(home, 'backups', 'config.json'))).toHaveLength(1);
});
