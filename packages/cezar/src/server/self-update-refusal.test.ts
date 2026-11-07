import { readFileSync, writeFileSync } from 'node:fs';
import { Hono } from 'hono';
import { afterEach, expect, it } from 'vitest';
import { Home } from '../home/home.ts';
import { cleanStoreRoots, storeRoot } from '../home/store.testkit.ts';
import { SelfUpdateService } from '../self-update/service.ts';
import { createSelfUpdateRoutes } from './self-update-routes.ts';

afterEach(cleanStoreRoots);

it('returns the outside-write refusal as JSON and keeps serving after a channel save fails', async () => {
  const home = Home.sandbox(storeRoot());
  Home.seed(home, home.workspaceConfig, { updateChannel: 'stable' });
  const outside = '{"updateChannel":"nightly"}';
  writeFileSync(home.workspaceConfig, outside); // Deliberate outside write must block the next settings save.
  const selfUpdate = new SelfUpdateService({ home, pkgName: '@wjarka/cezarion', version: '0.0.0', entry: '', restart: () => {} });
  const app = new Hono()
    .route('/api/v1', createSelfUpdateRoutes({ home, version: '0.0.0', selfUpdate }, () => true, () => []))
    .get('/alive', c => c.json({ alive: true }));
  const response = await app.request('/api/v1/workspace/self-update/channel', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'development' }),
  });
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: expect.stringContaining('restore or accept') });
  expect(readFileSync(home.workspaceConfig, 'utf8')).toBe(outside);
  expect((await app.request('/alive')).status).toBe(200);
});
