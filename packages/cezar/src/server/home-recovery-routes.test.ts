import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { homeRecoverySchema, type HomeRecovery } from '@open-mercato/cezar-contract/home-recovery';
import { Home } from '../home/home.ts';
import { cleanStoreRoots, storeRoot } from '../home/store.testkit.ts';
import { acceptHomeRecovery, getHomeRecovery, importHomeRecovery, restoreHomeRecovery } from '../home/recovery.ts';
import { subscribeHomeRecovery } from '../home/recovery-watch.ts';
import { createHomeRecoveryPublisher, createHomeRecoveryRoutes, HOME_RECOVERY_TOPIC } from './home-recovery-routes.ts';
import type { SocketHub } from './ws.ts';

vi.mock('../home/recovery.ts', () => ({
  getHomeRecovery: vi.fn(), restoreHomeRecovery: vi.fn(), acceptHomeRecovery: vi.fn(), importHomeRecovery: vi.fn(),
}));
vi.mock('../home/recovery-watch.ts', () => ({
  subscribeHomeRecovery: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getHomeRecovery).mockReturnValue({ files: [] });
});
afterEach(cleanStoreRoots);

const flagged: HomeRecovery = { files: [{ file: 'config.json', reason: 'outside-write',
  detectedAt: '2026-11-07T09:00:00.000Z', canRestore: true }] };

it('reads the cached metadata and sends restore and accept through the shared recovery service', async () => {
  const home = Home.sandbox(storeRoot());
  const app = createHomeRecoveryRoutes({ home, localHandoff: () => true });
  vi.mocked(getHomeRecovery).mockReturnValue(flagged);
  const read = await app.request('/home/recovery');
  expect(homeRecoverySchema.parse(await read.json())).toEqual(flagged);
  for (const action of ['restore', 'accept', 'import']) {
    vi.mocked(getHomeRecovery).mockReturnValue({ files: [] });
    const response = await app.request(`/home/recovery/${action}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: 'config.json', detectedAt: '2026-11-07T09:00:00.000Z' }) });
    expect(response.status).toBe(200);
    expect(homeRecoverySchema.parse(await response.json())).toEqual({ files: [] });
  }
  expect(restoreHomeRecovery).toHaveBeenCalledWith(home, 'config.json', '2026-11-07T09:00:00.000Z');
  expect(acceptHomeRecovery).toHaveBeenCalledWith(home, 'config.json', '2026-11-07T09:00:00.000Z');
  expect(importHomeRecovery).toHaveBeenCalledWith(home, 'config.json', '2026-11-07T09:00:00.000Z');
});

it('rejects path input before the service and surfaces recovery failures as conflicts', async () => {
  const app = createHomeRecoveryRoutes({ home: Home.sandbox(storeRoot()), localHandoff: () => true });
  for (const action of ['restore', 'accept', 'import']) {
    const bad = await app.request(`/home/recovery/${action}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: '../config.json' }) });
    expect(bad.status).toBe(400);
    const untargeted = await app.request(`/home/recovery/${action}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: 'config.json' }) });
    expect(untargeted.status).toBe(400);
  }
  expect(restoreHomeRecovery).not.toHaveBeenCalled();
  expect(acceptHomeRecovery).not.toHaveBeenCalled();
  vi.mocked(restoreHomeRecovery).mockRejectedValue(new Error('Backup is unavailable'));
  vi.mocked(acceptHomeRecovery).mockImplementation(() => { throw new Error('Home is read-only'); });
  for (const [action, error] of [['restore', 'Backup is unavailable'], ['accept', 'Home is read-only']]) {
    const response = await app.request(`/home/recovery/${action}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: 'config.json', detectedAt: '2026-11-07T09:00:00.000Z' }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error });
  }
});

const actionCases = ['config.json', 'config.json.bak', 'agent-accounts.json', 'ui-state.json', 'server.json',
  'server.install.lock', 'remote-settings/4321.json', 'server-instances/other.json',
  'server-instances/other.install.lock'].flatMap(file => [false, true].map(local => ({
    file, local, status: local && !file.startsWith('remote-settings/') ? 200 : 403,
  })));

it.each(actionCases)('protects both recovery actions for $file when local=$local', async ({ file, local, status }) => {
  const app = createHomeRecoveryRoutes({ home: Home.sandbox(storeRoot()), localHandoff: () => local });
  for (const action of ['restore', 'accept', 'import']) {
    const response = await app.request(`/home/recovery/${action}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file, detectedAt: flagged.files[0]!.detectedAt }) });
    expect(response.status).toBe(status);
  }
  expect(restoreHomeRecovery).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
  expect(acceptHomeRecovery).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
  expect(importHomeRecovery).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
});

it('registers a trusted-only topic and holds watch demand only while it has a subscriber', async () => {
  const home = Home.sandbox(storeRoot());
  const registerTopic = vi.fn();
  const hub = { registerTopic } as unknown as SocketHub;
  createHomeRecoveryRoutes({ home, socketHub: hub, localHandoff: () => true });
  expect(registerTopic).toHaveBeenCalledWith(HOME_RECOVERY_TOPIC, expect.any(Object), { loopbackReadable: false });
  expect(subscribeHomeRecovery).not.toHaveBeenCalled();
  let changed!: () => void;
  const release = vi.fn();
  vi.mocked(subscribeHomeRecovery).mockImplementation((_home, listener) => { changed = listener; return release; });
  const publisher = createHomeRecoveryPublisher(home);
  expect(await publisher.snapshot()).toEqual({ files: [] });
  const publish = vi.fn();
  const stop = publisher.start(publish);
  changed();
  expect(publish).not.toHaveBeenCalled();
  vi.mocked(getHomeRecovery).mockReturnValue(flagged);
  changed();
  changed();
  expect(publish).toHaveBeenCalledExactlyOnceWith(flagged);
  stop();
  expect(release).toHaveBeenCalledTimes(1);
});
