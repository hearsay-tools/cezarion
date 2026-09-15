import type { ModelDiscoveryRunner } from '@open-mercato/cezar-contract';
import { discoverClaudeModels } from './claude-model-catalog.ts';
import { discoverCodexModels } from './codex-model-catalog.ts';
import { discoverOpencodeModels } from './opencode-model-catalog.ts';
import { discoverPiModels } from './pi-model-catalog.ts';
import type { RunnerModelCatalogAdapter } from './runner-model-catalog.ts';

/**
 * The host's model-discovery adapters, one per runner the contract advertises as
 * discoverable (`modelDiscoveryRunnerSchema`, `packages/contract/src/workspace.ts`).
 *
 * The return type is a full `Record` over that enum on purpose: `RunnerModelCatalog` itself
 * takes a `Partial` map, so a runner added to the contract without an adapter here would be
 * silent at runtime — the catalog answers `unavailable` and the picker shows presets again.
 * Typing the map over the enum makes that gap a compile error instead, and
 * `model-discovery-guard.test.ts` pins the other direction (a `RUNNER_IDS` member missing
 * from the enum). AGENT_PROTOCOL.md §10, "Host model discovery".
 */
export function hostModelCatalogAdapters(cwd: string): Record<ModelDiscoveryRunner, RunnerModelCatalogAdapter> {
  return {
    claude: { discover: () => discoverClaudeModels({ cwd }) },
    codex: { discover: () => discoverCodexModels({ cwd }) },
    opencode: { discover: () => discoverOpencodeModels({ cwd }) },
    pi: { discover: () => discoverPiModels({ cwd }) },
  };
}
