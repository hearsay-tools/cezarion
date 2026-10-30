import { expectTypeOf, it } from 'vitest';
import type { AgentAccountSelection } from './agent-profiles.ts';
import type { RunnerModels, WorkspaceConfigResponse, WorkspaceUiState } from './workspace.ts';

type OptionalRunnerStrings = {
  claude?: string | undefined;
  codex?: string | undefined;
  opencode?: string | undefined;
  pi?: string | undefined;
  cursor?: string | undefined;
  omp?: string | undefined;
};

it('keeps the four existing inferred per-runner types', () => {
  expectTypeOf<AgentAccountSelection>().toEqualTypeOf<OptionalRunnerStrings>();
  expectTypeOf<RunnerModels>().toEqualTypeOf<OptionalRunnerStrings>();
  expectTypeOf<WorkspaceConfigResponse['agentDefaults']['models']>()
    .toEqualTypeOf<OptionalRunnerStrings | undefined>();
  expectTypeOf<WorkspaceUiState['dismissedProviderAuthFailures']>()
    .toEqualTypeOf<OptionalRunnerStrings | undefined>();
});
