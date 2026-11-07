import { afterEach, expect, it } from 'vitest';
import { Home } from '../home/home.ts';
import { cleanStoreRoots, storeRoot } from '../home/store.testkit.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';

afterEach(cleanStoreRoots);

it('keeps home recovery behind the existing host and write-origin guards', async () => {
  const repoRoot = storeRoot();
  const home = Home.sandbox(storeRoot());
  const store = RunStore.open(repoRoot);
  try {
    const app = createApp({ home, repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
    for (const action of ['restore', 'accept']) {
      const response = await app.request(`/api/v1/home/recovery/${action}`, { method: 'POST',
        headers: { host: '127.0.0.1:4321', origin: 'https://foreign.example', 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'config.json' }) });
      expect(response.status).toBe(403);
    }
    const read = await app.request('/api/v1/home/recovery', { headers: { host: 'foreign.example' } });
    expect(read.status).toBe(403);
    const scoped = await app.request('/api/v1/p/default/home/recovery', { headers: { host: '127.0.0.1:4321' } });
    expect(scoped.status).toBe(404);
  } finally { store.close(); }
});
