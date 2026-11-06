import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { runtimeHomes } from './runtime-isolation.testkit.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { TaskWebhooks } from '../runs/webhook.ts';
import { RunStore } from '../runs/store.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { ProviderRuntimeAuthObserver } from '../server/provider-auth-runtime.ts';
import { ProviderAuthService } from '../core/provider-auth.ts';
import { createApp } from '../server/server.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import { agentWebhooksPart } from '../workflows/run/launch-context.ts';
import { createAutomationService } from '../automations/service.ts';
import { AutomationStore } from '../automations/store.ts';
import type { RunnerModelCatalog } from '../core/runner-model-catalog.ts';
import { Hono } from 'hono';
import { openRunCli } from '../server/open-in-targets.ts';

it('delivers task webhooks from the selected registry', async () => {
  const { root, selected } = runtimeHomes();
  vi.stubEnv('CEZ_DRY_RUN', '0');
  await mergeWriteWorkspaceConfig(config => { config.projects[0]!.webhook = { url: 'https://selected.invalid/hook' }; }, selected);
  const store = RunStore.open(join(root, 'runs'));
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }));
  const hooks = new TaskWebhooks({ home: selected, origin: 'http://localhost:4321', fetch });
  const hook = hooks.attach({ id: 'selected', root, store });
  try {
    const run = store.createRun({ title: 'Home', task: 'Home', workflow: 'quick-task', notify: true, steps: [] });
    setRunStatus(store, run.id, 'done');
    await hook.idle();
    expect(fetch).toHaveBeenCalledWith('https://selected.invalid/hook', expect.anything());
  } finally { hook.dispose(); store.close(); }
});

it('describes agent webhooks from the selected registry at launch', async () => {
  const { root, selected } = runtimeHomes();
  await mergeWriteWorkspaceConfig(config => {
    config.projects[0]!.webhooks = [{ id: 'selected-hook', name: 'Selected hook', url: 'https://selected.invalid/hook', tasks: false, agent: true }];
  }, selected);
  const prompt = await agentWebhooksPart({ repoRoot: root, dataDir: root, store: {} as RunStore, home: selected },
    { projectId: 'selected', origin: 'http://localhost:4321' });
  expect(prompt).toContain('Selected hook');
});

it('validates automation models with the selected default runner', async () => {
  const { root, selected } = runtimeHomes();
  const get = vi.fn(async () => ({ source: 'native', stale: false, models: [{ id: 'selected-model' }] }));
  const service = createAutomationService({ home: selected, timeZone: () => 'UTC',
    discovery: { models: { get } as unknown as RunnerModelCatalog, providers: async () => ({ providers: [] }) },
    scheduleHandle: () => { throw new Error('A paused schedule must not launch'); },
    emitChange: () => {}, changed: () => {}, hasGithubRemote: async () => false,
    githubAvailability: async () => ({ available: false, reason: 'none' }),
  });
  const project = { id: 'selected', root, automationStore: AutomationStore.open(root), store: {} as RunStore, manager: {} as RunManager };
  expect(await service.create(project, { name: 'Home', kind: 'schedule',
    schedule: { type: 'once', at: '2099-01-01T09:00', timeZone: 'UTC' },
    task: { prompt: 'Home isolation', model: 'selected-model' } })).toMatchObject({ ok: true });
  expect(get).toHaveBeenCalledWith('codex');
});

it('opens a fresh terminal CLI with the selected account', async () => {
  const { root, selected } = runtimeHomes();
  const store = RunStore.open(join(root, 'runs'));
  const openTerminal = vi.fn(async () => true);
  try {
    const run = store.createRun({ title: 'Home', task: 'Home', workflow: 'quick-task', steps: [] });
    const app = new Hono().get('/', c => openRunCli(c, run, 'claude', root, root, {
      home: selected, providerActionError: async () => null, resumeCommand: () => null,
      handoffEnv: async () => ({ env: {} }), handoffFallbackCommand: () => 'claude', openTerminal,
    }));
    expect((await app.request('/')).status).toBe(200);
    expect(openTerminal).toHaveBeenCalledWith(root, 'claude', { CLAUDE_CONFIG_DIR: join(root, 'selected-account') });
  } finally { store.close(); }
});

it('checks the failing account from the observer Home', async () => {
  const { root, selected } = runtimeHomes();
  vi.stubEnv('CEZ_DRY_RUN', '0');
  const store = RunStore.open(join(root, 'runs'));
  const auth = new ProviderAuthService();
  let resolveChecked!: (profile: unknown) => void;
  const checked = new Promise<unknown>(resolve => { resolveChecked = resolve; });
  vi.spyOn(auth, 'verifyRuntimeAuthFailure').mockImplementation(async (_provider, profile) => { resolveChecked(profile); return null; });
  const observer = new ProviderRuntimeAuthObserver(auth, () => {}, undefined, selected);
  observer.watch(store);
  try {
    const run = store.createRun({ title: 'Home', task: 'Home', workflow: 'quick-task', runner: 'claude', agentProfile: 'work', steps: [] });
    store.appendEvent(run.id, { type: 'error', message: '401 Unauthorized: authentication failed' });
    // bound: the resolver and observer signal when the native verification starts.
    await expect(checked).resolves.toEqual({ id: 'work', configDir: join(root, 'selected-account') });
  } finally { store.close(); }
});

it('keeps HTTP config, accounts and UI writes in the server Home', async () => {
  const { root, selected, ambient } = runtimeHomes();
  const store = RunStore.open(join(root, 'runs'));
  const before = readFileSync(ambient.workspaceConfig, 'utf8');
  const app = createApp({ repoRoot: root, home: selected, store, manager: {} as RunManager, version: '0.0.0-test' });
  try {
    const config = await apiRequest(app, '/api/v1/workspace/config');
    expect(config.status).toBe(200);
    expect(await config.json()).toMatchObject({ resources: { maxParallel: 7 } });
    const profiles = await apiRequest(app, '/api/v1/workspace/agent-profiles');
    expect(await profiles.json()).toMatchObject({ profiles: expect.arrayContaining([expect.objectContaining({ id: 'work', configDir: join(root, 'selected-account') })]) });
    const ui = await apiRequest(app, '/api/v1/workspace/ui-state', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appearance: { accent: 'violet' } }) });
    expect(ui.status).toBe(200);
    expect(JSON.parse(readFileSync(selected.workspaceUiState, 'utf8'))).toMatchObject({ appearance: { accent: 'violet' } });
    expect(readFileSync(ambient.workspaceConfig, 'utf8')).toBe(before);
  } finally { store.close(); }
});
