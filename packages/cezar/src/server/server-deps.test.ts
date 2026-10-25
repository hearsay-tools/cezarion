import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationStore } from '../automations/store.ts';
import { AGENT_MODELS_LOCKED_ENV } from '../core/agent-model-policy.ts';
import { PROVIDER_IDS, ProviderAuthService, type ProviderId, type ProviderStatusResponse } from '../core/provider-auth.ts';
import { RunnerModelCatalog } from '../core/runner-model-catalog.ts';
import { RunStore } from '../runs/store.ts';
import type { TaskWebhooks } from '../runs/webhook.ts';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import type { RunManager } from '../workflows/run.ts';
import { openFileInDefaultApp, openInApp } from './open-in-app.ts';
import { openInTerminal } from './open-in-terminal.ts';
import { ProjectContexts, type ProjectContext } from './project-context.ts';
import type { ProviderRuntimeAuthObserver } from './provider-auth-runtime.ts';
import {
  attachProjectWebhooks,
  createBootContext,
  createProviderStatus,
  resolveServerDeps,
  watchProviderRuntimeAuth,
} from './server-deps.ts';
import { createApp, type WorkspaceEventBus } from './server.ts';

const response = (statuses: Partial<Record<ProviderId, 'connected' | 'disconnected'>>): ProviderStatusResponse => ({
  providers: PROVIDER_IDS.map((provider) => ({ provider, status: statuses[provider] ?? 'connected' })),
});

describe('resolveServerDeps', () => {
  it('returns each injected service as it came, and builds none of the defaults', () => {
    const injected = {
      modelCatalog: {} as RunnerModelCatalog,
      providerAuth: {} as ProviderAuthService,
      workspaceConfig: { load: vi.fn(), mergeWrite: vi.fn() },
      openTerminal: vi.fn(),
      openFile: vi.fn(),
      openApp: vi.fn(),
    };
    // `/does/not/exist` proves the default catalog's adapters are never built for it.
    const resolved = resolveServerDeps(injected, '/does/not/exist');
    for (const key of Object.keys(injected) as (keyof typeof injected)[]) expect(resolved[key]).toBe(injected[key]);
  });

  it('falls back to the real default for every service that is absent', () => {
    const resolved = resolveServerDeps({}, process.cwd());
    expect(resolved.modelCatalog).toBeInstanceOf(RunnerModelCatalog);
    expect(resolved.providerAuth).toBeInstanceOf(ProviderAuthService);
    expect(resolved.workspaceConfig).toEqual({ load: loadWorkspaceConfig, mergeWrite: mergeWriteWorkspaceConfig });
    expect(resolved.openTerminal).toBe(openInTerminal);
    expect(resolved.openFile).toBe(openFileInDefaultApp);
    expect(resolved.openApp).toBe(openInApp);
  });

  it('mixes injected and default services one by one', () => {
    const openApp = vi.fn();
    const resolved = resolveServerDeps({ openApp }, process.cwd());
    expect(resolved.openApp).toBe(openApp);
    expect(resolved.openFile).toBe(openFileInDefaultApp);
  });
});

describe('createProviderStatus', () => {
  afterEach(() => vi.unstubAllEnvs());

  const build = (statuses: Parameters<typeof response>[0], disabled: ProviderId[] = []) => {
    const status = vi.fn(async (_options?: { refresh?: boolean }) => response(statuses));
    const load = vi.fn(async () => ({ disabledProviders: disabled }));
    const invalidate = vi.fn();
    const services = createProviderStatus({
      modelCatalog: { invalidate } as unknown as RunnerModelCatalog,
      providerAuth: { status } as unknown as ProviderAuthService,
      workspaceConfig: { load, mergeWrite: vi.fn() } as never,
    });
    return { ...services, status, load, invalidate };
  };

  it('marks the providers the workspace disabled', async () => {
    const { providerStatus, load } = build({}, ['codex']);
    const result = await providerStatus();
    expect(load).toHaveBeenCalledOnce();
    expect(result.providers.map((row) => [row.provider, row.enabled])).toEqual(
      PROVIDER_IDS.map((provider) => [provider, provider !== 'codex']),
    );
  });

  it('forwards an explicit refresh to the auth probe, and only then', async () => {
    const { providerStatus, status } = build({});
    await providerStatus();
    await providerStatus({ refresh: true });
    expect(status.mock.calls).toEqual([[undefined], [{ refresh: true }]]);
  });

  it('ignores the workspace preferences while provider checks are locked off', async () => {
    vi.stubEnv(AGENT_MODELS_LOCKED_ENV, '1');
    const { providerStatus, load, status } = build({}, ['codex']);
    const result = await providerStatus({ refresh: true });
    expect(load).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith({ refresh: true });
    expect(result.providers.every((row) => row.enabled === true)).toBe(true);
  });

  it('refuses nothing when every required provider is connected', async () => {
    const { providerActionError, status } = build({});
    await expect(providerActionError(['claude', 'codex'])).resolves.toBeNull();
    expect(status).toHaveBeenCalledOnce();
  });

  it('answers a disabled provider from settings, without a second probe', async () => {
    const { providerActionError, status } = build({}, ['codex']);
    await expect(providerActionError(['codex'])).resolves.toMatch(/is disabled/);
    expect(status).toHaveBeenCalledOnce();
  });

  it('re-probes an unavailable provider once and trusts the fresh answer', async () => {
    const { providerActionError, status } = build({ claude: 'disconnected' });
    await expect(providerActionError(['claude'])).resolves.toMatch(/credentials are unavailable/);
    expect(status.mock.calls).toEqual([[undefined], [{ refresh: true }]]);
    status.mockImplementation(async (options) => response(options?.refresh ? {} : { claude: 'disconnected' }));
    await expect(providerActionError(['claude'])).resolves.toBeNull();
  });

  it('invalidates the host catalog of a runner that discovers models', () => {
    const { invalidateHostModels, invalidate } = build({});
    invalidateHostModels('claude');
    expect(invalidate).toHaveBeenCalledWith('claude');
  });
});

describe('createBootContext', () => {
  let root: string;
  let dataDir: string;
  const store = {} as RunStore;
  const manager = {} as RunManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-server-deps-'));
    dataDir = join(root, '.ai/cezar');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('seeds the context from the caller deps and the launch key on disk', () => {
    const automationStore = {} as AutomationStore;
    const context = createBootContext({ bootProjectId: 'boot', store, manager, automationStore }, root, dataDir);
    expect(context).toMatchObject({ id: 'boot', root, dataDir });
    expect(context.store).toBe(store);
    expect(context.manager).toBe(manager);
    expect(context.automationStore).toBe(automationStore);
    expect(context.launchKey).toBe(readFileSync(join(dataDir, 'launch-key'), 'utf8').trim());
  });

  it('names the boot project `default` and opens its own automation store when none is injected', () => {
    const context = createBootContext({ store, manager }, root, dataDir);
    expect(context.id).toBe('default');
    expect(context.automationStore).toBeInstanceOf(AutomationStore);
    expect(context.automationStore.dataDir).toBe(dataDir);
  });

  it('does not open the default automation store when one is injected', () => {
    const open = vi.spyOn(AutomationStore, 'open');
    createBootContext({ store, manager, automationStore: {} as AutomationStore }, root, dataDir);
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });
});

describe('context listeners', () => {
  const contextOf = (id: string): ProjectContext => {
    return { id, store: { id } } as unknown as ProjectContext;
  };

  const fakeContexts = (built: ProjectContext[]) => {
    const storeListeners: ((store: unknown) => void)[] = [];
    const builtListeners: ((ctx: ProjectContext) => void)[] = [];
    const contexts = {
      ids: () => built.map((ctx) => ctx.id),
      peek: (id: string) => built.find((ctx) => ctx.id === id),
      onStoreCreated: (listener: (store: unknown) => void) => void storeListeners.push(listener),
      onContextBuilt: (listener: (ctx: ProjectContext) => void) => void builtListeners.push(listener),
    };
    return { contexts: contexts as unknown as ProjectContexts, storeListeners, builtListeners };
  };

  it('watches the boot store first, then every built context, then each later store and context', () => {
    const watched: unknown[] = [];
    const observer = { watch: (store: unknown) => void watched.push(store) } as unknown as ProviderRuntimeAuthObserver;
    const first = contextOf('first');
    const { contexts, storeListeners, builtListeners } = fakeContexts([first]);
    const boot = contextOf('boot');
    watchProviderRuntimeAuth(observer, boot, contexts);
    expect(watched).toEqual([boot.store, first.store]);
    const lateStore = { id: 'late-store' };
    const late = contextOf('late');
    storeListeners.forEach((listener) => listener(lateStore));
    builtListeners.forEach((listener) => listener(late));
    expect(watched).toEqual([boot.store, first.store, lateStore, late.store]);
  });

  it('attaches the webhooks to every built context, then to each context built later', () => {
    const attached: ProjectContext[] = [];
    const webhooks = { attach: (ctx: ProjectContext) => void attached.push(ctx) } as unknown as TaskWebhooks;
    const first = contextOf('first');
    const { contexts, builtListeners } = fakeContexts([first]);
    attachProjectWebhooks(webhooks, contexts);
    expect(attached).toEqual([first]);
    const late = contextOf('late');
    builtListeners.forEach((listener) => listener(late));
    expect(attached).toEqual([first, late]);
  });

  describe('as createApp registers them', () => {
    let root: string;
    let store: RunStore;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'cez-server-deps-app-'));
      store = RunStore.open(join(root, '.ai/cezar'));
    });
    afterEach(() => {
      store.flush();
      rmSync(root, { recursive: true, force: true });
    });

    it('runs the provider watch, then the webhook attach, then the project-ready event for a built context', () => {
      const events: string[] = [];
      const contexts = new ProjectContexts({ listProjects: async () => [] });
      const listeners: ((ctx: ProjectContext) => void)[] = [];
      const register = contexts.onContextBuilt.bind(contexts);
      vi.spyOn(contexts, 'onContextBuilt').mockImplementation((listener) => {
        listeners.push(listener);
        return register(listener);
      });
      createApp({
        repoRoot: root,
        store,
        manager: {} as RunManager,
        version: 'test',
        contexts,
        providerAuth: { status: async () => response({}) } as unknown as ProviderAuthService,
        providerRuntimeAuth: {
          watch: (watched: unknown) => void events.push(watched === store ? 'watch boot' : 'watch built'),
        } as unknown as ProviderRuntimeAuthObserver,
        taskWebhooks: { attach: (ctx: ProjectContext) => void events.push(`attach ${ctx.id}`) } as unknown as TaskWebhooks,
        workspaceEvents: {
          emit: (name: string) => void events.push(name),
        } as unknown as WorkspaceEventBus,
      });
      // `createApp` attaches the webhooks to the boot context before it watches the boot store.
      expect(events).toEqual(['attach default', 'watch boot']);
      // The first three `onContextBuilt` registrations are the ones under test; later ones belong to routes.
      for (const listener of listeners.slice(0, 3)) listener(contextOf('built'));
      expect(events).toEqual(['attach default', 'watch boot', 'watch built', 'attach built', 'project-ready']);
    });
  });
});
