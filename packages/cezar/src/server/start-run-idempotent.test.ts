import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';

/**
 * Idempotent `POST /runs` (#504, spec 2026-09-24-cez-task-cli). A real manager with no slots, so
 * every run stays `queued` and nothing spawns — the dedupe under test lives in the manager and
 * the store, not in the route, so a stub manager would prove nothing.
 */
describe('POST /api/v1/runs clientRequestId', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let app: Hono;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  const requestId = '6f1c1b5e-2a7d-4c8e-9f3b-1d2e3f4a5b6c';

  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-idempotent-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  const post = (body: unknown) =>
    apiRequest(app, '/api/v1/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const body = { task: 'do the thing', workflow: 'quick-task', clientRequestId: requestId };

  it('answers 201 first and 200 with the same run on a repeat', async () => {
    const first = await post(body);
    expect(first.status).toBe(201);
    const created = (await first.json()) as { id: string };
    const again = await post(body);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { id: string }).id).toBe(created.id);
    expect(store.listRuns()).toHaveLength(1);
  });

  it('refuses a repeat whose payload differs with 409 and starts nothing', async () => {
    expect((await post(body)).status).toBe(201);
    const conflict = await post({ ...body, task: 'something else' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: 'request id payload conflict' });
    expect(store.listRuns()).toHaveLength(1);
  });

  it.each([
    [{ images: [{ mediaType: 'image/png', data: 'YQ==' }] }, { images: [{ mediaType: 'image/png', data: 'Yg==' }] }],
    [{ generateFollowups: false }, { generateFollowups: true }],
  ])('rejects changed behavior inputs on a retry: %j', async (original, changed) => {
    const payload = { ...body, ...original };
    expect((await post(payload)).status).toBe(201);
    expect((await post(payload)).status).toBe(200);
    const conflict = await post({ ...body, ...changed });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: 'request id payload conflict' });
    expect(store.listRuns()).toHaveLength(1);
  });

  it('creates exactly one run for two concurrent identical retries', async () => {
    const statuses = (await Promise.all([post(body), post(body)])).map((res) => res.status).sort();
    expect(statuses).toEqual([200, 201]);
    expect(store.listRuns()).toHaveLength(1);
  });

  it('still answers with an archived match', async () => {
    const { id } = (await (await post(body)).json()) as { id: string };
    store.setArchived(id, true);
    const again = await post(body);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { id: string }).id).toBe(id);
  });

  it('rejects a request id combined with variants > 1', async () => {
    const res = await post({ ...body, variants: 2 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('clientRequestId');
    expect(store.listRuns()).toHaveLength(0);
  });

  it('rejects a request id that is not a UUID', async () => {
    expect((await post({ ...body, clientRequestId: 'not-a-uuid' })).status).toBe(400);
  });

  it('keeps starting a new run per request when no id is sent', async () => {
    const { clientRequestId: _omit, ...plain } = body;
    expect((await post(plain)).status).toBe(201);
    expect((await post(plain)).status).toBe(201);
    expect(store.listRuns()).toHaveLength(2);
  });
});
