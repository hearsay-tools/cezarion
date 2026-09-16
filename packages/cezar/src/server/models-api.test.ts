import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MODEL_DISCOVERY_RUNNERS } from '@open-mercato/cezar-contract';
import { ProviderAuthService } from '../core/provider-auth.ts';
import { RunnerModelCatalog } from '../core/runner-model-catalog.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

describe('workspace model catalog API', () => {
  let root: string;
  let store: RunStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-models-api-'));
    store = RunStore.open(join(root, '.ai/cezar'));
  });

  afterEach(() => {
    store.flush();
    rmSync(root, { recursive: true, force: true });
  });

  type Discover = () => Promise<Array<{ id: string; label: string; description: string }>>;

  const app = (discover: Discover, opencodeDiscover: Discover = discover, piDiscover?: Discover) =>
    createApp({
      repoRoot: root,
      store,
      manager: {} as RunManager,
      version: 'test',
      modelCatalog: new RunnerModelCatalog({
        adapters: {
          claude: { discover },
          codex: { discover },
          opencode: { discover: opencodeDiscover },
          ...(piDiscover ? { pi: { discover: piDiscover } } : {}),
        },
      }),
    });

  it.each(['claude', 'codex'])('returns the %s catalog and reuses its cache', async (runner) => {
    let calls = 0;
    const server = app(async () => {
      calls += 1;
      return [{ id: 'gpt-future', label: 'GPT Future', description: 'Newly available' }];
    });
    for (let i = 0; i < 2; i += 1) {
      const response = await apiRequest(server, `/api/v1/models?runner=${runner}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        runner,
        models: [{ id: 'gpt-future' }],
        source: i === 0 ? 'live' : 'cache',
        stale: false,
      });
    }
    expect(calls).toBe(1);
  });

  it('degrades discovery failures to an unavailable 200 response', async () => {
    const response = await apiRequest(app(async () => { throw new Error('secret detail'); }), '/api/v1/models?runner=codex');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runner: 'codex', models: [], source: 'unavailable', stale: false,
      reason: 'Codex model discovery is temporarily unavailable',
    });
  });

  it('answers the OpenCode catalog too — the runner that used to have no discovery path (#794)', async () => {
    const server = app(
      async () => [{ id: 'gpt-future', label: 'GPT Future', description: 'Newly available' }],
      async () => [{ id: 'openai/gpt-5.4', label: 'openai/gpt-5.4', description: 'via openai' }],
    );
    const response = await apiRequest(server, '/api/v1/models?runner=opencode');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runner: 'opencode',
      models: [{ id: 'openai/gpt-5.4', description: 'via openai' }],
      source: 'live',
    });
  });

  it('degrades an OpenCode discovery failure the same way', async () => {
    const server = app(async () => [], async () => { throw new Error('secret detail'); });
    const response = await apiRequest(server, '/api/v1/models?runner=opencode');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runner: 'opencode', models: [], source: 'unavailable', stale: false,
      reason: 'OpenCode model discovery is temporarily unavailable',
    });
  });

  it('answers the Pi catalog too — the runner that used to have hard-coded presets', async () => {
    const server = app(
      async () => [],
      async () => [],
      async () => [{
        id: 'xai/grok-4.6',
        label: 'grok-4.6',
        description: 'via xai',
        effortLevels: ['low', 'medium', 'high', 'xhigh'],
      }],
    );
    const response = await apiRequest(server, '/api/v1/models?runner=pi');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runner: 'pi',
      models: [{
        id: 'xai/grok-4.6',
        description: 'via xai',
        effortLevels: ['low', 'medium', 'high', 'xhigh'],
      }],
      source: 'live',
    });
  });

  it('degrades a Pi discovery failure the same way', async () => {
    const server = app(async () => [], async () => [], async () => { throw new Error('secret detail'); });
    const response = await apiRequest(server, '/api/v1/models?runner=pi');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      runner: 'pi', models: [], source: 'unavailable', stale: false,
      reason: 'Pi model discovery is temporarily unavailable',
    });
  });

  it.each(['/api/v1/models', '/api/v1/models?runner=unknown'])('rejects invalid query %s', async (path) => {
    const response = await apiRequest(app(async () => []), path);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: `runner must be ${new Intl.ListFormat('en', { type: 'disjunction' }).format(MODEL_DISCOVERY_RUNNERS)}`,
    });
  });

  it('includes newly advertised contract runners in the validation message', async () => {
    // Exercise enum growth without adding a production backend; restore even on assertion failure.
    const runners = MODEL_DISCOVERY_RUNNERS as string[];
    runners.push('future-runner');
    try {
      const response = await apiRequest(app(async () => []), '/api/v1/models?runner=unknown');
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: `runner must be ${new Intl.ListFormat('en', { type: 'disjunction' }).format(MODEL_DISCOVERY_RUNNERS)}`,
      });
    } finally {
      runners.pop();
    }
  });

  it('is workspace-level rather than project-scoped', async () => {
    const response = await apiRequest(app(async () => []), '/api/v1/p/default/models?runner=codex');
    expect(response.status).toBe(404);
  });

  it('Connect busts a cached miss without spawning discovery', async () => {
    let calls = 0;
    const catalog = new RunnerModelCatalog({
      adapters: {
        codex: {
          discover: async () => {
            calls += 1;
            if (calls === 1) throw new Error('not logged in');
            return [{ id: 'gpt-future', label: 'GPT Future', description: '' }];
          },
        },
      },
    });
    const server = createApp({
      repoRoot: root,
      store,
      manager: {} as RunManager,
      version: 'test',
      modelCatalog: catalog,
      providerAuth: new ProviderAuthService({
        runCommand: async () => ({ stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 0 }),
      }),
    });

    expect(await (await apiRequest(server, '/api/v1/models?runner=codex')).json()).toMatchObject({
      source: 'unavailable',
      models: [],
    });
    const connect = await apiRequest(server, '/api/v1/providers/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'codex' }),
    });
    expect(connect.status).toBe(200);
    expect(calls).toBe(1);
    expect(await (await apiRequest(server, '/api/v1/models?runner=codex')).json()).toMatchObject({
      source: 'live',
      models: [{ id: 'gpt-future' }],
    });
    expect(calls).toBe(2);
  });

  it('retry busts a cached miss without spawning discovery', async () => {
    let calls = 0;
    const catalog = new RunnerModelCatalog({
      adapters: {
        codex: {
          discover: async () => {
            calls += 1;
            if (calls === 1) throw new Error('not logged in');
            return [{ id: 'gpt-future', label: 'GPT Future', description: '' }];
          },
        },
      },
    });
    const providerAuth = new ProviderAuthService({
      createAuthFailureId: () => 'auth-incident-1',
      runCommand: async () => ({ stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 0 }),
    });
    const incident = providerAuth.reportRuntimeAuthFailure('codex')?.status.authFailureId;
    const server = createApp({
      repoRoot: root,
      store,
      manager: {} as RunManager,
      version: 'test',
      modelCatalog: catalog,
      providerAuth,
    });

    expect(await (await apiRequest(server, '/api/v1/models?runner=codex')).json()).toMatchObject({
      source: 'unavailable',
    });
    const retry = await apiRequest(server, '/api/v1/providers/codex/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ authFailureId: incident }),
    });
    expect(retry.status).toBe(200);
    expect(calls).toBe(1);
    expect(await (await apiRequest(server, '/api/v1/models?runner=codex')).json()).toMatchObject({
      source: 'live',
      models: [{ id: 'gpt-future' }],
    });
    expect(calls).toBe(2);
  });

  it('Check again busts a cached miss without spawning discovery', async () => {
    let calls = 0;
    const catalog = new RunnerModelCatalog({
      adapters: {
        pi: {
          discover: async () => {
            calls += 1;
            if (calls === 1) throw new Error('not logged in');
            return [{ id: 'xai/grok-4.6', label: 'grok-4.6', description: '' }];
          },
        },
      },
    });
    const server = createApp({
      repoRoot: root,
      store,
      manager: {} as RunManager,
      version: 'test',
      modelCatalog: catalog,
      providerAuth: new ProviderAuthService({
        runCommand: async () => ({
          stdout: 'provider  model  context  max-out  thinking  images\nanthropic  claude  200K  64K  yes  yes',
          stderr: '',
          exitCode: 0,
        }),
      }),
    });

    expect(await (await apiRequest(server, '/api/v1/models?runner=pi')).json()).toMatchObject({
      source: 'unavailable',
    });
    const refresh = await apiRequest(server, '/api/v1/providers/status?refresh=1');
    expect(refresh.status).toBe(200);
    expect(calls).toBe(1);
    expect(await (await apiRequest(server, '/api/v1/models?runner=pi')).json()).toMatchObject({
      source: 'live',
      models: [{ id: 'xai/grok-4.6' }],
    });
    expect(calls).toBe(2);
  });

  it.each(['claude', 'pi'] as const)('Check again invalidates %s without losing its last good catalog', async (runner) => {
    let calls = 0;
    const catalog = new RunnerModelCatalog({
      adapters: {
        [runner]: {
          discover: async () => {
            calls += 1;
            if (calls > 1) throw new Error('unavailable');
            return [{ id: 'xai/grok-4.6', label: 'grok-4.6', description: '' }];
          },
        },
      },
    });
    const server = createApp({
      repoRoot: root,
      store,
      manager: {} as RunManager,
      version: 'test',
      modelCatalog: catalog,
      providerAuth: new ProviderAuthService({
        runCommand: async () => ({
          stdout: 'provider  model  context  max-out  thinking  images\nanthropic  claude  200K  64K  yes  yes',
          stderr: '',
          exitCode: 0,
        }),
      }),
    });

    expect(await (await apiRequest(server, `/api/v1/models?runner=${runner}`)).json()).toMatchObject({
      source: 'live',
    });
    const refresh = await apiRequest(server, '/api/v1/providers/status?refresh=1');
    expect(refresh.status).toBe(200);
    expect(calls).toBe(1);
    expect(await (await apiRequest(server, `/api/v1/models?runner=${runner}`)).json()).toMatchObject({
      source: 'cache',
      stale: true,
      models: [{ id: 'xai/grok-4.6' }],
    });
    expect(calls).toBe(2);
  });

  it('account Check again busts that runner without spawning discovery', async () => {
    let calls = 0;
    const catalog = new RunnerModelCatalog({
      adapters: {
        opencode: {
          discover: async () => {
            calls += 1;
            if (calls === 1) throw new Error('not logged in');
            return [{ id: 'openai/gpt-5.4', label: 'openai/gpt-5.4', description: '' }];
          },
        },
      },
    });
    const server = createApp({
      repoRoot: root,
      store,
      manager: {} as RunManager,
      version: 'test',
      modelCatalog: catalog,
      providerAuth: new ProviderAuthService({
        runCommand: async () => ({
          stdout: [
            '┌  Credentials ~/.local/share/opencode/auth.json',
            '●  Anthropic oauth',
            '└  1 credential',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
        }),
      }),
    });

    expect(await (await apiRequest(server, '/api/v1/models?runner=opencode')).json()).toMatchObject({
      source: 'unavailable',
    });
    const recheck = await apiRequest(server, '/api/v1/workspace/agent-profiles/default:opencode/status?refresh=1');
    expect(recheck.status).toBe(200);
    expect(calls).toBe(1);
    expect(await (await apiRequest(server, '/api/v1/models?runner=opencode')).json()).toMatchObject({
      source: 'live',
      models: [{ id: 'openai/gpt-5.4' }],
    });
    expect(calls).toBe(2);
  });

  it('a status read without refresh leaves the catalog cache in place', async () => {
    let calls = 0;
    const catalog = new RunnerModelCatalog({
      adapters: {
        codex: {
          discover: async () => {
            calls += 1;
            throw new Error('not logged in');
          },
        },
      },
    });
    const server = createApp({
      repoRoot: root,
      store,
      manager: {} as RunManager,
      version: 'test',
      modelCatalog: catalog,
      providerAuth: new ProviderAuthService({
        runCommand: async () => ({ stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 0 }),
      }),
    });

    expect(await (await apiRequest(server, '/api/v1/models?runner=codex')).json()).toMatchObject({
      source: 'unavailable',
    });
    expect((await apiRequest(server, '/api/v1/providers/status')).status).toBe(200);
    expect(await (await apiRequest(server, '/api/v1/models?runner=codex')).json()).toMatchObject({
      source: 'unavailable',
    });
    expect(calls).toBe(1);
  });

  it('a failed Connect leaves the catalog cache in place', async () => {
    let calls = 0;
    const catalog = new RunnerModelCatalog({
      adapters: {
        codex: {
          discover: async () => {
            calls += 1;
            throw new Error('not logged in');
          },
        },
      },
    });
    const server = createApp({
      repoRoot: root,
      store,
      manager: {} as RunManager,
      version: 'test',
      modelCatalog: catalog,
      providerAuth: new ProviderAuthService({
        runCommand: async () => ({ stdout: '', stderr: 'secret error', exitCode: null, errorCode: 'ENOENT' }),
      }),
    });

    expect(await (await apiRequest(server, '/api/v1/models?runner=codex')).json()).toMatchObject({
      source: 'unavailable',
    });
    const connect = await apiRequest(server, '/api/v1/providers/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'codex' }),
    });
    expect(connect.status).toBe(409);
    expect(await (await apiRequest(server, '/api/v1/models?runner=codex')).json()).toMatchObject({
      source: 'unavailable',
    });
    expect(calls).toBe(1);
  });
});
