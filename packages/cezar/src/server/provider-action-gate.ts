import type {
  ProviderId,
  ProviderStatusResponse,
} from '../core/provider-auth.ts';
import type { RunRecord } from '../runs/store.ts';
export { providersRequiredByWorkflow } from '@open-mercato/cezar-contract/workflows';

const LABEL: Record<ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'pi',
  cursor: 'Cursor',
  omp: 'OMP',
};

export function providerForExistingRun(
  run: RunRecord,
  override?: ProviderId,
): ProviderId {
  if (override) return override;
  return run.runner ?? 'claude';
}

export function unavailableProviderMessage(
  required: readonly ProviderId[],
  response: ProviderStatusResponse,
): string | null {
  for (const provider of required) {
    const row = response.providers.find(({ provider: id }) => id === provider);
    if (row?.enabled === false) {
      return `${LABEL[provider]} is disabled. Enable it in Settings → Agents → Providers.`;
    }
    if (row?.status !== 'connected') {
      return `${LABEL[provider]} credentials are unavailable. Authorize it in Settings → Agents → Providers.`;
    }
  }
  return null;
}
