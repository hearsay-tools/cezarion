import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import { clearProjectProbeCache, registerProject } from '../workspace/projects.ts';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { workspaceConfigPath } from '../paths.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, type ServerDeps } from './server.ts';

/**
 * The task webhook's HTTP surface (#589): the registry field and its write-only token, the
 * `notify` opt-in on `POST /runs`, `POST /runs/:id/notify`, and "Send test".
 */
describe('task webhook API', () => {
  const saved = { home: process.env.CEZ_HOME, dryRun: process.env.CEZ_DRY_RUN, single: process.env.CEZ_SINGLE_PROJECT };
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let projectId: string;
  let started: StartRunInput[];
  let posted: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>;

  const fakeFetch = (async (url: string, init: RequestInit) => {
    posted.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;

  beforeEach(async () => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-webhook-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-webhook-repo-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_SINGLE_PROJECT;
    clearProjectProbeCache();
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    projectId = (await registerProject(repoRoot)).id;
    started = [];
    posted = [];
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    for (const [key, env] of [['home', 'CEZ_HOME'], ['dryRun', 'CEZ_DRY_RUN'], ['single', 'CEZ_SINGLE_PROJECT']] as const) {
      if (saved[key] === undefined) delete process.env[env];
      else process.env[env] = saved[key];
    }
  });

  const manager = {
    startRun: (_workflow: unknown, input: StartRunInput) => {
      started.push(input);
      return store.createRun({ title: input.task, workflow: 'quick-task', task: input.task, notify: input.notify, steps: [] });
    },
  } as unknown as RunManager;

  const makeApp = (over: Partial<ServerDeps> = {}) =>
    createApp({ repoRoot, store, manager, version: '0.0.0-test', bootProjectId: projectId, taskWebhookFetch: fakeFetch, ...over });

  const send = async (path: string, method: string, body?: unknown, over: Partial<ServerDeps> = {}) => {
    const res = await apiRequest(makeApp(over), path, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  const setWebhook = (webhook: unknown) => send(`/api/v1/projects/${projectId}`, 'PATCH', { webhook });

  describe('the registry field', () => {
    it('stores the token and never answers it — only tokenSet', async () => {
      const saved = await setWebhook({ url: 'https://bot.example/hook', token: 'secret-token' });
      expect(saved.status).toBe(200);
      expect(saved.body.project).toMatchObject({ webhook: { url: 'https://bot.example/hook', tokenSet: true } });

      const listed = await send('/api/v1/projects', 'GET');
      expect(JSON.stringify(listed.body)).not.toContain('secret-token');
      expect((listed.body.projects as Array<Record<string, unknown>>)[0]!.webhook).toEqual({ url: 'https://bot.example/hook', tokenSet: true });
      const health = await send('/api/v1/health', 'GET');
      expect(JSON.stringify(health.body)).not.toContain('secret-token');

      // The token is in the 0600 registry, where the dispatcher reads it.
      expect(readFileSync(workspaceConfigPath(), 'utf8')).toContain('secret-token');
    });

    it('keeps the stored token when a PATCH changes only the URL, and clears it on an empty token', async () => {
      await setWebhook({ url: 'https://bot.example/hook', token: 'secret-token' });
      await setWebhook({ url: 'https://bot.example/other' });
      let entry = (await loadWorkspaceConfig()).projects.find((p) => p.id === projectId)!;
      expect(entry.webhook).toEqual({ url: 'https://bot.example/other', token: 'secret-token' });

      const cleared = await setWebhook({ url: 'https://bot.example/other', token: '' });
      expect(cleared.body.project).toMatchObject({ webhook: { tokenSet: false } });
      entry = (await loadWorkspaceConfig()).projects.find((p) => p.id === projectId)!;
      expect(entry.webhook).toEqual({ url: 'https://bot.example/other' });
    });

    it('removes the webhook on null and refuses a non-http URL', async () => {
      await setWebhook({ url: 'https://bot.example/hook', token: 't' });
      const removed = await setWebhook(null);
      expect(removed.status).toBe(200);
      expect((removed.body.project as Record<string, unknown>).webhook).toBeUndefined();
      expect((await setWebhook({ url: 'file:///etc/passwd' })).status).toBe(400);
      // Node's fetch refuses a URL with userinfo before sending, so it could be saved and never
      // deliver (#594 review). The token is the credential.
      const withCredentials = await setWebhook({ url: 'https://user:secret@bot.example/hook' });
      expect(withCredentials.status).toBe(400);
      expect(String(withCredentials.body.error)).toContain('credentials');
      expect((await setWebhook({ url: 'https://user@bot.example/hook' })).status).toBe(400);
    });
  });

  describe('POST /runs notify', () => {
    const start = (body: Record<string, unknown>) =>
      send('/api/v1/runs', 'POST', { task: 'do it', workflow: 'quick-task', ...body });

    it('answers 400 with a hint for an explicit notify:true on a project without a webhook', async () => {
      const res = await start({ notify: true });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain('no task webhook');
      expect(started).toEqual([]);
    });

    it('persists notify on the record when the project has a webhook', async () => {
      await setWebhook({ url: 'https://bot.example/hook', token: 't' });
      const res = await start({ notify: true });
      expect(res.status).toBe(201);
      expect(started[0]!.notify).toBe(true);
      expect((res.body as unknown as RunRecord).notify).toBe(true);
    });

    it('leaves notify off when the body says nothing', async () => {
      const res = await start({});
      expect(res.status).toBe(201);
      expect((res.body as unknown as RunRecord).notify).toBeUndefined();
    });
  });

  describe('POST /runs/:id/notify', () => {
    const run = () => store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });

    it('turns notify on, records a handoff event and logs task.subscribed (dry run)', async () => {
      await setWebhook({ url: 'https://bot.example/hook', token: 't' });
      const { id } = run();
      const res = await send(`/api/v1/runs/${id}/notify`, 'POST', { notify: true, message: 'take over from here' });
      expect(res.status).toBe(200);
      expect(res.body.notify).toBe(true);
      await new Promise((done) => setTimeout(done, 50));
      const events = store.readEvents(id);
      expect(events.find((event) => event.type === 'handoff')).toMatchObject({ notify: true, message: 'take over from here' });
      expect(events.find((event) => event.type === 'webhook.dry-run')).toMatchObject({
        event: 'task.subscribed',
        payload: { message: 'take over from here' },
      });
      expect(posted).toEqual([]);
    });

    it('POSTs task.subscribed with the Bearer token when not in dry run', async () => {
      delete process.env.CEZ_DRY_RUN;
      await setWebhook({ url: 'https://bot.example/hook', token: 'secret-token' });
      const { id } = run();
      await send(`/api/v1/runs/${id}/notify`, 'POST', { notify: true, message: 'note' });
      await new Promise((done) => setTimeout(done, 50));
      expect(posted).toHaveLength(1);
      expect(posted[0]!.headers.authorization).toBe('Bearer secret-token');
      expect(posted[0]!.body).toMatchObject({ event: 'task.subscribed', message: 'note', runId: id });
    });

    it('turns notify off in any state and records it', async () => {
      await setWebhook({ url: 'https://bot.example/hook', token: 't' });
      const { id } = run();
      store.updateRun(id, { status: 'done', notify: true });
      const res = await send(`/api/v1/runs/${id}/notify`, 'POST', { notify: false });
      expect(res.status).toBe(200);
      expect(store.getRun(id)?.notify).toBeUndefined();
      expect(store.readEvents(id).find((event) => event.type === 'handoff')).toMatchObject({ notify: false });
    });

    it('answers 400 without a webhook, 404 for an unknown run, 400 for a bad body', async () => {
      const { id } = run();
      expect((await send(`/api/v1/runs/${id}/notify`, 'POST', { notify: true })).status).toBe(400);
      expect((await send('/api/v1/runs/nope/notify', 'POST', { notify: false })).status).toBe(404);
      expect((await send(`/api/v1/runs/${id}/notify`, 'POST', { notify: 'yes' })).status).toBe(400);
      expect((await send(`/api/v1/runs/${id}/notify`, 'POST', { notify: false, message: 'x'.repeat(100_001) })).status).toBe(400);
    });
  });

  describe('recovery (#589 review)', () => {
    it('reports the transitions a lazily built project makes while recovering', async () => {
      const other = mkdtempSync(join(realpathSync(tmpdir()), 'cez-webhook-other-'))
      try {
        // A run that was live when the last process exited: recovery moves it on, and that move
        // is exactly what an opted-in bot is waiting for.
        mkdirSync(join(other, '.ai/cezar'), { recursive: true });
        writeFileSync(join(other, '.ai/cezar/runs.json'), JSON.stringify([{
          id: 'live', title: 'live', task: 'live', workflow: 'quick-task', status: 'running', notify: true,
          createdAt: '2026-09-25T10:00:00.000Z', tokensUsed: 0, archived: false, steps: [],
        }]));
        const entry = await registerProject(other);
        await mergeWriteWorkspaceConfig((config) => {
          config.projects.find((p) => p.id === entry.id)!.webhook = { url: 'https://bot.example/hook', token: 't' };
        });
        const app = makeApp({ semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
        const res = await apiRequest(app, `/api/v1/p/${entry.id}/runs/live`);
        const after = (await res.json()) as RunRecord;
        expect(after.status).not.toBe('running');
        await vi.waitFor(() => {
          const events = RunStore.open(join(other, '.ai/cezar')).readEvents('live');
          expect(events.find((event) => event.type === 'webhook.dry-run')).toMatchObject({
            event: 'task.status',
            payload: { previousStatus: 'running', status: after.status },
          });
        });
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });
  });

  describe('POST /projects/:id/webhook/test', () => {
    it('sends one task.test delivery and reports the status', async () => {
      delete process.env.CEZ_DRY_RUN;
      await setWebhook({ url: 'https://bot.example/hook', token: 'secret-token' });
      const res = await send(`/api/v1/projects/${projectId}/webhook/test`, 'POST');
      expect(res.body).toEqual({ ok: true, status: 204 });
      expect(posted).toHaveLength(1);
      expect(posted[0]!.body).toMatchObject({ event: 'task.test', projectId });
    });

    it('sends nothing under dry run, and 400s without a webhook', async () => {
      expect((await send(`/api/v1/projects/${projectId}/webhook/test`, 'POST')).status).toBe(400);
      await setWebhook({ url: 'https://bot.example/hook' });
      const res = await send(`/api/v1/projects/${projectId}/webhook/test`, 'POST');
      expect(res.body).toEqual({ ok: true, dryRun: true });
      expect(posted).toEqual([]);
    });
  });
});
