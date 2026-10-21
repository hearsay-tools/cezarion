import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from './store.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { registerProject } from '../workspace/projects.ts';
import { WEBHOOK_TRIGGERS, type WebhookTrigger } from '@open-mercato/cezar-contract/attention';
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

  const attach = (fetchImpl: typeof fetch, extra: Partial<TaskWebhookOptions> = {}, triggers?: WebhookTrigger[]) => {
    hook = new TaskWebhook(store, {
      resolveProject: async () => ({
        id: 'proj',
        webhook: { url: 'https://bot.example/hook', token: 'secret-token', ...(triggers === undefined ? {} : { triggers }) },
      }),
      origin: () => 'http://127.0.0.1:4321',
      dataDir,
      dryRun: false,
      fetch: fetchImpl,
      sleep: async () => undefined,
      ...extra,
    });
    return hook;
  };

  it('POSTs each entry into a selected state with the Bearer token, in order', async () => {
    const { calls, fetchImpl } = recorder();
    const webhook = attach(fetchImpl, {}, ['running', 'needs-you']);
    const run = create(true);
    store.updateRun(run.id, { status: 'running' });
    store.updateRun(run.id, { status: 'waiting' });
    await webhook.idle();

    expect(calls.map((call) => [call.body.event, call.body.previousStatus, call.body.status, call.body.state])).toEqual([
      ['task.subscribed', null, 'queued', null],
      ['task.status', 'queued', 'running', 'running'],
      ['task.status', 'running', 'waiting', 'needs-you'],
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

  it('sends a question as one task.question under Needs you, not a task.status beside it', async () => {
    const { calls, fetchImpl } = recorder();
    const webhook = attach(fetchImpl);
    const run = optedIn();
    store.updateRun(run.id, { status: 'running' });
    // The ask lands mid-turn, while the run still runs; the park is what enters Needs you.
    store.updateRun(run.id, { hasPendingHumanAsk: true });
    store.updateRun(run.id, { status: 'waiting' });
    await webhook.idle();
    expect(calls.map((call) => [call.body.event, call.body.state, call.body.previousStatus])).toEqual([
      ['task.question', 'needs-you', 'running'],
    ]);
  });

  it('with no stored triggers sends only Needs you, Failed, Done and Cancelled', async () => {
    const { calls, fetchImpl } = recorder();
    const webhook = attach(fetchImpl);
    const enter = (patch: Parameters<RunStore['updateRun']>[1]) => {
      const run = optedIn();
      store.updateRun(run.id, { status: 'running' });
      store.updateRun(run.id, patch);
    };
    enter({ status: 'waiting' });
    enter({ status: 'failed' });
    enter({ status: 'waiting', autoResumeAt: '2026-10-20T23:00:00.000Z' });
    enter({ status: 'done' });
    enter({ status: 'cancelled' });
    enter({ status: 'queued' });
    await webhook.idle();
    expect(calls.map((call) => call.body.state).sort()).toEqual(['cancelled', 'done', 'failed', 'needs-you']);
  });

  it('sends nothing but task.subscribed for an empty selection', async () => {
    const { calls, fetchImpl } = recorder();
    const webhook = attach(fetchImpl, {}, []);
    const run = create(true);
    store.updateRun(run.id, { status: 'running' });
    store.updateRun(run.id, { status: 'done' });
    await webhook.idle();
    expect(calls.map((call) => call.body.event)).toEqual(['task.subscribed']);
  });

  it('sends nothing when the run leaves a selected state for an unselected one, and one delivery on re-entry', async () => {
    const { calls, fetchImpl } = recorder();
    const webhook = attach(fetchImpl, {}, ['running']);
    const run = optedIn();
    store.updateRun(run.id, { status: 'running' });
    store.updateRun(run.id, { title: 'renamed' });
    store.updateRun(run.id, { status: 'waiting' });
    store.updateRun(run.id, { status: 'running' });
    await webhook.idle();
    expect(calls.map((call) => [call.body.state, call.body.seq])).toEqual([['running', 1], ['running', 2]]);
  });

  it('reads the selection per delivery, so a settings change applies without a restart', async () => {
    const { calls, fetchImpl } = recorder();
    let triggers: WebhookTrigger[] = ['done'];
    const webhook = attach(fetchImpl, {
      resolveProject: async () => ({ id: 'proj', webhook: { url: 'https://bot.example/hook', triggers } }),
    });
    const first = optedIn();
    store.updateRun(first.id, { status: 'running' });
    await webhook.idle();
    triggers = ['running'];
    const second = optedIn();
    store.updateRun(second.id, { status: 'running' });
    await webhook.idle();
    expect(calls.map((call) => call.body.runId)).toEqual([second.id]);
  });

  // hearsay-tools/cezarion#1233: a CI park is `waiting` with an open wait; no activity is written.
  it('with waiting-ci selected sends one delivery each time a run starts waiting on CI', async () => {
    const { calls, fetchImpl } = recorder();
    const webhook = attach(fetchImpl, {}, ['waiting-ci']);
    const run = optedIn();
    store.updateRun(run.id, { status: 'running' });
    const now = Date.now();
    store.commitWait(run.id, { id: '55555555-5555-4555-8555-555555555555', kind: 'ci', source: 'agent', via: 'cezar_wait',
      registeredAt: new Date(now).toISOString(), deadline: new Date(now + 1_800_000).toISOString(), phase: 'open', turnId: 'turn-1',
      prUrl: 'https://github.com/o/r/pull/12', repository: 'o/r', prNumber: 12, headSha: 'a'.repeat(40), generation: 'gen-1', timeoutSeconds: 1800 });
    store.updateRun(run.id, { status: 'waiting', activity: undefined });
    store.updateRun(run.id, { title: 'still on CI' });
    store.updateRun(run.id, { status: 'running' });
    store.updateRun(run.id, { status: 'waiting' });
    await webhook.idle();
    expect(calls.map((call) => call.body.event)).toEqual(['task.status', 'task.status']);
    expect(calls.at(-1)!.body).toMatchObject({
      event: 'task.status', state: 'waiting-ci', status: 'waiting', previousStatus: 'running', activity: null,
      task: { status: 'waiting', attentionLabel: 'waiting for CI' },
    });
  });

  it('only waits it has no option for match waiting-other', async () => {
    const { calls, fetchImpl } = recorder();
    const webhook = attach(fetchImpl, {}, WEBHOOK_TRIGGERS.filter((trigger) => trigger !== 'needs-you'));
    const run = optedIn();
    store.updateRun(run.id, { status: 'running' });
    // No wait kind the store writes today lacks an option, so the record a later kind would
    // produce goes straight to the subscriber, on the emission the store fires for every write.
    const parked = { ...store.getRun(run.id)!, status: 'waiting' as const, waitingOn: { kind: 'future-wait' } };
    store.emit('run', parked);
    await webhook.idle();
    // The store's own record is still `running`; only the emitted one parked.
    expect(calls.map((call) => call.body.state).slice(0, 2)).toEqual(['running', 'waiting-other']);
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
    store.updateRun(run.id, { status: 'done' });
    await webhook.idle();

    expect(calls).toHaveLength(WEBHOOK_ATTEMPTS);
    // One deliveryId across the retries, so a receiver can dedupe.
    expect(new Set(calls.map((call) => call.body.deliveryId)).size).toBe(1);
    const after = store.getRun(run.id)!;
    expect(after.status).toBe('done');
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
    store.updateRun(run.id, { status: 'done' });
    await webhook.idle();
    expect(calls).toHaveLength(WEBHOOK_ATTEMPTS);
    expect(store.getRun(run.id)?.webhook?.lastError).toBe('timed out');
    expect(store.getRun(run.id)?.status).toBe('done');
  });

  it('does not retry a 4xx the endpoint meant', async () => {
    const { calls, fetchImpl } = recorder(() => new Response(null, { status: 401 }));
    const webhook = attach(fetchImpl);
    const run = optedIn();
    store.updateRun(run.id, { status: 'done' });
    await webhook.idle();
    expect(calls).toHaveLength(1);
    expect(store.getRun(run.id)?.webhook?.lastError).toBe('HTTP 401');
  });

  it('under dry run sends nothing and logs the payload as a run event', async () => {
    const { calls, fetchImpl } = recorder();
    const webhook = attach(fetchImpl, { dryRun: true });
    const run = optedIn();
    store.updateRun(run.id, { status: 'done' });
    await webhook.idle();
    expect(calls).toEqual([]);
    const logged = store.readEvents(run.id).filter((event) => event.type === 'webhook.dry-run');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ event: 'task.status', payload: { status: 'done', previousStatus: 'queued', state: 'done' } });
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
    store.updateRun(run.id, { status: 'done' });
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
