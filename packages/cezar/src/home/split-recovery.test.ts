import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Home } from './home.ts';
import { homeFileLocation } from './file-location.ts';
import { getHomeRecovery, recoveryFiles, restoreHomeRecovery } from './recovery.ts';
import { subscribeHomeRecovery } from './recovery-watch.ts';
import { HomeStore } from './store.ts';
import { digest, VersionLog } from './version-log.ts';
import { cleanStoreRoots, storeRoot } from './store.testkit.ts';

afterEach(() => { vi.restoreAllMocks(); cleanStoreRoots(); });

it.each(['remote-settings/4321.json', 'server-instances/named.json', 'server-instances/named.install.lock'])('finds deleted split %s through its journal', async file => {
  const home = Home.sandbox(storeRoot(), { layout: 'split' });
  const { path } = homeFileLocation(home, file);
  Home.seed(home, path, { saved: true });
  rmSync(path); // Outside deletion must remain visible after directory discovery loses the file.
  expect(recoveryFiles(home)).toContain(file);
  expect(getHomeRecovery(home).files).toContainEqual(expect.objectContaining({ file, reason: 'outside-write' }));
  await restoreHomeRecovery(home, file);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ saved: true });
});

it('finds a config reset from rotations in state when no .bak exists', () => {
  const home = Home.sandbox(storeRoot(), { layout: 'split' });
  const store = new HomeStore(home);
  Home.seed(home, home.workspaceConfig, { projects: [{ id: 'saved', root: '/saved' }] });
  store.writeJson(home.workspaceConfig, { projects: [] });
  rmSync(join(home.config, '.versions/config.json/RESET')); // Model an empty registry with only a retained backup.
  expect(existsSync(`${home.workspaceConfig}.bak`)).toBe(false);
  expect(getHomeRecovery(home).files).toContainEqual(expect.objectContaining({ file: 'config.json', reason: 'reset', canRestore: true }));
});

it.each(['config.json', 'server.json'])('watches live bytes and journal-only acceptance for split %s', async file => {
  const home = Home.sandbox(storeRoot(), { layout: 'split' });
  const { path } = homeFileLocation(home, file);
  Home.seed(home, path, { saved: true });
  let ready!: () => void;
  const initial = new Promise<void>(resolve => { ready = resolve; });
  let signal!: () => void;
  let expected: 'outside-write' | undefined = 'outside-write';
  const outside = new Promise<void>(resolve => { signal = resolve; });
  const unsubscribe = subscribeHomeRecovery(home, () => {
    const state = getHomeRecovery(home).files.find(entry => entry.file === file);
    ready();
    if (state?.reason === expected) signal();
  });
  try {
    await initial;
    writeFileSync(path, '{"outside":true}'); // No process-local HomeStore event; the watch must detect it.
    await boundedSignal(outside);
    const accepted = new Promise<void>(resolve => { signal = resolve; });
    expected = undefined;
    const bytes = readFileSync(path);
    // Publish only journal changes; no HomeStore event and no live-file change.
    const log = new VersionLog(homeFileLocation(home, file).root, file);
    writeFileSync(join(log.directory, digest(bytes)!), bytes);
    log.setRecord('HEAD', { hash: digest(bytes) });
    log.clearRecovery(bytes);
    await boundedSignal(accepted);
    expect(getHomeRecovery(home)).toEqual({ files: [] });
  } finally { unsubscribe(); }
});

async function boundedSignal(signal: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([signal, new Promise<never>((_, reject) => {
      // bound: only guard a missing filesystem signal after a completed live/journal write.
      timeout = setTimeout(() => reject(new Error('No split recovery watch signal')), 5000);
    })]);
  } finally { if (timeout) clearTimeout(timeout); }
}

it('binds a split state root created by an outside process after subscription', async () => {
  const home = Home.sandbox(storeRoot(), { layout: 'split' });
  expect(existsSync(home.state)).toBe(false);
  let ready!: () => void;
  const initial = new Promise<void>(resolve => { ready = resolve; });
  let observed!: () => void;
  const created = new Promise<void>(resolve => { observed = resolve; });
  const unsubscribe = subscribeHomeRecovery(home, () => {
    ready();
    if (existsSync(home.serverState())) observed();
  });
  try {
    await initial;
    mkdirSync(home.state);
    writeFileSync(home.serverState(), '{"external":true}'); // No process-local event or existing state watcher.
    await boundedSignal(created);
    expect(new HomeStore(home).read(home.serverState())).toBe('{"external":true}');
  } finally { unsubscribe(); }
});

it.skipIf(process.platform === 'win32')('skips escaped state backups while preserving a config save', () => {
  const home = Home.sandbox(storeRoot(), { layout: 'split' });
  const other = Home.sandbox(storeRoot());
  mkdirSync(home.state, { recursive: true });
  symlinkSync(other.root, home.backups, 'dir'); // Deliberate boundary escape.
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  Home.seed(home, home.workspaceConfig, { first: true });
  Home.seed(home, home.workspaceConfig, { second: true });
  expect(JSON.parse(readFileSync(home.workspaceConfig, 'utf8'))).toEqual({ second: true });
  expect(existsSync(join(other.root, 'config.json'))).toBe(false);
  expect(warn).toHaveBeenCalledOnce();
});
