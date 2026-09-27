import { hostModelCatalogAdapters } from '../core/host-model-catalog.ts';
import { providerAuthChecksDisabled, type ProviderAuthService } from '../core/provider-auth.ts';
import { applyProviderEnablement } from '../core/provider-availability.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { MODEL_DISCOVERY_RUNNERS, type ModelDiscoveryRunner, type ModelChoices, type DiscoveredRunners, type ProviderStatusResponse } from '@open-mercato/cezar-contract';
import { RunnerModelCatalog } from '../core/runner-model-catalog.ts';

export interface HostDiscovery {
  models: Pick<RunnerModelCatalog, 'get'>;
  providers(): Promise<ProviderStatusResponse>;
}

/** Initialize before recovery or headless execution; the cockpit reuses this same model cache. */
export function createHostDiscovery(root: string, auth: ProviderAuthService): HostDiscovery & { models: RunnerModelCatalog } {
  return {
    models: new RunnerModelCatalog({ adapters: hostModelCatalogAdapters(root) }),
    providers: async () => applyProviderEnablement(await auth.status(), providerAuthChecksDisabled() ? [] : (await loadWorkspaceConfig()).disabledProviders),
  };
}

export function discoveredRunners(status: ProviderStatusResponse): DiscoveredRunners {
  return { scope: 'host-default-account', runners: status.providers.map(({ provider, profileId: _profileId, ...row }) => ({ runner: provider, ...row })) };
}

/** A fresh nonempty host catalog can disprove an explicit selection; unavailable data cannot. */
export async function missingModelChoices(source: HostDiscovery, runner: ModelDiscoveryRunner, model: string, effectiveModel?: string, modelIdentity?: string): Promise<ModelChoices | undefined> {
  // Reuse account-aware normalization from execution selection, including custom providers.
  // Compare complete IDs only: never strip another runner's provider prefix speculatively.
  const ids = new Set([model, effectiveModel, modelIdentity].filter((id): id is string => id !== undefined));
  const catalog = await source.models.get(runner);
  if (catalog.source === 'unavailable' || catalog.stale || !catalog.models.length || catalog.models.some(row => ids.has(row.id))) return;
  const alternatives = await Promise.all(MODEL_DISCOVERY_RUNNERS.filter(id => id !== runner).map(async id => {
    const other = await source.models.get(id);
    return other.source !== 'unavailable' && !other.stale && other.models.some(row => ids.has(row.id)) ? id : undefined;
  }));
  return { runner, requestedModel: model, availableModels: catalog.models, otherRunners: alternatives.filter((id): id is ModelDiscoveryRunner => id !== undefined) };
}
