import { homeFileLocation } from './file-location.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Home } from './home.ts';
import { HomeStore } from './store.ts';
import { VersionLog } from './version-log.ts';
import { acceptHomeRecovery, getHomeRecovery, restoreHomeRecovery } from './recovery.ts';
import { subscribeHomeRecovery } from './recovery-watch.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { cleanStoreRoots, storeRoot } from './store.testkit.ts';

afterEach(() => { vi.restoreAllMocks(); cleanStoreRoots(); });

it('leaves absent optional files untracked during repeated recovery snapshots', () => {
  const home = Home.sandbox(storeRoot());
  Home.seed(home, home.workspaceConfig, { projects: [{ id: 'normal', root: '/normal' }] });
  expect(getHomeRecovery(home)).toEqual({ files: [] });
  expect(getHomeRecovery(home)).toEqual({ files: [] });
  for (const file of ['agent-accounts.json', 'ui-state.json', 'server.json', 'server.install.lock']) {
    expect(existsSync(join(homeFileLocation(home, file).root, '.versions', file))).toBe(false);
  }
});

it.each(['before pending', 'after pending'] as const)('does not report a reset when a write fails %s and leaves the registry unchanged', phase => {
  const home = Home.sandbox(storeRoot());
  Home.seed(home, home.agentAccounts, { accounts: [{ id: 'preserved' }] });
  const original = readFileSync(home.agentAccounts);
  if (phase === 'before pending') {
    vi.spyOn(VersionLog.prototype, 'replace').mockImplementationOnce(() => { throw new Error('crash before pending'); });
  } else {
    const setRecord = VersionLog.prototype.setRecord;
    vi.spyOn(VersionLog.prototype, 'setRecord').mockImplementation(function (this: VersionLog, name, record) {
      setRecord.call(this, name, record);
      if (name === 'PENDING') throw new Error('crash after pending');
    });
  }
  expect(() => new HomeStore(home).writeJson(home.agentAccounts, { accounts: [] })).toThrow('crash');
  vi.restoreAllMocks();
  expect(readFileSync(home.agentAccounts)).toEqual(original);
  expect(getHomeRecovery(home)).toEqual({ files: [] });
});

it('keeps a reset recoverable after replacement succeeds and advancing HEAD fails', async () => {
  const home = Home.sandbox(storeRoot());
  Home.seed(home, home.agentAccounts, { accounts: [{ id: 'before-crash' }] });
  const original = readFileSync(home.agentAccounts);
  const setRecord = VersionLog.prototype.setRecord;
  vi.spyOn(VersionLog.prototype, 'setRecord').mockImplementation(function (this: VersionLog, name, record) {
    if (name === 'HEAD') throw new Error('crash before HEAD');
    setRecord.call(this, name, record);
  });
  expect(() => new HomeStore(home).writeJson(home.agentAccounts, { accounts: [] })).toThrow('crash before HEAD');
  vi.restoreAllMocks();
  expect(JSON.parse(readFileSync(home.agentAccounts, 'utf8')).accounts).toEqual([]);
  expect(getHomeRecovery(home).files).toContainEqual(expect.objectContaining({ file: 'agent-accounts.json', reason: 'reset', canRestore: true }));
  await restoreHomeRecovery(home, 'agent-accounts.json');
  expect(readFileSync(home.agentAccounts)).toEqual(original);
});

it('keeps acceptance across settings writes to an empty registry and still detects a later real reset', () => {
  const home = Home.sandbox(storeRoot());
  const store = new HomeStore(home);
  Home.seed(home, home.workspaceConfig, { projects: [] });
  Home.seed(home, `${home.workspaceConfig}.bak`, { projects: [{ id: 'historical', root: '/historical' }] });
  expect(getHomeRecovery(home).files).toHaveLength(1);
  acceptHomeRecovery(home, 'config.json');
  store.writeJson(home.workspaceConfig, { projects: [], settingsChanged: true });
  expect(getHomeRecovery(home)).toEqual({ files: [] });
  store.writeJson(home.workspaceConfig, { projects: [{ id: 'new', root: '/new' }] });
  store.writeJson(home.workspaceConfig, { projects: [], settingsChanged: 'again' });
  expect(getHomeRecovery(home).files).toContainEqual(expect.objectContaining({ file: 'config.json', reason: 'reset' }));
});

it.each(['projects', 'accounts'] as const)('preserves a later %s reset when a crash leaves an earlier empty acceptance', async key => {
  const home = Home.sandbox(storeRoot());
  const path = key === 'projects' ? home.workspaceConfig : home.agentAccounts;
  const file = key === 'projects' ? 'config.json' : 'agent-accounts.json';
  const store = new HomeStore(home);
  Home.seed(home, path, { [key]: [] });
  store.acceptOutsideWrite(path);
  vi.spyOn(VersionLog.prototype, 'clearRecovery').mockImplementationOnce(() => { throw new Error('crash before acceptance advances'); });
  expect(() => store.writeJson(path, { [key]: [{ id: 'preserved' }] })).toThrow('crash');
  vi.restoreAllMocks();
  const original = readFileSync(path);
  store.writeJson(path, { [key]: [] });
  const incident = getHomeRecovery(home).files.find(entry => entry.file === file)!;
  expect(incident).toMatchObject({ reason: 'reset', canRestore: true });
  store.writeJson(path, { [key]: [], settingsChanged: true });
  expect(getHomeRecovery(home).files).toContainEqual(incident);
  await restoreHomeRecovery(home, file, incident.detectedAt);
  expect(readFileSync(path)).toEqual(original);
  expect(getHomeRecovery(home)).toEqual({ files: [] });
});

it.each(['missing', 'corrupt'] as const)('invalidates cached restore availability when pinned content becomes %s', async fault => {
  const home = Home.sandbox(storeRoot());
  Home.seed(home, home.workspaceUiState, { saved: true });
  writeFileSync(home.workspaceUiState, '{"outside":true}'); // Deliberate outside writer creates the recovery incident.
  expect(getHomeRecovery(home).files).toContainEqual(expect.objectContaining({ file: 'ui-state.json', canRestore: true }));
  getHomeRecovery(home); // Cache the available pinned target before changing its bytes.
  const directory = join(home.state, '.versions', 'ui-state.json');
  const flag = JSON.parse(readFileSync(join(directory, 'OUTSIDE'), 'utf8')) as { restoreHash: string };
  const pinned = join(directory, flag.restoreHash);
  if (fault === 'missing') rmSync(pinned);
  else writeFileSync(pinned, Buffer.alloc(readFileSync(pinned).length, 120)); // Same-size in-place corruption must invalidate the cached target.
  expect(getHomeRecovery(home).files).toContainEqual(expect.objectContaining({ file: 'ui-state.json', reason: 'outside-write', canRestore: false }));
  await expect(restoreHomeRecovery(home, 'ui-state.json')).rejects.toThrow(/Missing or corrupt pinned/);
  expect(readFileSync(home.workspaceUiState, 'utf8')).toBe('{"outside":true}');
  acceptHomeRecovery(home, 'ui-state.json');
  expect(getHomeRecovery(home)).toEqual({ files: [] });
});

it('refreshes config.json.bak when restoring a registry reset after its normal writer empties both files', async () => {
  const home = Home.sandbox(storeRoot());
  await mergeWriteWorkspaceConfig(config => { config.projects.push({ id: 'saved', root: '/saved', name: 'Saved', addedAt: '', lastOpenedAt: '', source: 'local' }); }, home);
  await mergeWriteWorkspaceConfig(config => { config.projects = []; }, home);
  expect(JSON.parse(readFileSync(`${home.workspaceConfig}.bak`, 'utf8')).projects).toEqual([]);
  await restoreHomeRecovery(home, 'config.json');
  const restored = JSON.parse(readFileSync(home.workspaceConfig, 'utf8')) as { projects: Array<{ id: string }> };
  expect(restored.projects.map(project => project.id)).toEqual(['saved']);
  expect(JSON.parse(readFileSync(`${home.workspaceConfig}.bak`, 'utf8'))).toEqual(restored);
  expect(getHomeRecovery(home)).toEqual({ files: [] });
});

it('invalidates the metadata cache when an outside write preserves file size and mtime', () => {
  const home = Home.sandbox(storeRoot());
  Home.seedBytes(home, home.workspaceUiState, Buffer.from('{"value":"old"}'));
  getHomeRecovery(home);
  getHomeRecovery(home);
  const before = statSync(home.workspaceUiState);
  writeFileSync(home.workspaceUiState, '{"value":"new"}'); // Deliberate outside write preserves the serialized size.
  utimesSync(home.workspaceUiState, before.atime, before.mtime); // A restored mtime must not hide the changed ctime.
  expect(getHomeRecovery(home).files).toContainEqual(expect.objectContaining({ file: 'ui-state.json', reason: 'outside-write' }));
});

it('publishes acceptance from another process when only its journal changes', async () => {
  const home = Home.sandbox(storeRoot());
  Home.seed(home, home.workspaceUiState, { initial: true });
  writeFileSync(home.workspaceUiState, '{"accepted":true}'); // Deliberate outside write is accepted by the other process below.
  getHomeRecovery(home);
  getHomeRecovery(home);
  let initial!: () => void;
  const ready = new Promise<void>(resolve => { initial = resolve; });
  let accepted!: () => void;
  const resolved = new Promise<void>(resolve => { accepted = resolve; });
  const unsubscribe = subscribeHomeRecovery(home, () => {
    const snapshot = getHomeRecovery(home);
    initial();
    if (snapshot.files.length === 0) accepted();
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await ready;
    const before = statSync(home.workspaceUiState).mtimeMs;
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      'const { HomeStore } = await import(process.argv[1]); const { Home } = await import(process.argv[4]); new HomeStore(Home.sandbox(process.argv[2])).acceptOutsideWrite(process.argv[3]);',
      new URL('./store.ts', import.meta.url).href, home.rootOverride ?? home.root, home.workspaceUiState, new URL('./home.ts', import.meta.url).href]);
    await Promise.race([resolved, new Promise<never>((_, reject) => {
      // bound: fs.watch must publish the other process's completed journal-only acceptance; the timeout guards a missing signal.
      timeout = setTimeout(() => reject(new Error('No journal-only acceptance signal')), 5000);
    })]);
    expect(statSync(home.workspaceUiState).mtimeMs).toBe(before);
    expect(readFileSync(home.workspaceUiState, 'utf8')).toBe('{"accepted":true}');
    expect(getHomeRecovery(home)).toEqual({ files: [] });
  } finally {
    if (timeout) clearTimeout(timeout);
    unsubscribe();
  }
});

it('keeps an accepted empty registry clear after a settings commit crashes before acceptance metadata advances', () => {
  const home = Home.sandbox(storeRoot());
  const store = new HomeStore(home);
  Home.seed(home, home.workspaceConfig, { projects: [] });
  Home.seed(home, `${home.workspaceConfig}.bak`, { projects: [{ id: 'stale', root: '/stale' }] });
  expect(getHomeRecovery(home).files).toHaveLength(1);
  acceptHomeRecovery(home, 'config.json');
  vi.spyOn(VersionLog.prototype, 'clearRecovery').mockImplementationOnce(() => { throw new Error('crash after primary commit'); });
  expect(() => store.writeJson(home.workspaceConfig, { projects: [], changedPreference: true })).toThrow('crash after primary commit');
  vi.restoreAllMocks();
  expect(JSON.parse(readFileSync(home.workspaceConfig, 'utf8'))).toEqual({ projects: [], changedPreference: true });
  expect(getHomeRecovery(home)).toEqual({ files: [] });
  store.writeJson(home.workspaceConfig, { projects: [{ id: 'later', root: '/later' }] });
  store.writeJson(home.workspaceConfig, { projects: [] });
  expect(getHomeRecovery(home).files).toContainEqual(expect.objectContaining({ file: 'config.json', reason: 'reset' }));
});

it('keeps an earlier unresolved reset after restoring a later outside write', async () => {
  const home = Home.sandbox(storeRoot());
  Home.seed(home, home.workspaceConfig, { projects: [{ id: 'kept', root: '/kept' }] });
  await mergeWriteWorkspaceConfig(config => { config.projects = []; }, home);
  writeFileSync(home.workspaceConfig, '{"outside":true}'); // A separate incident follows the unresolved reset.
  expect(getHomeRecovery(home).files).toContainEqual(expect.objectContaining({ file: 'config.json', reason: 'outside-write' }));
  await restoreHomeRecovery(home, 'config.json');
  expect(getHomeRecovery(home).files).toContainEqual(expect.objectContaining({ file: 'config.json', reason: 'reset' }));
  await restoreHomeRecovery(home, 'config.json');
  expect(JSON.parse(readFileSync(home.workspaceConfig, 'utf8')).projects).toContainEqual(expect.objectContaining({ id: 'kept' }));
  expect(getHomeRecovery(home)).toEqual({ files: [] });
});

it.each(['restore', 'accept'] as const)('makes a repeated %s after a lost response a no-op', async action => {
  const home = Home.sandbox(storeRoot());
  Home.seed(home, home.workspaceUiState, { original: true });
  writeFileSync(home.workspaceUiState, '{"outside":true}'); // Deliberate outside write creates one incident.
  const incident = getHomeRecovery(home).files[0]!;
  const resolve = action === 'restore' ? restoreHomeRecovery : acceptHomeRecovery;
  await resolve(home, incident.file, incident.detectedAt);
  const committed = readFileSync(home.workspaceUiState);
  const modified = statSync(home.workspaceUiState).mtimeMs;
  await resolve(home, incident.file, incident.detectedAt); // Retry after the first response was lost.
  expect(readFileSync(home.workspaceUiState)).toEqual(committed);
  expect(statSync(home.workspaceUiState).mtimeMs).toBe(modified);
  expect(getHomeRecovery(home)).toEqual({ files: [] });
});

it.each(['restore', 'accept'] as const)('refuses a stale second cockpit %s for a newer incident', async action => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(new Date('2026-11-07T09:00:00Z'));
    const home = Home.sandbox(storeRoot());
    Home.seed(home, home.workspaceUiState, { original: true });
    writeFileSync(home.workspaceUiState, '{"outside":"first"}'); // Deliberate first incident.
    const old = getHomeRecovery(home).files[0]!;
    await restoreHomeRecovery(home, old.file, old.detectedAt);
    vi.setSystemTime(new Date('2026-11-07T09:00:01Z'));
    const newer = '{"outside":"second"}';
    writeFileSync(home.workspaceUiState, newer); // A separate incident follows the first resolution.
    const current = getHomeRecovery(home).files[0]!;
    expect(current.detectedAt).not.toBe(old.detectedAt);
    const resolve = action === 'restore' ? restoreHomeRecovery : acceptHomeRecovery;
    await expect(async () => { await resolve(home, old.file, old.detectedAt); }).rejects.toThrow('Recovery incident changed');
    expect(readFileSync(home.workspaceUiState, 'utf8')).toBe(newer);
    expect(getHomeRecovery(home).files).toEqual([current]);
  } finally { vi.useRealTimers(); }
});
