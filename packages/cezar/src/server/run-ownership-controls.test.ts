import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Hono } from 'hono';
import { delegationErrorResponseSchema } from '@open-mercato/cezar-contract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RUNS_DB_FILE } from '../runs/run-database.ts';
import { crashStore, readPersistedRuns } from '../runs/run-store.testkit.ts';
import { RUN_IN_USE_ELSEWHERE, RunStore } from '../runs/store.ts';
import { createFixtureManager, drainFixtureManagers } from '../workflows/fixture-cleanup.testkit.ts';
import { RunManager } from '../workflows/run.ts';
import { QUICK_TASK_WORKFLOW } from '../workflows/types.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { createApp, projectRouteManifest } from './server.ts';

/**
 * Run controls when two cezar processes share a project (#779, plan step 3). The other process is
 * a second store in this one: its claims carry another session. A real manager with no slots, so
 * nothing spawns.
 */
describe('controls on a run another cezar process owns', () => {
  let repoRoot: string;
  let dataDir: string;
  let owner: RunStore;
  let store: RunStore;
  let manager: RunManager;
  let app: Hono;
  let runId: string;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-run-ownership-'));
    dataDir = join(repoRoot, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    owner = RunStore.open(dataDir, { keepLive: true });
    runId = owner.createRun({ title: 'theirs', workflow: 'quick-task', task: 'theirs', steps: [] }).id;
    owner.flush();
    store = RunStore.open(dataDir, { keepLive: true });
    manager = new RunManager(store, repoRoot, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
  });

  afterEach(() => {
    manager.dispose();
    store.close();
    owner.close();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  /** Every route that is not a read of one run, from the app's own registrations, so a route
   *  added later is walked too. */
  const controls = () => projectRouteManifest(app).filter((route) =>
    route.method !== 'GET' && (route.path === '/runs/:id' || route.path.startsWith('/runs/:id/')));

  it('answers 409 { error } on every control route, changes nothing, and still answers reads', async () => {
    const routes = controls();
    // The family as it stands: cancel, continue, finish, messages, queued messages, archive, pin,
    // notify, read, unread, PATCH, DELETE, auto-resume, remove-worktree, pr, git, open-in, …
    expect(routes.length).toBeGreaterThanOrEqual(20);
    const before = readPersistedRuns(dataDir);
    const answers: Array<{ route: string; status: number; body: Record<string, unknown> }> = [];
    for (const route of routes) {
      const path = `/api/v1${route.path.replace(':id', runId).replace(/:[A-Za-z]+/g, 'x')}`;
      const response = await apiRequest(app, path, { method: route.method, headers: { 'content-type': 'application/json' }, body: '{}' });
      answers.push({ route: `${route.method} ${route.path}`, status: response.status, body: await response.json() as Record<string, unknown> });
    }
    expect(answers.filter((answer) => answer.status !== 409 || answer.body.error !== RUN_IN_USE_ELSEWHERE)).toEqual([]);
    // Each in the error shape its route already answers with: the delegation route keeps its code.
    const destroy = answers.find((answer) => answer.route === 'POST /runs/:id/worker-destroy')!;
    expect(delegationErrorResponseSchema.parse(destroy.body)).toEqual({ code: 'incompatible_state', error: RUN_IN_USE_ELSEWHERE });
    expect(answers.filter((answer) => answer !== destroy).every((answer) => Object.keys(answer.body).join() === 'error')).toBe(true);
    expect(readPersistedRuns(dataDir)).toEqual(before);
    expect(store.heldIds()).toEqual([]);

    const detail = await apiRequest(app, `/api/v1/runs/${runId}`);
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { title: string }).title).toBe('theirs');
    const list = await apiRequest(app, '/api/v1/run-summaries');
    expect(((await list.json()) as Array<{ id: string }>).map((run) => run.id)).toEqual([runId]);
  });

  it('Stop on a run whose owner died adopts it: it ends settled, not left running for nobody', async () => {
    // The owner crashed: its claim is still there, under a session no live process has open.
    const raw = new DatabaseSync(join(dataDir, RUNS_DB_FILE));
    raw.prepare("UPDATE run_claims SET session = 'crashed-owner'").run();
    raw.close();
    expect(store.runOwnership(runId)).toBe('orphaned');

    const response = await apiRequest(app, `/api/v1/runs/${runId}/cancel`, { method: 'POST' });
    // Adoption settled it as interrupted, so nothing was left for Stop itself to cancel.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelled: false });
    expect(store.getRun(runId)).toMatchObject({ status: 'failed', error: expect.stringContaining('interrupted') });
    store.flush();
    expect(readPersistedRuns(dataDir).find((run) => run.id === runId)).toMatchObject({ status: 'failed' });
    // Settled and let go: nobody claims it now.
    expect(store.runOwnership(runId)).toBe('free');
  });

  it('a control on its own runs is not refused', async () => {
    const mine = store.createRun({ title: 'mine', workflow: 'quick-task', task: 'mine', steps: [] });
    const response = await apiRequest(app, `/api/v1/runs/${mine.id}/pin`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { pinned?: boolean }).pinned).toBe(true);
  });
});

/**
 * A control on a run whose owner died adopts it first (#779, plan step 3). Adopting never starts
 * or resumes agent work: Continue is the one control that may, and it does so with the user's own
 * input. A manager with a free slot and the mock runner, so anything recovery queued would run.
 */
describe('adopting a dead owner\'s run for a control', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let manager: RunManager;
  let app: Hono;
  let started: string[];
  const savedDryRun = process.env.CEZ_DRY_RUN;
  const savedAutoName = process.env.CEZ_AUTONAME;

  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_AUTONAME = '0';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-run-adoption-'));
    dataDir = join(repoRoot, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    store = RunStore.open(dataDir, { keepLive: true });
    manager = createFixtureManager(store, repoRoot, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 1 } }) });
    started = [];
    const engine = manager as unknown as Record<'execute' | 'runContinuation', (...args: unknown[]) => Promise<unknown>>;
    for (const name of ['execute', 'runContinuation'] as const) {
      const real = engine[name].bind(manager);
      engine[name] = (...args) => { started.push(name); return real(...args); };
    }
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    store.close();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    if (savedAutoName === undefined) delete process.env.CEZ_AUTONAME;
    else process.env.CEZ_AUTONAME = savedAutoName;
  });

  /** A run a `cez run` process left behind when it crashed: never started, or mid-turn. */
  const crashed = (shape: 'unstarted' | 'running'): string => {
    const owner = RunStore.open(dataDir, { keepLive: true });
    const run = owner.createRun({ title: shape, workflow: 'quick-task', task: 'mock:done', runner: 'claude', workflowDef: QUICK_TASK_WORKFLOW,
      steps: [{ id: 'task', name: 'Do the task', kind: 'agent' }] });
    if (shape === 'running') {
      const at = new Date().toISOString();
      owner.updateStep(run.id, 'task', { status: 'running', startedAt: at, sessionId: 'previous-session', backend: 'claude' });
      owner.updateRun(run.id, { status: 'running', startedAt: at, currentStepId: 'task' });
    }
    owner.flush();
    crashStore(owner);
    expect(store.runOwnership(run.id)).toBe('orphaned');
    return run.id;
  };
  /** Long enough for anything recovery queued to reach the runner. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  it.each([
    ['archive', 'unstarted', 'POST', '/archive'], ['archive', 'running', 'POST', '/archive'],
    ['pin', 'running', 'POST', '/pin'], ['read', 'running', 'POST', '/read'],
    ['delete', 'unstarted', 'DELETE', ''], ['delete', 'running', 'DELETE', ''],
  ] as const)('%s on an adopted %s run starts no agent and applies', async (_name, shape, method, suffix) => {
    const id = crashed(shape);
    const response = await apiRequest(app, `/api/v1/runs/${id}${suffix}`, { method });
    expect(response.status).toBe(200);
    await settle();
    expect(started).toEqual([]);
    expect(manager.isActive(id)).toBe(false);
    if (method === 'DELETE') {
      expect(store.getRun(id)).toBeUndefined();
      return;
    }
    // Settled, never resumed: interrupted mid-turn, or cancelled before it ever began.
    expect(store.getRun(id)).toMatchObject(shape === 'running'
      ? { status: 'failed', error: expect.stringContaining('interrupted') } : { status: 'cancelled' });
  });

  it.each(['unstarted', 'running'] as const)('Continue on an adopted %s run resumes it with the user\'s input', async (shape) => {
    const id = crashed(shape);
    const response = await apiRequest(app, `/api/v1/runs/${id}/continue`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'carry on from here' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ continued: true });
    await settle();
    // Restarted as the untouched workflow it was, or its last session resumed with the user's message.
    expect(started).toEqual([shape === 'running' ? 'runContinuation' : 'execute']);
    if (shape === 'running') expect(store.readEvents(id).some((event) => JSON.stringify(event).includes('carry on from here'))).toBe(true);
    else expect(store.getRun(id)?.status).not.toBe('cancelled');
  });
});
