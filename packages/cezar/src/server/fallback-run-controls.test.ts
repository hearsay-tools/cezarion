import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { retainAutosaveCleanup } from '../autosave-cleanup.ts';
import { fallbackProjectWriteError } from '../project-paths.ts';
import { createRunner } from '../core/runner-factory.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { closeClaimSession, openClaimSession } from '../runs/run-claims.ts';
import { RUNS_DB_FILE, RunDatabase } from '../runs/run-database.ts';
import { readPersistedRuns, seedRuns, setRunStatus } from '../runs/run-store.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { seedSettledFamily } from '../workflows/delegation-reconcile.testkit.ts';
import { RunManager } from '../workflows/run.ts';
import { acquireInertCiResources } from '../ci-wait/inert-ci-resources.testkit.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { createApp } from './server.ts';
import { sendAgentReport } from '../runs/webhook.ts';
import { commitAccepted } from '../delegation/conversations.ts';
import { delegationFailure } from '../delegation/routes.ts';
import { RunWriteRefusedError } from '../runs/store.ts';

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
  if (!mixed) {
    rmSync(primary, { recursive: true, force: true });
    mkdirSync(primary, { recursive: true }); // Keep the project legacy while its history is fallback-only.
  }
  return family;
}
function start() {
  store = RunStore.open(primary, { keepLive: true });
  manager = new RunManager(store, root, { acquireCiResources: acquireInertCiResources, createRunner, home: testHome(), semaphore: new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 0 } }) });
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

it('refuses other explicit writes cleanly: a webhook report still answers, a message names .ai/squawk', async () => {
  const family = seedFamily(false, false);
  start();
  const report = await sendAgentReport({ projectId: 'p', webhook: { id: 'w', name: 'W', url: 'https://bot.example/hook' },
    input: { runId: family.parentId, message: 'm' }, store, dryRun: true });
  expect(report.ok).toBe(true);
  const root = store.getRun(family.parentId)!;
  const state = root.delegation?.role === 'root' ? root.delegation.conversation! : { messages: [], outcomes: [] };
  const message = { ...state.messages[0]!, id: crypto.randomUUID() };
  expect(() => commitAccepted(store, family.parentId, { ...state, messages: [...state.messages, message] }, undefined, false))
    .toThrow(refusal);
  expect(existsSync(join(primary, RUNS_DB_FILE))).toBe(false);
  // Any other delegation write (reply, conversation) answers the same 409 shape with that reason.
  let refused: unknown;
  try { store.commitConversation(family.parentId, state); } catch (error) { refused = error; }
  expect(refused).toBeInstanceOf(RunWriteRefusedError);
  expect(delegationFailure(refused)).toEqual({ status: 409, body: { code: 'incompatible_state', error: expect.stringMatching(refusal) } });
});

it('keeps the diff of a fallback run readable, from its worktree under .ai/squawk/', async () => {
  const family = seedFamily(false, false);
  const worktree = join(fallback, 'worktrees', family.parentId);
  mkdirSync(worktree, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', worktree, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args]);
  git('init', '-q', '-b', 'main');
  writeFileSync(join(worktree, 'file.txt'), 'before\n');
  git('add', '.'); git('commit', '-qm', 'fixture');
  writeFileSync(join(worktree, 'file.txt'), 'after\n');
  const record = readPersistedRuns(fallback).find(run => run.id === family.parentId);
  seedRuns(fallback, [...readPersistedRuns(fallback).filter(run => run.id !== family.parentId), { ...record, worktreePath: worktree }]);
  const before = readFileSync(join(fallback, RUNS_DB_FILE));
  start();
  const diff = await apiRequest(app, `/api/v1/runs/${family.parentId}/diff`);
  expect(diff.status).toBe(200);
  expect(await diff.text()).toContain('+after');
  expect((await apiRequest(app, `/api/v1/runs/${crypto.randomUUID()}/diff`)).status).toBe(404);
  expect(existsSync(join(primary, RUNS_DB_FILE))).toBe(false);
  expect(readFileSync(join(fallback, RUNS_DB_FILE))).toEqual(before);
});

it('refuses to adopt a family whose legacy root another live process claims, and copies nothing', async () => {
  const family = seedFamily(true, false);
  const owner = openClaimSession();
  const other = RunDatabase.open(join(primary, RUNS_DB_FILE));
  try {
    other.takeClaims(owner, [{ family: family.parentId, expect: null }]);
    start();
    const response = await post(`${family.parentId}/pin`, { pinned: true });
    expect(response.status).toBe(409);
    expect(primaryIds()).not.toContain(family.workerId);
    expect(existsSync(join(primary, 'runs', `${family.workerId}.ndjson`))).toBe(false);
    expect(store.isFallbackRun(family.workerId)).toBe(true);
  } finally { other.close(); closeClaimSession(owner.session); }
});

it('answers a refused worker-destroy adoption in the delegation error shape', async () => {
  const family = seedFamily(false, false);
  const owner = openClaimSession();
  const db = RunDatabase.open(join(fallback, RUNS_DB_FILE));
  try {
    db.takeClaims(owner, [{ family: family.parentId, expect: null }]);
    start();
    const response = await post(`${family.workerId}/worker-destroy`, {});
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 'incompatible_state', error: expect.stringContaining('in use by another process') });
    expect(existsSync(join(primary, RUNS_DB_FILE))).toBe(false);
  } finally { db.close(); closeClaimSession(owner.session); }
});

it('adopts only for a matched same-origin control: no preflight, read, unknown path or cross-origin write copies', async () => {
  const family = seedFamily(false, false);
  start();
  const before = readFileSync(join(fallback, RUNS_DB_FILE));
  const foreign = { origin: 'https://foreign.example', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' };
  const requests: Array<[string, string, Record<string, string>?]> = [
    ['OPTIONS', 'pin', foreign], ['HEAD', ''], ['GET', ''], ['POST', 'no-such-control'], ['POST', 'pin', foreign],
  ];
  for (const [method, suffix, headers] of requests) {
    await apiRequest(app, `/api/v1/runs/${family.parentId}${suffix ? `/${suffix}` : ''}`, { method, headers: headers ?? {}, ...(method === 'POST' ? { body: '{"pinned":true}' } : {}) });
    expect(existsSync(join(primary, RUNS_DB_FILE)), `${method} ${suffix}`).toBe(false);
    expect(store.runOwnership(family.parentId)).toBe('fallback');
  }
  expect(readFileSync(join(fallback, RUNS_DB_FILE))).toEqual(before);
  expect((await post(`${family.parentId}/pin`, { pinned: true })).status).toBe(200);
  expect(primaryIds()).toEqual(expect.arrayContaining([family.parentId, family.workerId]));
});

it('refuses a worktree reclaim for a mixed family with the named refusal, before touching the checkout', async () => {
  const family = seedFamily(true, false);
  const worktree = join(primary, 'worktrees', family.parentId);
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, 'file.txt'), 'checkout');
  const record = readPersistedRuns(primary).find(run => run.id === family.parentId);
  seedRuns(primary, [...readPersistedRuns(primary).filter(run => run.id !== family.parentId), { ...record, worktreePath: worktree }]);
  start();
  const response = await apiRequest(app, `/api/v1/worktrees/${family.parentId}/reclaim`, { method: 'POST' });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: expect.stringMatching(refusal) });
  expect(readFileSync(join(worktree, 'file.txt'), 'utf8')).toBe('checkout');
  expect(primaryIds()).not.toContain(family.workerId);
});


it.each(['autosave', 'removed'] as const)('git writes refuse a fallback checkout before %s checks', async (state) => {
  const family = seedFamily(false, false);
  const worktree = join(fallback, 'worktrees', family.parentId);
  const records = readPersistedRuns(fallback);
  seedRuns(fallback, records.map(run => run.id === family.parentId ? { ...run, worktreePath: worktree } : run));
  if (state === 'autosave') {
    mkdirSync(worktree, { recursive: true });
    mkdirSync(join(fallback, 'runs'), { recursive: true });
    retainAutosaveCleanup(fallback, family.parentId, worktree, 'cleanup pending', { processes: [], groups: [], uncertain: true });
  }
  start();
  for (const route of ['git/commit', 'git/push']) {
    const response = await post(`${family.parentId}/${route}`, route === 'git/commit' ? { message: 'unsafe' } : undefined);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: fallbackProjectWriteError(worktree) });
  }
});
