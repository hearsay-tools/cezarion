import type { ModelDiscoveryRunner } from '@open-mercato/cezar-contract';
import { discoverClaudeModels } from './claude-model-catalog.ts';
import { discoverCodexModels } from './codex-model-catalog.ts';
import { discoverOpencodeModels } from './opencode-model-catalog.ts';
import { discoverCursorModels } from './cursor-model-catalog.ts';
import { discoverPiModels } from './pi-model-catalog.ts';
import { discoverOmpModels } from './omp-model-catalog.ts';
import type { RunnerModelCatalogAdapter } from './runner-model-catalog.ts';

/**
 * Host model-discovery adapters, exhaustive over modelDiscoveryRunnerSchema. Keep the map and
 * RUNNER_IDS guard aligned so a missing adapter fails validation.
 */
export function hostModelCatalogAdapters(cwd: string): Record<ModelDiscoveryRunner, RunnerModelCatalogAdapter> {
  return {
    claude: { discover: () => discoverClaudeModels({ cwd }) },
    codex: { discover: () => discoverCodexModels({ cwd }) },
    opencode: { discover: () => discoverOpencodeModels({ cwd }) },
    cursor: { discover: () => discoverCursorModels({ cwd }) },
    pi: { discover: () => discoverPiModels({ cwd }) },
    omp: { discover: () => discoverOmpModels({ cwd }) },
  };
}
