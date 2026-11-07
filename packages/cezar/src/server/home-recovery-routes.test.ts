import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { homeRecoverySchema, type HomeRecovery } from '@open-mercato/cezar-contract/home-recovery';
import { Home } from '../home/home.ts';
import { cleanStoreRoots, storeRoot } from '../home/store.testkit.ts';
import { acceptHomeRecovery, getHomeRecovery, restoreHomeRecovery, subscribeHomeRecovery } from '../home/recovery.ts';
import { createHomeRecoveryPublisher, createHomeRecoveryRoutes, HOME_RECOVERY_TOPIC } from './home-recovery-routes.ts';
import type { SocketHub } from './ws.ts';

vi.mock('../home/recovery.ts', () => ({
  getHomeRecovery: vi.fn(), restoreHomeRecovery: vi.fn(), acceptHomeRecovery: vi.fn(), subscribeHomeRecovery: vi.fn(),
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
  const app = createHomeRecoveryRoutes({ home });
  vi.mocked(getHomeRecovery).mockReturnValue(flagged);
  const read = await app.request('/home/recovery');
  expect(homeRecoverySchema.parse(await read.json())).toEqual(flagged);
  for (const action of ['restore', 'accept']) {
    vi.mocked(getHomeRecovery).mockReturnValue({ files: [] });
    const response = await app.request(`/home/recovery/${action}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: 'config.json' }) });
    expect(response.status).toBe(200);
    expect(homeRecoverySchema.parse(await response.json())).toEqual({ files: [] });
  }
  expect(restoreHomeRecovery).toHaveBeenCalledWith(home, 'config.json');
  expect(acceptHomeRecovery).toHaveBeenCalledWith(home, 'config.json');
});

it('rejects path input before the service and surfaces recovery failures as conflicts', async () => {
  const app = createHomeRecoveryRoutes({ home: Home.sandbox(storeRoot()) });
  for (const action of ['restore', 'accept']) {
    const bad = await app.request(`/home/recovery/${action}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: '../config.json' }) });
    expect(bad.status).toBe(400);
  }
  expect(restoreHomeRecovery).not.toHaveBeenCalled();
  expect(acceptHomeRecovery).not.toHaveBeenCalled();
  vi.mocked(restoreHomeRecovery).mockRejectedValue(new Error('Backup is unavailable'));
  vi.mocked(acceptHomeRecovery).mockImplementation(() => { throw new Error('Home is read-only'); });
  for (const [action, error] of [['restore', 'Backup is unavailable'], ['accept', 'Home is read-only']]) {
    const response = await app.request(`/home/recovery/${action}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: 'config.json' }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error });
  }
});

it('registers a trusted-only topic and holds watch demand only while it has a subscriber', async () => {
  const home = Home.sandbox(storeRoot());
  const registerTopic = vi.fn();
  const hub = { registerTopic } as unknown as SocketHub;
  createHomeRecoveryRoutes({ home, socketHub: hub });
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
