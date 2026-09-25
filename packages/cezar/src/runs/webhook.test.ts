import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from './store.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { registerProject } from '../workspace/projects.ts';
import { TaskWebhook, TaskWebhooks, WEBHOOK_ATTEMPTS, type TaskWebhookOptions } from './webhook.ts';

/** The task webhook (#589): what a store transition turns into on the wire, and what a failing
 *  endpoint is allowed to change (the record's `webhook` outcome and one thread event — never
 *  the run's status). */

interface Call { url: string; headers: Record<string, string>; body: Record<string, unknown> }

function recorder(answer: (call: Call, index: number) => Response | Promise<Response> = () => new Response(null, { status: 204 })) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> };
    calls.push(call);
    return answer(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('TaskWebhook', () => {
  let dataDir: string;
  let store: RunStore;
  let hook: TaskWebhook | undefined;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-webhook-'));
    store = RunStore.open(dataDir);
  });
  afterEach(() => {
    hook?.dispose();
    store.flush();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const create = (notify: boolean) =>
    store.createRun({ title: 't', workflow: 'quick-task', task: 'do it', notify, steps: [{ id: 's', name: 's', kind: 'agent' }] });
  /** Opted in AFTER creation, so a case about transitions sees no creation-time task.subscribed. */
  const optedIn = () => {
    const run = create(false);
    return store.updateRun(run.id, { notify: true })!;
  };

  const attach = (fetchImpl: typeof fetch, extra: Partial<TaskWebhookOptions> = {}) => {
    hook = new TaskWebhook(store, {
      resolveProject: async () => ({ id: 'proj', webhook: { url: 'https://bot.example/hook', token: 'secret-token' } }),
      origin: () => 'http://127.0.0.1:4321',
      dataDir,
      dryRun: false,
      fetch: fetchImpl,
      sleep: async () => undefined,
      ...extra,
    });
    return hook;
  };

  it('POSTs every status transition of an opted-in run with the Bearer token, in order', async () => {
    const { calls, fetchImpl } = recorder();
    const webhook = attach(fetchImpl);
    const run = create(true);
    store.updateRun(run.id, { status: 'running' });
    store.updateRun(run.id, { status: 'waiting' });
    await webhook.idle();

    expect(calls.map((call) => [call.body.event, call.body.previousStatus, call.body.status])).toEqual([
      ['task.subscribed', null, 'queued'],
      ['task.status', 'queued', 'running'],
      ['task.status', 'running', 'waiting'],
    ]);
    expect(calls[0]!.url).toBe('https://bot.example/hook');
    expect(calls[0]!.headers.authorization).toBe('Bearer secret-token');
    expect(calls.map((call) => call.body.seq)).toEqual([1, 2, 3]);
    expect(calls[2]!.body).toMatchObject({
      projectId: 'proj',
      runId: run.id,
      url: `http://127.0.0.1:4321/p/proj/tasks/${run.id}`,
      task: { id: run.id, status: 'waiting', notify: true },
    });
    expect(store.getRun(run.id)?.webhook?.lastDeliveredAt).toBeTruthy();
  });

  it('sends nothing for a run that did not opt in', async () => {
    const { calls, fetchImpl } = recorder();
    const webhook = attach(fetchImpl);
    const quiet = create(false);
    store.updateRun(quiet.id, { status: 'running' });
    await webhook.idle();
    expect(calls).toEqual([]);
  });

  it('sends task.subscribed when a run is created opted in, so a queued run is announced (#594 review)', async () => {
    const { calls, fetchImpl } = recorder();
    const webhook = attach(fetchImpl);
    const run = create(true);
    await webhook.idle();
    expect(calls.map((call) => call.body.event)).toEqual(['task.subscribed']);
    expect(calls[0]!.body).toMatchObject({ runId: run.id, status: 'queued', previousStatus: null, seq: 1 });
    expect(calls[0]!.body).not.toHaveProperty('message');
  });

  it('reports monitoring on and off as task.activity, and a new question as task.question', async () => {
    const { calls, fetchImpl } = recorder();
    const webhook = attach(fetchImpl);
    const run = optedIn();
    store.updateRun(run.id, { status: 'running' });
    store.updateRun(run.id, { activity: 'monitoring' });
    store.updateRun(run.id, { activity: undefined });
    store.updateRun(run.id, { status: 'waiting', hasPendingHumanAsk: true });
    await webhook.idle();
    expect(calls.map((call) => [call.body.event, call.body.activity])).toEqual([
      ['task.status', null],
      ['task.activity', 'monitoring'],
      ['task.activity', null],
      ['task.status', null],
      ['task.question', null],
    ]);
  });

  it('sends task.subscribed with the hand-off note', async () => {
    const { calls, fetchImpl } = recorder();
    const webhook = attach(fetchImpl);
    const run = optedIn();
    webhook.subscribed(run.id, 'take over from here');
    await webhook.idle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ event: 'task.subscribed', message: 'take over from here', previousStatus: null });
  });

  it('retries a 5xx three times, then records the failure without touching the status', async () => {
    const { calls, fetchImpl } = recorder(() => new Response('down', { status: 503 }));
    const webhook = attach(fetchImpl);
    const run = optedIn();
    store.updateRun(run.id, { status: 'running' });
    await webhook.idle();

    expect(calls).toHaveLength(WEBHOOK_ATTEMPTS);
    // One deliveryId across the retries, so a receiver can dedupe.
    expect(new Set(calls.map((call) => call.body.deliveryId)).size).toBe(1);
    const after = store.getRun(run.id)!;
    expect(after.status).toBe('running');
    expect(after.webhook?.lastError).toBe('HTTP 503');
    const failed = store.readEvents(run.id).filter((event) => event.type === 'webhook.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ event: 'task.status', attempts: 3, status: 503 });
  });

  it('treats a timeout as a failed attempt', async () => {
    // An endpoint that never answers: the per-attempt deadline is what ends each try.
    const calls: Call[] = [];
    const timeoutFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: {}, body: {} });
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }) as unknown as typeof fetch;
    const webhook = attach(timeoutFetch, { timeoutMs: 10 });
    const run = optedIn();
    store.updateRun(run.id, { status: 'running' });
    await webhook.idle();
    expect(calls).toHaveLength(WEBHOOK_ATTEMPTS);
    expect(store.getRun(run.id)?.webhook?.lastError).toBe('timed out');
    expect(store.getRun(run.id)?.status).toBe('running');
  });

  it('does not retry a 4xx the endpoint meant', async () => {
    const { calls, fetchImpl } = recorder(() => new Response(null, { status: 401 }));
    const webhook = attach(fetchImpl);
    const run = optedIn();
    store.updateRun(run.id, { status: 'running' });
    await webhook.idle();
    expect(calls).toHaveLength(1);
    expect(store.getRun(run.id)?.webhook?.lastError).toBe('HTTP 401');
  });

  it('under dry run sends nothing and logs the payload as a run event', async () => {
    const { calls, fetchImpl } = recorder();
    const webhook = attach(fetchImpl, { dryRun: true });
    const run = optedIn();
    store.updateRun(run.id, { status: 'running' });
    await webhook.idle();
    expect(calls).toEqual([]);
    const logged = store.readEvents(run.id).filter((event) => event.type === 'webhook.dry-run');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ event: 'task.status', payload: { status: 'running', previousStatus: 'queued' } });
    expect(JSON.stringify(logged[0])).not.toContain('secret-token');
  });

  it('stops sending once the project webhook is removed', async () => {
    const { calls, fetchImpl } = recorder();
    const webhook = attach(fetchImpl, { resolveProject: async () => ({ id: 'proj' }) });
    const run = create(true);
    store.updateRun(run.id, { status: 'running' });
    await webhook.idle();
    expect(calls).toEqual([]);
  });

  it('does not report runs that already existed when it attached', async () => {
    const run = create(true);
    store.updateRun(run.id, { status: 'running' });
    const { calls, fetchImpl } = recorder();
    const webhook = attach(fetchImpl);
    store.updateRun(run.id, { title: 'renamed' });
    await webhook.idle();
    expect(calls).toEqual([]);
  });
});

describe('TaskWebhooks', () => {
  let dataDir: string;
  let root: string;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-webhooks-')));
    dataDir = join(root, '.ai/cezar');
    delete process.env.CEZ_DRY_RUN;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  it('holds recovery-time deliveries until the origin is known, and resolves the default alias by root', async () => {
    const entry = await registerProject(root);
    await mergeWriteWorkspaceConfig((config) => {
      config.projects.find((p) => p.id === entry.id)!.webhook = { url: 'https://bot.example/hook', token: 't' };
    });
    const store = RunStore.open(dataDir);
    const { calls, fetchImpl } = recorder();
    const hooks = new TaskWebhooks({ fetch: fetchImpl });
    const hook = hooks.attach({ id: 'default', root, store });
    expect(hooks.attach({ id: 'default', root, store })).toBe(hook);

    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', notify: true, steps: [] });
    store.updateRun(run.id, { status: 'running' });
    await new Promise((done) => setTimeout(done, 20));
    expect(calls).toEqual([]);

    hooks.setOrigin('http://127.0.0.1:4321');
    await hook.idle();
    expect(calls.map((call) => call.body.event)).toEqual(['task.subscribed', 'task.status']);
    expect(calls[1]!.body).toMatchObject({ projectId: entry.id, url: `http://127.0.0.1:4321/p/${entry.id}/tasks/${run.id}` });
    hook.dispose();
    store.flush();
  });
});
