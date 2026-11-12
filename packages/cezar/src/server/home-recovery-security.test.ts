import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Home } from '../home/home.ts';
import { cleanStoreRoots, storeRoot } from '../home/store.testkit.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { disableRemoteSettings, enableRemoteSettings, isPortGranted } from '../remote-settings.ts';

afterEach(() => { vi.unstubAllEnvs(); cleanStoreRoots(); });

it('keeps home recovery behind the existing host and write-origin guards', async () => {
  const repoRoot = storeRoot();
  const home = Home.sandbox(storeRoot());
  const store = RunStore.open(repoRoot);
  try {
    const app = createApp({ home, repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
    for (const action of ['restore', 'accept']) {
      const response = await app.request(`/api/v1/home/recovery/${action}`, { method: 'POST',
        headers: { host: '127.0.0.1:4321', origin: 'https://foreign.example', 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'config.json', detectedAt: '2026-11-07T09:00:00.000Z' }) });
      expect(response.status).toBe(403);
    }
    const read = await app.request('/api/v1/home/recovery', { headers: { host: 'foreign.example' } });
    expect(read.status).toBe(403);
    const scoped = await app.request('/api/v1/p/default/home/recovery', { headers: { host: '127.0.0.1:4321' } });
    expect(scoped.status).toBe(404);
  } finally { store.close(); }
});

it.each([false, true])('blocks retained grant restoration in hosted mode, including settingsAdmin=%s', async granted => {
  vi.stubEnv('CEZ_REMOTE', '1');
  const repoRoot = storeRoot();
  const home = Home.sandbox(storeRoot());
  await enableRemoteSettings(4321, {}, undefined, home);
  await disableRemoteSettings({}, 4321, home);
  if (granted) await enableRemoteSettings(4321, {}, undefined, home);
  const file = join(home.remoteSettings, '4321.json');
  const before = granted ? readFileSync(file) : null;
  const store = RunStore.open(repoRoot);
  try {
    const app = createApp({ home, repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', squawkPort: () => 4321 });
    for (const action of ['restore', 'accept']) {
      const response = await app.request(`/api/v1/home/recovery/${action}`, { method: 'POST',
        headers: { host: 'remote.example', origin: 'https://remote.example', 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'remote-settings/4321.json', detectedAt: '2026-11-07T09:00:00.000Z' }) });
      expect(response.status).toBe(403);
    }
    expect(isPortGranted({}, 4321, home)).toBe(granted);
    if (before) expect(readFileSync(file)).toEqual(before);
    // The snapshot has the same read boundary as workspace config: hosted authentication is external.
    expect((await app.request('/api/v1/home/recovery', { headers: { host: 'remote.example' } })).status).toBe(200);
    expect((await app.request('/api/v1/workspace/config', { headers: { host: 'remote.example' } })).status).toBe(200);
  } finally { store.close(); }
});
