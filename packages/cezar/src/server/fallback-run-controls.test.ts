import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { createRunner } from '../core/runner-factory.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { closeClaimSession, openClaimSession } from '../runs/run-claims.ts';
import { RUNS_DB_FILE, RunDatabase } from '../runs/run-database.ts';
import { readPersistedRuns, seedRuns, setRunStatus } from '../runs/run-store.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { seedSettledFamily } from '../workflows/delegation-reconcile.testkit.ts';
import { RunManager } from '../workflows/run.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { createApp } from './server.ts';

/** `requireRunControl` is the one explicit write that adopts a family read from `.ai/squawk/`. */
let root: string, primary: string, fallback: string, store: RunStore, manager: RunManager, app: Hono;
const refusal = /\.ai\/squawk.*binary that migrated/;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fallback-controls-'));
  primary = join(root, '.ai/cezar');
  fallback = join(root, '.ai/squawk');
});
afterEach(() => { manager?.dispose(); store?.close(); rmSync(root, { recursive: true, force: true }); });

/** A family whose root is under `.ai/cezar/` when `mixed`, its worker always under `.ai/squawk/`. */
function seedFamily(mixed: boolean, live = true) {
  const build = RunStore.open(primary, { keepLive: true });
  const family = seedSettledFamily(build, root);
  if (live) for (const id of [family.parentId, family.workerId]) setRunStatus(build, id, RUN_STATUS.running);
  build.flush(); build.close();
  const records = readPersistedRuns(primary);
  const moved = new Set(mixed ? [family.workerId] : [family.parentId, family.workerId]);
  seedRuns(primary, records.filter(run => !moved.has(run.id)));
  seedRuns(fallback, records.filter(run => moved.has(run.id)));
  if (!mixed) rmSync(primary, { recursive: true, force: true });
  return family;
}
function start() {
  store = RunStore.open(primary, { keepLive: true });
  manager = new RunManager(store, root, { createRunner, home: testHome(), semaphore: new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 0 } }) });
  app = createApp({ home: testHome(), repoRoot: root, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
}
const post = (path: string, body?: unknown) => apiRequest(app, `/api/v1/runs/${path}`, { method: 'POST',
  ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
const primaryIds = () => existsSync(join(primary, RUNS_DB_FILE)) ? readPersistedRuns(primary).map(run => run.id) : [];

it('keeps a mixed family visible after boot, and Stop adopts it, then settles it', async () => {
  const family = seedFamily(true);
  const fallbackBytes = readFileSync(join(fallback, RUNS_DB_FILE));
  start();
  await manager.recover();
  expect(store.runOwnership(family.parentId)).toBe('fallback');
  expect(store.getRun(family.parentId)?.status).toBe(RUN_STATUS.running);
  expect(store.getRun(family.workerId)?.status).toBe(RUN_STATUS.running);
  const stopped = await post(`${family.parentId}/cancel`);
  expect(stopped.status).toBe(200);
  expect(store.getRun(family.parentId)?.status).toBe(RUN_STATUS.cancelled);
  store.flush();
  expect(primaryIds()).toEqual(expect.arrayContaining([family.parentId, family.workerId]));
  expect(store.isFallbackRun(family.workerId)).toBe(false);
  expect(readFileSync(join(fallback, RUNS_DB_FILE))).toEqual(fallbackBytes);
});

it('Archive adopts a fallback-only family; read state and deletion never copy it', async () => {
  const family = seedFamily(false, false);
  start();
  const read = await post(`${family.parentId}/read`);
  expect(read.status).toBe(409);
  expect(await read.json()).toEqual({ error: expect.stringMatching(refusal) });
  const deleted = await apiRequest(app, `/api/v1/runs/${family.parentId}`, { method: 'DELETE' });
  expect(deleted.status).toBe(409);
  expect(existsSync(join(primary, RUNS_DB_FILE))).toBe(false);
  const archived = await post(`${family.parentId}/archive`, { archived: true });
  expect(archived.status).toBe(200);
  expect(store.runOwnership(family.parentId)).not.toBe('fallback');
  expect(store.getRun(family.workerId)?.archived).toBe(true);
  store.flush();
  expect(primaryIds()).toEqual(expect.arrayContaining([family.parentId, family.workerId]));
});

it('refuses a control while a live process of the migrating binary owns the fallback family', async () => {
  const family = seedFamily(false);
  const owner = openClaimSession();
  const db = RunDatabase.open(join(fallback, RUNS_DB_FILE));
  try {
    db.takeClaims(owner, [{ family: family.parentId, expect: null }]);
    start();
    const response = await post(`${family.parentId}/pin`, { pinned: true });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: expect.stringContaining('in use by another process') });
    expect(existsSync(join(primary, RUNS_DB_FILE))).toBe(false);
  } finally { db.close(); closeClaimSession(owner.session); }
});
