import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Home } from './home.ts';
import { homeFileKind, homeFileLocation } from './file-location.ts';
import { prepareHome } from './entry.ts';
import { holdCockpitLease, readCockpitLeases } from './leases.ts';
import { HomeStore } from './store.ts';
import { digest, VersionLog } from './version-log.ts';
import { getHomeRecovery } from './recovery.ts';
import { loadServerState, saveServerState, acquireLock } from '../server-install/state.ts';
import { freshServerState } from '../server-install/types.ts';
import { mergeWriteWorkspaceUiState, readWorkspaceUiState } from '../workspace/ui-state.ts';
import { cleanStoreRoots, storeRoot } from './store.testkit.ts';

afterEach(() => { vi.restoreAllMocks(); cleanStoreRoots(); });

it.each([
  ['config.json', 'config'], ['config.json.bak', 'config'], ['agent-accounts.json', 'config'],
  ['remote-settings/4321.json', 'config'], ['ui-state.json', 'state'], ['server.json', 'state'],
  ['server.install.lock', 'state'], ['server-instances/named.json', 'state'],
  ['server-instances/named.install.lock', 'state'],
] as const)('maps %s to %s without changing its key', (file, kind) => {
  const home = Home.sandbox(storeRoot(), { layout: 'split' });
  expect(homeFileKind(file)).toBe(kind);
  expect(homeFileLocation(home, file)).toEqual({ root: home[kind], path: join(home[kind], file), file });
  Home.seed(home, join(home[kind], file), { saved: true });
  expect(existsSync(join(home[kind], '.versions', file, 'HEAD'))).toBe(true);
  expect(() => homeFileKind('../config.json')).toThrow();
});

it('seeds config and state files at entry without changing existing bytes', () => {
  const home = Home.sandbox(storeRoot(), { layout: 'split' });
  rmSync(join(home.config, 'install.json'));
  mkdirSync(home.serverInstances, { recursive: true });
  const paths = [home.workspaceConfig, home.serverState(), home.serverState('named')];
  for (const path of paths) writeFileSync(path, '{"preexisting":true}'); // Pre-marker legacy input, not a HomeStore write.
  prepareHome(home, 'serve');
  for (const path of paths) {
    expect(readFileSync(path, 'utf8')).toBe('{"preexisting":true}');
    expect(new HomeStore(home).outsideWrite(path)).toBeUndefined();
  }
  expect(existsSync(join(home.state, '.versions/server-instances/named.json/HEAD'))).toBe(true);
  expect(existsSync(join(home.config, '.versions/config.json/HEAD'))).toBe(true);
  expect(existsSync(join(home.state, 'install.json'))).toBe(false);
});

it.each(['config.json', 'server.json'])('finishes PENDING recovery in the owning root of %s', file => {
  const home = Home.sandbox(storeRoot(), { layout: 'split' });
  const { root, path } = homeFileLocation(home, file);
  Home.seed(home, path, { old: true });
  const log = new VersionLog(root, file);
  const next = Buffer.from('{"next":true}');
  const hash = digest(next)!;
  writeFileSync(join(log.directory, hash), next); // Simulate a crash after live publication, before HEAD.
  log.setRecord('PENDING', { hash });
  writeFileSync(path, next);
  expect(new HomeStore(home).read(path)).toBe(next.toString());
  expect(log.record('HEAD')).toEqual({ hash });
  expect(log.record('PENDING')).toBeUndefined();
  expect(getHomeRecovery(home)).toEqual({ files: [] });
});

it('uses config authority to refuse state writes even when state has a test marker', () => {
  const home = Home.sandbox(storeRoot(), { layout: 'split' });
  mkdirSync(home.state, { recursive: true });
  const marker = readFileSync(join(home.config, 'install.json'), 'utf8');
  writeFileSync(join(home.state, 'install.json'), marker); // Untrusted marker in the wrong kind.
  writeFileSync(join(home.config, 'install.json'), JSON.stringify({ ...JSON.parse(marker), kind: 'live' }));
  expect(() => new HomeStore(home).writeJson(home.serverState(), {})).toThrow(/live home.*test runner/);
  expect(existsSync(join(home.state, '.locks'))).toBe(false);
});

it('keeps presence leases in config while server install locks live in state', () => {
  const home = Home.sandbox(storeRoot(), { layout: 'split' });
  const releaseLease = holdCockpitLease(home, 4321);
  const releaseInstall = acquireLock('named', home);
  try {
    expect(readCockpitLeases(home)).toContainEqual(expect.objectContaining({ pid: process.pid, port: 4321 }));
    expect(existsSync(join(home.config, '.locks/cockpits', `${process.pid}.lease`))).toBe(true);
    expect(existsSync(join(home.state, '.locks/cockpits'))).toBe(false);
    expect(readFileSync(home.serverLock('named'), 'utf8')).toBe(`${process.pid}\n`);
  } finally { releaseInstall(); releaseLease(); }
  expect(existsSync(home.serverLock('named'))).toBe(false);
  expect(readCockpitLeases(home)).toEqual([]);
});

it('journals state through the product readers and merge writers', async () => {
  const home = Home.sandbox(storeRoot(), { layout: 'split' });
  saveServerState(freshServerState(), 'named', home);
  await mergeWriteWorkspaceUiState(state => { state.appearance = { accent: 'lime' }; }, home);
  expect(await readWorkspaceUiState(home.workspaceUiState, home)).toMatchObject({ appearance: { accent: 'lime' } });
  const log = new VersionLog(home.state, 'server-instances/named.json');
  writeFileSync(home.serverState('named'), JSON.stringify({ ...freshServerState(), primaryPort: 5555 })); // Outside writer.
  expect(loadServerState('named', home).primaryPort).toBe(5555);
  expect(log.record('OUTSIDE')).toBeDefined();
});
