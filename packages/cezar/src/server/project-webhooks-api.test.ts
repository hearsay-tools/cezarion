import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, registerProject } from '../workspace/projects.ts';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { workspaceConfigPath } from '../paths.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, type ServerDeps } from './server.ts';

/**
 * Several webhooks per project (hearsay-tools/cezarion#1576): the settings routes, the upgrade
 * from the single `webhook` key, and the agent interface that lists and triggers only the
 * webhooks the owner exposed.
 */
describe('project webhooks API', () => {
  const saved = { home: process.env.CEZ_HOME, dryRun: process.env.CEZ_DRY_RUN, single: process.env.CEZ_SINGLE_PROJECT };
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let projectId: string;
  let posted: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>;

  const fakeFetch = (async (url: string, init: RequestInit) => {
    posted.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return new Response(null, { status: url.includes('broken') ? 500 : 204 });
  }) as unknown as typeof fetch;

  beforeEach(async () => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-webhooks-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-webhooks-repo-'));
    process.env.CEZ_HOME = home;
    delete process.env.CEZ_DRY_RUN;
    delete process.env.CEZ_SINGLE_PROJECT;
    clearProjectProbeCache();
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    projectId = (await registerProject(repoRoot)).id;
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

  const manager = {} as unknown as RunManager;
  const app = (over: Partial<ServerDeps> = {}) =>
    createApp({ repoRoot, store, manager, version: '0.0.0-test', bootProjectId: projectId, taskWebhookFetch: fakeFetch, ...over });
  const send = async (path: string, method: string, body?: unknown) => {
    const res = await apiRequest(app(), path, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const create = (body: Record<string, unknown>) => send(`/api/v1/projects/${projectId}/webhooks`, 'POST', body);
  const webhooksOf = (body: Record<string, unknown>) => (body.project as { webhooks?: Array<Record<string, unknown>> }).webhooks ?? [];
  const stored = async () => (await loadWorkspaceConfig()).projects.find((p) => p.id === projectId)!;

  const friction = {
    name: 'Friction reports',
    description: 'Send friction you hit with tools here instead of filing a GitHub issue.',
    url: 'https://grok.example/friction',
    token: 'friction-token',
    agent: true,
  };

  describe('settings', () => {
    it('creates independent webhooks, each with its own name, selection and switches, and never answers a token', async () => {
      const first = await create({ name: 'Task bot', url: 'https://bot.example/hook', token: 'secret-token', tasks: true, triggers: ['done'] });
      expect(first.status).toBe(201);
      expect(first.body.webhook).toEqual({
        id: expect.any(String), name: 'Task bot', url: 'https://bot.example/hook', tokenSet: true, tasks: true, triggers: ['done'], agent: false,
      });
      const second = await create(friction);
      expect(second.status).toBe(201);
      expect(webhooksOf(second.body).map((webhook) => [webhook.name, webhook.tasks, webhook.agent])).toEqual([
        ['Task bot', true, false],
        ['Friction reports', false, true],
      ]);
      // The legacy single-webhook field stays the first task webhook, for older clients.
      expect(second.body.project).toMatchObject({ webhook: { url: 'https://bot.example/hook', tokenSet: true, triggers: ['done'] } });

      const listed = await send('/api/v1/projects', 'GET');
      expect(JSON.stringify(listed.body)).not.toContain('secret-token');
      expect(JSON.stringify(listed.body)).not.toContain('friction-token');
      expect(readFileSync(workspaceConfigPath(), 'utf8')).toContain('friction-token');
    });

    it('edits one webhook without changing another, keeping the token unless named', async () => {
      const a = (await create({ name: 'A', url: 'https://a.example/hook', token: 'a-token', tasks: true })).body.webhook as { id: string };
      await create({ name: 'B', url: 'https://b.example/hook', triggers: ['failed'] });
      const before = (await stored()).webhooks![1];

      const edited = await send(`/api/v1/projects/${projectId}/webhooks/${a.id}`, 'PATCH', { description: 'About A', triggers: ['running'], agent: true });
      expect(edited.status).toBe(200);
      expect(edited.body.webhook).toMatchObject({ name: 'A', description: 'About A', tokenSet: true, triggers: ['running'], agent: true });
      expect((await stored()).webhooks![1]).toEqual(before);

      const cleared = await send(`/api/v1/projects/${projectId}/webhooks/${a.id}`, 'PATCH', { token: '', description: '' });
      expect(cleared.body.webhook).toMatchObject({ tokenSet: false });
      expect(cleared.body.webhook).not.toHaveProperty('description');
    });

    it('refuses a duplicate name, ignoring case, and an unknown webhook', async () => {
      await create({ name: 'Task bot', url: 'https://bot.example/hook' });
      const duplicate = await create({ name: 'task BOT', url: 'https://other.example/hook' });
      expect(duplicate.status).toBe(409);
      expect(String(duplicate.body.error)).toContain('already has a webhook named');
      expect((await send(`/api/v1/projects/${projectId}/webhooks/nope`, 'PATCH', { name: 'x' })).status).toBe(404);
      expect((await send(`/api/v1/projects/${projectId}/webhooks/nope`, 'DELETE')).status).toBe(404);
      expect((await send(`/api/v1/projects/unknown-project/webhooks`, 'POST', { name: 'x', url: 'https://x.example' })).status).toBe(404);
    });

    it('refuses a body with no field or a missing name', async () => {
      const a = (await create({ name: 'A', url: 'https://a.example/hook' })).body.webhook as { id: string };
      expect((await send(`/api/v1/projects/${projectId}/webhooks/${a.id}`, 'PATCH', {})).status).toBe(400);
      expect((await create({ name: '  ', url: 'https://a.example/hook' })).status).toBe(400);
    });

    it('removes one webhook and leaves the rest; removing the last removes the key', async () => {
      const a = (await create({ name: 'A', url: 'https://a.example/hook' })).body.webhook as { id: string };
      const b = (await create({ name: 'B', url: 'https://b.example/hook' })).body.webhook as { id: string };
      const removed = await send(`/api/v1/projects/${projectId}/webhooks/${a.id}`, 'DELETE');
      expect(webhooksOf(removed.body).map((webhook) => webhook.name)).toEqual(['B']);
      await send(`/api/v1/projects/${projectId}/webhooks/${b.id}`, 'DELETE');
      const entry = await stored();
      expect(entry.webhooks).toBeUndefined();
      expect(entry.webhook).toBeUndefined();
    });

    it('sends a test delivery to the webhook it names', async () => {
      await create({ name: 'A', url: 'https://a.example/hook' });
      const b = (await create({ name: 'B', url: 'https://b.example/hook', token: 'b-token' })).body.webhook as { id: string };
      const answer = await send(`/api/v1/projects/${projectId}/webhooks/${b.id}/test`, 'POST');
      expect(answer.body).toEqual({ ok: true, status: 204 });
      expect(posted.map((call) => [call.url, call.body.event, call.headers.authorization])).toEqual([['https://b.example/hook', 'task.test', 'Bearer b-token']]);
      expect(posted[0]!.body.webhook).toEqual({ id: b.id, name: 'B' });
    });
  });

  describe('upgrade from the single webhook key', () => {
    const seedLegacy = () =>
      mergeWriteWorkspaceConfig((config) => {
        config.projects.find((p) => p.id === projectId)!.webhook = { url: 'https://bot.example/hook', token: 'legacy-token', triggers: ['done', 'failed'] };
      });

    it('reads it as one "Task webhook" with task notifications on and closed to agents', async () => {
      await seedLegacy();
      const listed = await send('/api/v1/projects', 'GET');
      const entry = (listed.body.projects as Array<Record<string, unknown>>)[0]!;
      expect(entry.webhook).toEqual({ url: 'https://bot.example/hook', tokenSet: true, triggers: ['done', 'failed'] });
      expect(entry.webhooks).toEqual([
        { id: 'task-webhook', name: 'Task webhook', url: 'https://bot.example/hook', tokenSet: true, tasks: true, triggers: ['done', 'failed'], agent: false },
      ]);
      expect((await send('/api/v1/agent-webhooks', 'GET')).body).toEqual({ webhooks: [] });
    });

    it('keeps it, token included, when the first write adds a second webhook, and drops the old key', async () => {
      await seedLegacy();
      await create(friction);
      const entry = await stored();
      expect(entry.webhook).toBeUndefined();
      expect(entry.webhooks?.map((webhook) => [webhook.id, webhook.name, webhook.token, webhook.tasks, webhook.triggers])).toEqual([
        ['task-webhook', 'Task webhook', 'legacy-token', true, ['done', 'failed']],
        [expect.any(String), 'Friction reports', 'friction-token', false, undefined],
      ]);
    });

    it('still accepts the old PATCH body, editing the first task webhook only', async () => {
      await seedLegacy();
      await create(friction);
      const patched = await send(`/api/v1/projects/${projectId}`, 'PATCH', { webhook: { url: 'https://bot.example/moved' } });
      expect(patched.status).toBe(200);
      expect(webhooksOf(patched.body).map((webhook) => [webhook.name, webhook.url, webhook.tokenSet])).toEqual([
        ['Task webhook', 'https://bot.example/moved', true],
        ['Friction reports', 'https://grok.example/friction', true],
      ]);
      const removed = await send(`/api/v1/projects/${projectId}`, 'PATCH', { webhook: null });
      expect(webhooksOf(removed.body).map((webhook) => webhook.name)).toEqual(['Friction reports']);
      expect((removed.body.project as Record<string, unknown>).webhook).toBeUndefined();
    });
  });

  describe('agent interface', () => {
    it('lists only exposed webhooks, by name and description, never the URL', async () => {
      await create({ name: 'Task bot', url: 'https://bot.example/hook', tasks: true });
      await create(friction);
      const listed = await send('/api/v1/agent-webhooks', 'GET');
      expect(listed.body).toEqual({ webhooks: [{ id: expect.any(String), name: 'Friction reports', description: friction.description }] });
      expect(JSON.stringify(listed.body)).not.toContain('grok.example');
      // The project-scoped alias answers the same.
      expect((await send(`/api/v1/p/${projectId}/agent-webhooks`, 'GET')).body).toEqual(listed.body);
    });

    it('sends a friction report through an exposed webhook, by name, and records it on the task', async () => {
      await create(friction);
      const run = store.createRun({ title: 't', workflow: 'quick-task', task: 'do it', steps: [] });
      const answer = await send(`/api/v1/p/${projectId}/agent-webhooks/${encodeURIComponent('friction REPORTS')}`, 'POST', {
        runId: run.id,
        title: 'Squeal denied one edit in a batch',
        message: 'The second Edit was skipped silently.',
      });
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ ok: true, status: 204, attempts: 1, webhook: { name: 'Friction reports' } });
      expect(posted).toHaveLength(1);
      expect(posted[0]!.url).toBe('https://grok.example/friction');
      expect(posted[0]!.headers.authorization).toBe('Bearer friction-token');
      expect(posted[0]!.body).toMatchObject({ event: 'agent.report', runId: run.id, title: 'Squeal denied one edit in a batch' });
      expect(store.readEvents(run.id).map((event) => event.type)).toContain('webhook.report');
    });

    it('answers a webhook without agent access exactly like an unknown one, and sends nothing', async () => {
      const hidden = (await create({ name: 'Task bot', url: 'https://bot.example/hook', tasks: true })).body.webhook as { id: string };
      const byName = await send('/api/v1/agent-webhooks/Task%20bot', 'POST', { message: 'hi' });
      const byId = await send(`/api/v1/agent-webhooks/${hidden.id}`, 'POST', { message: 'hi' });
      const unknown = await send('/api/v1/agent-webhooks/Nobody', 'POST', { message: 'hi' });
      expect([byName.status, byId.status, unknown.status]).toEqual([404, 404, 404]);
      expect(byName.body.error).toBe(String(unknown.body.error).replace('Nobody', 'Task bot'));
      expect(posted).toEqual([]);
    });

    it('answers a delivery failure with the webhook named and the error', async () => {
      await create({ ...friction, url: 'https://broken.example/hook' });
      const answer = await send('/api/v1/agent-webhooks/Friction%20reports', 'POST', { message: 'm' });
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ ok: false, status: 500, error: 'HTTP 500', webhook: { name: 'Friction reports' } });
    });

    it('refuses an empty message', async () => {
      await create(friction);
      expect((await send('/api/v1/agent-webhooks/Friction%20reports', 'POST', { message: '  ' })).status).toBe(400);
    });
  });
});
