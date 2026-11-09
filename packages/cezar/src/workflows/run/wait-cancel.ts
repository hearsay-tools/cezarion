import type { Wait } from '@open-mercato/cezar-contract/waits';
import type { RunStore } from '../../runs/store.ts';

interface CancelWaitsOptions {
  onCommitFailure?: 'throw' | 'skip';
  superseded?: true;
}

/** Keep watches armed until cancellation is durable. A skipped write disarms nothing. */
export function cancelWaits(
  store: RunStore, disarmWait: (id: string) => void,
  runId: string, ids: readonly string[], opts: CancelWaitsOptions = {},
): Wait[] {
  let settled: Wait[];
  try {
    ({ settled } = store.commitOutcome(runId, { kind: 'cancelled', waitIds: ids, ...(opts.superseded ? { superseded: true } : {}) }));
  } catch (error) {
    if (opts.onCommitFailure !== 'skip') throw error;
    console.warn(`[cez] wait cancellation failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  for (const id of ids) disarmWait(id);
  return settled;
}
