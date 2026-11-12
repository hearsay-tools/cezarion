import { homeFileLocation } from './file-location.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { Home } from './home.ts';
import { HomeOutsideWriteError, HomeStore } from './store.ts';
import { acceptHomeRecovery, getHomeRecovery, restoreHomeRecovery } from './recovery.ts';
import { subscribeHomeRecovery } from './recovery-watch.ts';
import { homeChanged } from './changes.ts';
import { cleanStoreRoots, storeRoot } from './store.testkit.ts';

const files = ['config.json', 'config.json.bak', 'agent-accounts.json', 'ui-state.json', 'server.json',
  'server.install.lock', 'remote-settings/4321.json', 'server-instances/named.json', 'server-instances/named.install.lock'] as const;
const registries = [
  { file: 'config.json', key: 'projects', entry: { id: 'saved', root: '/saved/repo' } },
  { file: 'agent-accounts.json', key: 'accounts', entry: { id: 'saved', provider: 'claude', configDir: '~/.claude-saved', label: 'Saved', addedAt: '' } },
] as const;

afterEach(() => { vi.restoreAllMocks(); cleanStoreRoots(); });

it('shows no recovery banner during an ordinary session', () => {
  const home = Home.sandbox(storeRoot());
  for (const file of files) Home.seed(home, homeFileLocation(home, file).path, { saved: true });
  for (const { file, key, entry } of registries) Home.seed(home, homeFileLocation(home, file).path, { [key]: [entry] });
  expect(getHomeRecovery(home)).toEqual({ files: [] });
  expect(getHomeRecovery(home)).toEqual({ files: [] });
});

it.each(registries)('pins the previous $key when a write empties $file, and restores it', async ({ file, key, entry }) => {
  const home = Home.sandbox(storeRoot());
  const path = homeFileLocation(home, file).path;
  const store = new HomeStore(home);
  Home.seed(home, path, { [key]: [entry], preserved: 'previous' });
  const previous = readFileSync(path);
  store.writeJson(path, { [key]: [] });
  store.writeJson(path, { [key]: [], later: true });
  expect(getHomeRecovery(home).files).toContainEqual({ file, reason: 'reset', detectedAt: expect.any(String), canRestore: true });
  await restoreHomeRecovery(home, file);
  expect(readFileSync(path)).toEqual(previous);
  expect(getHomeRecovery(home)).toEqual({ files: [] });
  store.writeJson(path, { [key]: [], intentionallyEmpty: true });
  acceptHomeRecovery(home, file);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ [key]: [], intentionallyEmpty: true });
  expect(getHomeRecovery(home)).toEqual({ files: [] });
});

it.each(files)('blocks every write method for outside changes to %s until restore or accept', async file => {
  const home = Home.sandbox(storeRoot());
  const path = homeFileLocation(home, file).path;
  const store = new HomeStore(home);
  Home.seed(home, path, { original: true });
  const original = readFileSync(path);
  const outside = '{"outside":true}';
  writeFileSync(path, outside); // Deliberate outside write: every mutation entry must refuse it.
  expect(getHomeRecovery(home).files).toContainEqual({ file, reason: 'outside-write', detectedAt: expect.any(String), canRestore: true });
  expect(() => store.replace(path, Buffer.from('{"later":true}'))).toThrow(HomeOutsideWriteError);
  expect(() => store.writeJson(path, { later: true })).toThrow(HomeOutsideWriteError);
  expect(() => store.createExclusive(path, Buffer.from('later'))).toThrow(HomeOutsideWriteError);
  expect(readFileSync(path, 'utf8')).toBe(outside);
  await restoreHomeRecovery(home, file);
  expect(readFileSync(path)).toEqual(original);
  expect(getHomeRecovery(home).files.some(state => state.file === file)).toBe(false);

  writeFileSync(path, '{"accepted":true}'); // A second independent outside write exercises acceptance.
  expect(getHomeRecovery(home).files.some(state => state.file === file)).toBe(true);
  const before = statSync(path).mtimeMs;
  acceptHomeRecovery(home, file);
  expect(statSync(path).mtimeMs).toBe(before);
  expect(readFileSync(path, 'utf8')).toBe('{"accepted":true}');
  expect(getHomeRecovery(home).files.some(state => state.file === file)).toBe(false);
  store.writeJson(path, { afterAcceptance: true });
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ afterAcceptance: true });
});

it('flags a replayed older version and restores the newer committed version', async () => {
  const home = Home.sandbox(storeRoot());
  Home.seed(home, home.workspaceUiState, { version: 'old' });
  const older = readFileSync(home.workspaceUiState);
  Home.seed(home, home.workspaceUiState, { version: 'current' });
  const current = readFileSync(home.workspaceUiState);
  writeFileSync(home.workspaceUiState, older); // A retained version is still an outside write.
  expect(getHomeRecovery(home).files).toContainEqual(expect.objectContaining({ file: 'ui-state.json', reason: 'outside-write' }));
  await restoreHomeRecovery(home, 'ui-state.json');
  expect(readFileSync(home.workspaceUiState)).toEqual(current);
  expect(getHomeRecovery(home)).toEqual({ files: [] });
});

it('restores absence when an outside writer creates a previously absent file', async () => {
  const home = Home.sandbox(storeRoot());
  Home.seedBytes(home, home.workspaceUiState, null); // Explicitly track absence before the outside create.
  writeFileSync(home.workspaceUiState, '{}'); // Deliberate outside creation.
  expect(getHomeRecovery(home).files).toContainEqual(expect.objectContaining({ file: 'ui-state.json', reason: 'outside-write' }));
  await restoreHomeRecovery(home, 'ui-state.json');
  expect(existsSync(home.workspaceUiState)).toBe(false);
  expect(getHomeRecovery(home)).toEqual({ files: [] });
});

it.each(['restore', 'accept'] as const)('offers a nonempty .bak for a valid empty registry and clears it after %s', async action => {
  const home = Home.sandbox(storeRoot());
  Home.seed(home, home.workspaceConfig, { projects: [] });
  Home.seed(home, `${home.workspaceConfig}.bak`, { projects: [{ id: 'kept', root: '/kept/repo' }] });
  expect(getHomeRecovery(home).files).toContainEqual(expect.objectContaining({ file: 'config.json', reason: 'reset' }));
  if (action === 'restore') await restoreHomeRecovery(home, 'config.json');
  else acceptHomeRecovery(home, 'config.json');
  expect(JSON.parse(readFileSync(home.workspaceConfig, 'utf8')).projects).toHaveLength(action === 'restore' ? 1 : 0);
  expect(getHomeRecovery(home)).toEqual({ files: [] });
  expect(getHomeRecovery(home)).toEqual({ files: [] });
});

it.each(['normal', 'outside'] as const)('uses metadata for unchanged %s recovery reads without another HomeStore transaction', state => {
  const home = Home.sandbox(storeRoot());
  Home.seed(home, home.workspaceConfig, { projects: [] });
  if (state === 'outside') writeFileSync(home.workspaceConfig, '{"outside":true}'); // Deliberate outside write to exercise cached flags.
  getHomeRecovery(home);
  const settled = getHomeRecovery(home); // Settle fingerprints for initially absent journals and newly raised flags.
  expect(settled.files).toHaveLength(state === 'outside' ? 1 : 0);
  const transaction = vi.spyOn(HomeStore.prototype, 'transaction');
  expect(getHomeRecovery(home)).toEqual(settled);
  expect(getHomeRecovery(home)).toEqual(settled);
  expect(transaction).not.toHaveBeenCalled();
});

it('publishes an outside write from another process only while recovery has demand', async () => {
  const home = Home.sandbox(storeRoot());
  Home.seed(home, home.workspaceUiState, { saved: true });
  getHomeRecovery(home);
  getHomeRecovery(home); // Start subscription with stable journals; later signals must come from the external write.
  let initial!: () => void;
  const ready = new Promise<void>(resolve => { initial = resolve; });
  let observed!: () => void;
  const changed = new Promise<void>(resolve => { observed = resolve; });
  const listener = vi.fn(() => {
    const snapshot = getHomeRecovery(home);
    initial();
    if (snapshot.files.some(file => file.file === 'ui-state.json' && file.reason === 'outside-write')) observed();
  });
  const unsubscribe = subscribeHomeRecovery(home, listener);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await ready;
    execFileSync(process.execPath, ['--input-type=module', '-e',
      'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[1], "{\\"external\\":true}")', home.workspaceUiState]);
    await Promise.race([changed, new Promise<never>((_, reject) => {
      // bound: a filesystem watch must deliver the separate process's completed write; this only guards a missing signal.
      timeout = setTimeout(() => reject(new Error('No outside-write recovery signal')), 5000);
    })]);
    expect(getHomeRecovery(home).files).toContainEqual(expect.objectContaining({ file: 'ui-state.json', reason: 'outside-write' }));
  } finally {
    if (timeout) clearTimeout(timeout);
    unsubscribe();
  }
  listener.mockClear();
  homeChanged(home.root);
  await Promise.resolve(); // The publisher queues a microtask; unsubscription must cancel this demand deterministically.
  expect(listener).not.toHaveBeenCalled();
});
