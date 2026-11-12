import type { Home } from '../home/home.ts';
import { hostModelCatalogAdapters } from '../core/host-model-catalog.ts';
import { providerAuthChecksDisabled, type ProviderAuthService } from '../core/provider-auth.ts';
import { applyProviderEnablement } from '../core/provider-availability.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { RunnerModelCatalog } from '../core/runner-model-catalog.ts';
import type { HostDiscovery } from './choices.ts';

export { discoveredRunners, missingModelChoices, type HostDiscovery } from './choices.ts';

/** Initialize before recovery or headless execution; the cockpit reuses this same model cache. */
export function createHostDiscovery(root: string, auth: ProviderAuthService, home: Home): HostDiscovery & { models: RunnerModelCatalog } {
  return {
    models: new RunnerModelCatalog({ adapters: hostModelCatalogAdapters(root) }),
    providers: async () => applyProviderEnablement(await auth.status(), providerAuthChecksDisabled() ? [] : (await loadWorkspaceConfig(home.workspaceConfig)).disabledProviders),
  };
}
