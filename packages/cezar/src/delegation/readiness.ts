import type { WorkerCollectedResult } from '@open-mercato/cezar-contract';
import type { RunRecord } from '../runs/store.ts';
import { workerRevision } from './results.ts';

/** Status alone never attests process exit, and collecting live output never
 * acknowledges the eventual result even when the revision number is unchanged. */
export function parentReadiness(parent: RunRecord, observations: ReadonlyArray<{
  workerId: string; run?: RunRecord; terminated: boolean; result?: WorkerCollectedResult;
}>): Array<{ workerId: string; reason: 'outstanding' | 'uncollected' }> {
  if (parent.delegation?.role !== 'root') return [];
  return observations.flatMap<{ workerId: string; reason: 'outstanding' | 'uncollected' }>(({ workerId, run, terminated, result }) => {
    if (!run) return result?.settled && result.cleanup === 'complete' ? [] : [{ workerId, reason: 'outstanding' as const }];
    if (run.delegation?.role !== 'worker' || run.delegation.parentRunId !== parent.id ||
      !['review', 'done', 'failed', 'cancelled'].includes(run.status) || !terminated) {
      return [{ workerId, reason: 'outstanding' as const }];
    }
    return result?.settled && result.parentRunId === parent.id && result.workerId === workerId &&
      result.revision === workerRevision(run) && result.status === run.status
      ? [] : [{ workerId, reason: 'uncollected' as const }];
  });
}
