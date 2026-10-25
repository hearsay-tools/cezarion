/**
 * The dependency setup `createApp` runs before it chains any route (hearsay-tools/cezarion#1634).
 *
 * Each helper is called at the exact point in `createApp` where the code it replaced ran, so the
 * order in which dependencies are created and listeners are registered is unchanged. None of them
 * touches a route: every route family keeps its chain in `server.ts`, which is what keeps it in
 * `AppType`.
 */
import { runnerDiscoversModels } from '@open-mercato/cezar-contract/workspace';
import { AutomationStore } from '../automations/store.ts';
import { hostModelCatalogAdapters } from '../core/host-model-catalog.ts';
import {
  ProviderAuthService,
  providerAuthChecksDisabled,
  type ProviderId,
  type ProviderStatusResponse,
} from '../core/provider-auth.ts';
import { applyProviderEnablement } from '../core/provider-availability.ts';
import { RunnerModelCatalog } from '../core/runner-model-catalog.ts';
import type { TaskWebhooks } from '../runs/webhook.ts';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { ensureLaunchKey } from './launch-key.ts';
import { openFileInDefaultApp, openInApp } from './open-in-app.ts';
import { openInTerminal } from './open-in-terminal.ts';
import type { ProjectContext, ProjectContexts } from './project-context.ts';
import { unavailableProviderMessage } from './provider-action-gate.ts';
import type { ProviderRuntimeAuthObserver } from './provider-auth-runtime.ts';
import type { ServerDeps } from './server.ts';

/** The host-wide services `createApp` always has: the injected one, or the real default. */
type HostServices = Required<
  Pick<ServerDeps, 'modelCatalog' | 'providerAuth' | 'workspaceConfig' | 'openTerminal' | 'openFile' | 'openApp'>
>;

/**
 * Resolve each host-wide service to the injected dependency or its real default. A default is
 * built only when its dependency is absent (`??` short-circuits), in the order below, so a test
 * that injects a service never pays for the real one.
 */
export function resolveServerDeps(deps: Partial<HostServices>, bootRoot: string): HostServices {
  return {
    // One adapter per contract-advertised runner; the map is typed over `modelDiscoveryRunnerSchema`
    // so a runner added to the contract without an adapter fails typecheck (AGENT_PROTOCOL.md §10).
    modelCatalog: deps.modelCatalog ?? new RunnerModelCatalog({ adapters: hostModelCatalogAdapters(bootRoot) }),
    providerAuth: deps.providerAuth ?? new ProviderAuthService(),
    workspaceConfig: deps.workspaceConfig ?? {
      load: loadWorkspaceConfig,
      mergeWrite: mergeWriteWorkspaceConfig,
    },
    openTerminal: deps.openTerminal ?? openInTerminal,
    openFile: deps.openFile ?? openFileInDefaultApp,
    openApp: deps.openApp ?? openInApp,
  };
}

/** The host-wide provider closures the provider, models and start-gate routes share. */
export function createProviderStatus(services: Pick<HostServices, 'modelCatalog' | 'providerAuth' | 'workspaceConfig'>) {
  const { modelCatalog, providerAuth, workspaceConfig } = services;
  const invalidateHostModels = (provider: ProviderId): void => {
    if (runnerDiscoversModels(provider)) modelCatalog.invalidate(provider);
  };
  const providerStatus = async (options?: { refresh?: boolean }): Promise<ProviderStatusResponse> => {
    if (providerAuthChecksDisabled()) {
      return applyProviderEnablement(
        await providerAuth.status(options?.refresh ? { refresh: true } : undefined),
        [],
      );
    }
    const [discovered, workspace] = await Promise.all([
      providerAuth.status(options?.refresh ? { refresh: true } : undefined),
      workspaceConfig.load(),
    ]);
    return applyProviderEnablement(discovered, workspace.disabledProviders);
  };
  /**
   * Verify cached provider unavailability before refusing a start. Settings-disabled providers
   * need no probe. Runtime incidents remain authoritative until an explicit retry or matching
   * native verification clears them.
   */
  const providerActionError = async (
    required: readonly ProviderId[],
  ): Promise<string | null> => {
    const known = await providerStatus();
    const message = unavailableProviderMessage(required, known);
    if (message === null) return null;
    // A DISABLED provider is a settings fact, not a probe result — re-probing it learns nothing and
    // would spawn a CLI to re-read something the user typed.
    const disabled = required.some((provider) =>
      known.providers.find((row) => row.provider === provider)?.enabled === false);
    if (disabled) return message;
    return unavailableProviderMessage(required, await providerStatus({ refresh: true }));
  };
  return { providerStatus, providerActionError, invalidateHostModels };
}

/**
 * The boot project's context is SEEDED from the deps the caller already built (src/index.ts
 * `serveCommand` did the recover/prune/launch-key work at startup — observable boot behavior
 * unchanged); it never enters the lazy map, so its `.ai/cezar` state is never double-opened. `id`
 * starts as the reserved alias when registration was suppressed — handlers never read it; API
 * payloads name the boot project via `resolveBootProject` instead.
 */
export function createBootContext(
  deps: Pick<ServerDeps, 'bootProjectId' | 'store' | 'manager' | 'automationStore'>,
  bootRoot: string,
  bootDataDir: string,
): ProjectContext {
  return {
    id: deps.bootProjectId ?? 'default',
    root: bootRoot,
    dataDir: bootDataDir,
    store: deps.store,
    manager: deps.manager,
    automationStore: deps.automationStore ?? AutomationStore.open(bootDataDir),
    launchKey: ensureLaunchKey(bootDataDir), // bookmarklet auto-start secret (spec 011)
  };
}

/** Watch the boot store, every context already built, and each store or context built later. */
export function watchProviderRuntimeAuth(
  providerRuntimeAuth: Pick<ProviderRuntimeAuthObserver, 'watch'>,
  bootContext: Pick<ProjectContext, 'store'>,
  contexts: Pick<ProjectContexts, 'ids' | 'peek' | 'onStoreCreated' | 'onContextBuilt'>,
): void {
  providerRuntimeAuth.watch(bootContext.store);
  for (const id of contexts.ids()) {
    const ctx = contexts.peek(id);
    if (ctx) providerRuntimeAuth.watch(ctx.store);
  }
  contexts.onStoreCreated((store) => providerRuntimeAuth.watch(store));
  contexts.onContextBuilt((ctx) => providerRuntimeAuth.watch(ctx.store));
}

/** Injected contexts (tests) skip `prepareManager`; attach those now, and each one built later. */
export function attachProjectWebhooks(
  taskWebhooks: Pick<TaskWebhooks, 'attach'>,
  contexts: Pick<ProjectContexts, 'ids' | 'peek' | 'onContextBuilt'>,
): void {
  for (const id of contexts.ids()) {
    const ctx = contexts.peek(id);
    if (ctx) taskWebhooks.attach(ctx);
  }
  contexts.onContextBuilt((ctx) => taskWebhooks.attach(ctx));
}
