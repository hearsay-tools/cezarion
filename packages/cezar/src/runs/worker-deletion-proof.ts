import type { DelegationState } from '@open-mercato/cezar-contract';
import type { WorkerExecution } from './worker-execution.ts';

type Deletion = Extract<DelegationState, { role: 'root' }>['receipts'][number]['deletion'];

/** Keep process evidence until scratch is safe, including after an interrupted deletion. */
export function workerDeletionProof(deletion: Deletion, revision: number, resourceId: string, access: {
  readProof: () => WorkerExecution | undefined;
  resourcesSafe: (generation: string) => boolean;
  scratchMayExist: () => boolean;
  executionExists: () => boolean;
}): boolean {
  const proof = access.readProof();
  if (proof && !access.resourcesSafe(proof.generation)) return false;
  if (!proof && access.scratchMayExist()) return false;
  if (deletion) return deletion.revision === revision && deletion.resourceId === resourceId && deletion.phase === 'pending' &&
    (proof ? proof.phase === 'complete' && proof.generation === deletion.generation : !access.executionExists());
  return proof?.phase === 'complete';
}
