import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderId } from '../core/provider-auth.ts';
import { clientRequestHash } from '../runs/client-request.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { defaultWorkspaceConfig, type WorkspaceConfig } from '../workspace/config.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { createApp } from './server.ts';

const LOCKED_MESSAGE = 'agent models are locked — configure the model in the native coding-agent settings';
const DISABLED_MESSAGE = 'Codex is disabled. Enable it in Settings → Agents → Providers.';
const CONFLICT_MESSAGE = 'request id payload conflict';
const NO_WEBHOOK_MESSAGE =
  'this project has no task webhook — add a webhook with Task notifications on in Settings → General → Webhooks, or start without notify';
const requestId = '6f1c1b5e-2a7d-4c8e-9f3b-1d2e3f4a5b6c';

const memoryWorkspaceConfig = (disabledProviders: ProviderId[]) => {
  let config: WorkspaceConfig = { ...defaultWorkspaceConfig(), disabledProviders };
  return {
    load: async () => config,
    mergeWrite: async (mutator: (current: WorkspaceConfig) => WorkspaceConfig | void) => {
      config = mutator(config) ?? config;
      return config;
    },
  };
};

/**
 * What `POST /api/v1/runs` answers when it refuses a body, and in which order it checks
 * (hearsay-tools/cezarion#1635). The option resolution moved out of the handler into
 * `start-run-options.ts`; this file pins the observable contract of that move: each
 * refusal's status and exact text, that a refusal starts nothing, and that the FIRST refusal
 * a body meets is still the one it gets. A real manager with no slots keeps every started run
 * `queued`, so nothing spawns. Codex is disabled in the workspace config so the provider gate
 * has something to refuse; the default runner (claude) stays selectable.
 */
describe('POST /api/v1/runs refusals', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let app: Hono;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-startrun-refusals-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
    app = createApp({
      repoRoot,
      store,
      manager,
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
      workspaceConfig: memoryWorkspaceConfig(['codex']),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const post = (body: unknown) =>
    apiRequest(app, '/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const lockModels = () =>
    writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify({ modelsLocked: true }), 'utf8');
  const answer = async (res: Response) => ({ status: res.status, body: await res.json() });

  const task = { task: 'do the thing' };
  const quickTask = { ...task, workflow: 'quick-task' };

  describe('each refusal answers its status and text and starts nothing', () => {
    it('400 for an inline chain the workflow rules refuse', async () => {
      const steps = [{ id: 'work', prompt: '{{task}}' }, { id: 'work', prompt: '{{task}}' }];
      expect(await answer(await post({ ...task, steps }))).toEqual({
        status: 400,
        body: { error: 'duplicate step id "work"' },
      });
      expect(store.listRuns()).toHaveLength(0);
    });

    it('404 for a workflow that does not exist', async () => {
      expect(await answer(await post({ ...task, workflow: 'no-such-workflow' }))).toEqual({
        status: 404,
        body: { error: 'unknown workflow: no-such-workflow' },
      });
      expect(store.listRuns()).toHaveLength(0);
    });

    it.each([
      ['a model', { model: 'some-model' }],
      ['an effort', { effort: 'high' }],
    ])('409 for %s pin while models are locked', async (_name, pin) => {
      lockModels();
      expect(await answer(await post({ ...quickTask, ...pin }))).toEqual({
        status: 409,
        body: { error: LOCKED_MESSAGE },
      });
      expect(store.listRuns()).toHaveLength(0);
    });

    it('starts a locked project run whose pins are blank', async () => {
      lockModels();
      expect((await post({ ...quickTask, model: '  ', effort: '' })).status).toBe(201);
    });

    it('409 for a runner whose provider is disabled', async () => {
      expect(await answer(await post({ ...quickTask, runner: 'codex' }))).toEqual({
        status: 409,
        body: { error: DISABLED_MESSAGE },
      });
      expect(store.listRuns()).toHaveLength(0);
    });

    it('gates the configured default runner when the body names none', async () => {
      writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify({ defaultRunner: 'codex' }), 'utf8');
      expect(await answer(await post(quickTask))).toEqual({ status: 409, body: { error: DISABLED_MESSAGE } });
      expect(store.listRuns()).toHaveLength(0);
    });

    it('400 for an agent account that does not exist', async () => {
      expect(await answer(await post({ ...quickTask, agentProfile: 'ghost' }))).toEqual({
        status: 400,
        body: { error: 'unknown claude account: ghost' },
      });
      expect(store.listRuns()).toHaveLength(0);
    });

    it('names the account of the runner the body picked', async () => {
      const res = await answer(await post({ ...quickTask, runner: 'opencode', agentProfile: 'ghost' }));
      expect(res).toEqual({ status: 400, body: { error: 'unknown opencode account: ghost' } });
    });

    it('starts a run on the default account', async () => {
      expect((await post({ ...quickTask, agentProfile: 'default' })).status).toBe(201);
    });

    it('400 for notify:true on a project with no task webhook', async () => {
      expect(await answer(await post({ ...quickTask, notify: true }))).toEqual({
        status: 400,
        body: { error: NO_WEBHOOK_MESSAGE },
      });
      expect(store.listRuns()).toHaveLength(0);
    });

    it('starts a run with notify:false on a project with no task webhook', async () => {
      expect((await post({ ...quickTask, notify: false })).status).toBe(201);
    });
  });

  describe('the first refusal a body meets is the one it gets', () => {
    const dupSteps = [{ id: 'work', prompt: '{{task}}' }, { id: 'work', prompt: '{{task}}' }];
    const everyRefusal = { model: 'some-model', runner: 'codex', agentProfile: 'ghost', notify: true };

    it.each([
      ['the model lock before a bad chain', true, { ...task, steps: dupSteps, model: 'm' }, 409, LOCKED_MESSAGE],
      ['the model lock before an unknown workflow', true, { ...task, workflow: 'nope', model: 'm' }, 409, LOCKED_MESSAGE],
      ['a bad chain before the provider gate', false, { ...task, steps: dupSteps, runner: 'codex' }, 400, 'duplicate step id "work"'],
      ['an unknown workflow before the provider gate', false, { ...task, workflow: 'nope', runner: 'codex' }, 404, 'unknown workflow: nope'],
      ['the provider gate before the account check', false, { ...quickTask, runner: 'codex', agentProfile: 'ghost' }, 409, DISABLED_MESSAGE],
      ['the account check before the notify check', false, { ...quickTask, agentProfile: 'ghost', notify: true }, 400, 'unknown claude account: ghost'],
      ['the model lock before every later refusal', true, { ...quickTask, ...everyRefusal }, 409, LOCKED_MESSAGE],
      ['the provider gate before the account and notify checks', false, { ...quickTask, ...everyRefusal, model: undefined }, 409, DISABLED_MESSAGE],
    ] as const)('%s', async (_name, locked, body, status, error) => {
      if (locked) lockModels();
      expect(await answer(await post(body))).toEqual({ status, body: { error } });
      expect(store.listRuns()).toHaveLength(0);
    });
  });

  describe('a client request id', () => {
    const idempotent = { ...quickTask, clientRequestId: requestId };

    it('replays the existing run before any start prerequisite is checked', async () => {
      const first = await post({ ...idempotent, model: 'some-model', runner: 'claude' });
      expect(first.status).toBe(201);
      const { id } = (await first.json()) as { id: string };
      lockModels();
      const again = await post({ ...idempotent, model: 'some-model', runner: 'claude' });
      expect(again.status).toBe(200);
      expect(((await again.json()) as { id: string }).id).toBe(id);
      expect(store.listRuns()).toHaveLength(1);
    });

    it('answers a changed payload with a conflict before the model lock', async () => {
      expect((await post(idempotent)).status).toBe(201);
      lockModels();
      expect(await answer(await post({ ...idempotent, model: 'some-model' }))).toEqual({
        status: 409,
        body: { error: CONFLICT_MESSAGE },
      });
      expect(store.listRuns()).toHaveLength(1);
    });

    it('does not start a new run when a refusal meets a new id', async () => {
      expect((await post({ ...idempotent, workflow: 'nope' })).status).toBe(404);
      expect((await post({ ...idempotent, runner: 'codex' })).status).toBe(409);
      expect(store.listRuns()).toHaveLength(0);
    });

    it('hands the manager the id and the payload hash', async () => {
      const startRunIdempotent = vi.spyOn(manager, 'startRunIdempotent');
      const startRun = vi.spyOn(manager, 'startRun');
      expect((await post(idempotent)).status).toBe(201);
      expect(startRunIdempotent).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'quick-task' }),
        expect.objectContaining({ task: 'do the thing' }),
        { id: requestId, hash: clientRequestHash(idempotent) },
      );
      // The idempotent path starts through the manager's own lookup, which passes the request on.
      expect(startRun).toHaveBeenCalledTimes(1);
      expect(startRun.mock.calls[0]![2]).toEqual({ id: requestId, hash: clientRequestHash(idempotent) });
    });
  });

  describe('the input a start hands the manager', () => {
    it('names exactly the start options, absent ones included, and passes no request id', async () => {
      const startRun = vi.spyOn(manager, 'startRun');
      expect((await post(quickTask)).status).toBe(201);
      expect(startRun).toHaveBeenCalledTimes(1);
      const [workflow, input, ...rest] = startRun.mock.calls[0]!;
      expect(workflow.name).toBe('quick-task');
      expect(rest).toEqual([]);
      expect(Object.keys(input).sort()).toEqual([
        'agentProfile', 'archiveWhenDone', 'autoMergePr', 'autonomous', 'effort', 'images',
        'model', 'notify', 'runner', 'systemPrompt', 'task', 'worktree',
      ]);
    });

    it('carries every option the body gave, attachments converted', async () => {
      const startRun = vi.spyOn(manager, 'startRun');
      const res = await post({
        ...quickTask,
        model: 'some-model',
        effort: 'high',
        runner: 'claude',
        agentProfile: 'default',
        systemPrompt: '  be brief  ',
        worktree: false,
        autonomous: true,
        archiveWhenDone: true,
        autoMergePr: false,
        notify: false,
        images: [{ mediaType: 'image/png', data: 'YQ==' }, { mediaType: 'text/plain', data: 'Yg==' }],
      });
      expect(res.status).toBe(201);
      expect(startRun.mock.calls[0]![1]).toStrictEqual({
        task: 'do the thing',
        notify: false,
        model: 'some-model',
        effort: 'high',
        runner: 'claude',
        agentProfile: 'default',
        images: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } },
          { type: 'file', mediaType: 'text/plain', data: 'Yg==' },
        ],
        systemPrompt: 'be brief',
        worktree: false,
        autonomous: true,
        archiveWhenDone: true,
        autoMergePr: false,
      });
    });

    it('runs an inline chain as the planned workflow', async () => {
      const startRun = vi.spyOn(manager, 'startRun');
      const res = await post({ ...task, steps: [{ id: 'work', prompt: '{{task}}' }] });
      expect(res.status).toBe(201);
      expect(startRun.mock.calls[0]![0].steps.map((step) => step.id)).toEqual(['work']);
    });
  });
});
