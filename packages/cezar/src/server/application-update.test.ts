import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applicationUpdateResponseSchema, healthResponseSchema } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp, startServer } from './server.ts';
import { ApplicationUpdateConflictError } from '../application-update/service.ts';

const originalRemote = process.env.CEZ_REMOTE;
const originalDryRun = process.env.CEZ_DRY_RUN;
const roots: string[] = [];
afterEach(() => {
  if (originalRemote === undefined) delete process.env.CEZ_REMOTE;
  else process.env.CEZ_REMOTE = originalRemote;
  if (originalDryRun === undefined) delete process.env.CEZ_DRY_RUN;
  else process.env.CEZ_DRY_RUN = originalDryRun;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(bindHost?: string) {
  const root = mkdtempSync(join(tmpdir(), 'cez-app-update-api-'));
  roots.push(root);
  const state = { status: 'idle' as const, supported: true };
  const updateService = {
    snapshot: vi.fn(() => state),
    apply: vi.fn(async () => ({ status: 'ready' as const, supported: true, targetVersion: '2.0.0' })),
    restart: vi.fn(async () => ({ status: 'restarting' as const, supported: true, targetVersion: '2.0.0' })),
  };
  const app = createApp({
    repoRoot: root,
    store: RunStore.open(join(root, '.ai/cezar')),
    manager: {} as RunManager,
    version: '1.0.0',
    bindHost,
    applicationUpdate: updateService,
  });
  const request = (route: string, body = '{}') => app.request(`/api/v1/workspace/application-update/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' }, body,
  });
  return { app, request, updateService };
}

describe('application update routes', () => {
  it('rejects Apply in remote mode before service side effects', async () => {
    process.env.CEZ_REMOTE = '1';
    const { app, request, updateService } = setup();
    const response = await request('apply');
    expect(response.status).toBe(409);
    expect(updateService.apply).not.toHaveBeenCalled();
    const health = healthResponseSchema.parse(await (await app.request('/api/v1/health', { headers: { host: 'localhost' } })).json());
    expect(health.applicationUpdate?.supported).toBe(false);
  });

  it('rejects Apply on a non-loopback bind before service side effects', async () => {
    delete process.env.CEZ_REMOTE;
    const { request, updateService } = setup('0.0.0.0');
    const response = await request('apply');
    expect(response.status).toBe(409);
    expect(updateService.apply).not.toHaveBeenCalled();
  });

  it('rejects caller-supplied commands in both strict empty bodies', async () => {
    delete process.env.CEZ_REMOTE;
    const { request, updateService } = setup();
    for (const route of ['apply', 'restart']) {
      const response = await request(route, '{"command":"anything"}');
      expect(response.status).toBe(400);
    }
    expect(updateService.apply).not.toHaveBeenCalled();
    expect(updateService.restart).not.toHaveBeenCalled();
  });

  it('answers authoritative state for both mutations and health', async () => {
    delete process.env.CEZ_REMOTE;
    process.env.CEZ_DRY_RUN = '1';
    const { app, request } = setup();
    expect(applicationUpdateResponseSchema.parse(await (await request('apply')).json()).state.status).toBe('ready');
    expect(applicationUpdateResponseSchema.parse(await (await request('restart')).json()).state.status).toBe('restarting');
    const health = await app.request('/api/v1/health', { headers: { host: 'localhost' } });
    expect(health.status).toBe(200);
    expect(healthResponseSchema.parse(await health.json()).applicationUpdate).toEqual({ status: 'idle', supported: true });
  });

  it('degrades when the service is absent', async () => {
    delete process.env.CEZ_REMOTE;
    const root = mkdtempSync(join(tmpdir(), 'cez-app-update-api-'));
    roots.push(root);
    const app = createApp({ repoRoot: root, store: RunStore.open(join(root, '.ai/cezar')), manager: {} as RunManager, version: '1.0.0' });
    const response = await app.request('/api/v1/workspace/application-update/apply', {
      method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' }, body: '{}',
    });
    expect(response.status).toBe(409);
  });

  it('distinguishes preparation failure from a restart precondition conflict', async () => {
    delete process.env.CEZ_REMOTE;
    const { request, updateService } = setup();
    updateService.apply.mockRejectedValueOnce(new Error('npm failed'));
    updateService.restart.mockRejectedValueOnce(new ApplicationUpdateConflictError('not ready'));
    const preparation = await request('apply');
    expect(preparation.status).toBe(500);
    const preparationBody = await preparation.json() as Record<string, unknown>;
    expect(JSON.stringify(preparationBody)).not.toContain('npm failed');
    expect(Object.keys(preparationBody)).toEqual(['error']);
    const restart = await request('restart');
    expect(restart.status).toBe(409);
    expect(Object.keys(await restart.json() as Record<string, unknown>)).toEqual(['error']);
  });

  it('hands off restart only after Node finishes the HTTP acknowledgement', async () => {
    delete process.env.CEZ_REMOTE;
    process.env.CEZ_DRY_RUN = '1';
    const root = mkdtempSync(join(tmpdir(), 'cez-app-update-api-')); roots.push(root);
    const calls: string[] = [];
    const server = startServer({ repoRoot: root, store: RunStore.open(join(root, '.ai/cezar')),
      manager: {} as RunManager, version: '1.0.0', applicationUpdate: {
        snapshot: () => ({ status: 'ready', supported: true, targetVersion: '2.0.0' }),
        apply: async () => ({ status: 'ready', supported: true, targetVersion: '2.0.0' }),
        restart: async () => { calls.push('armed'); return { status: 'restarting', supported: true, targetVersion: '2.0.0' }; },
        afterResponse: () => { calls.push('handoff'); },
      } }, 0);
    server.prependListener('request', (request, response) => {
      if (request.url === '/api/v1/workspace/application-update/restart') response.once('finish', () => calls.push('finished'));
    });
    try {
      if (!server.listening) await once(server, 'listening');
      const address = server.address();
      expect(address && typeof address !== 'string').toBe(true);
      if (!address || typeof address === 'string') return;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/workspace/application-update/restart`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(response.status).toBe(200);
      expect(applicationUpdateResponseSchema.parse(await response.json()).state.status).toBe('restarting');
      expect(calls).toEqual(['armed', 'finished', 'handoff']);
    } finally { await server.shutdownForRestart(); }
  });

  it('flushes queued, waiting and running records for the existing recovery path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-app-update-runs-')); roots.push(root);
    const dataDir = join(root, '.ai/cezar');
    const store = RunStore.open(dataDir, { keepLive: true });
    const ids = ['queued', 'waiting', 'running'].map((status) => {
      const run = store.createRun({ title: status, workflow: 'quick-task', task: status, steps: [] });
      store.updateRun(run.id, { status: status as 'queued' | 'waiting' | 'running' });
      return run.id;
    });
    const server = startServer({ repoRoot: root, store, manager: {} as RunManager, version: '1.0.0' }, 0);
    if (!server.listening) await once(server, 'listening');
    await server.shutdownForRestart();
    const reopened = RunStore.open(dataDir, { keepLive: true });
    expect(ids.map((id) => reopened.getRun(id)?.status)).toEqual(['queued', 'waiting', 'running']);
  });
});
