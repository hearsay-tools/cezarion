import { createHash } from 'node:crypto';
import type { CezarWaitRequest, Wait, WaitRegistrationReceipt } from '@open-mercato/cezar-contract/waits';
import type { RunRecord, RunStore } from '../../runs/store.ts';
import { normalizePrUrl } from '../waits.ts';

export type RegistrationIdentity = Pick<WaitRegistrationReceipt, 'operationId' | 'requestHash'>;
export function registrationIdentity(request: CezarWaitRequest): RegistrationIdentity | undefined {
  if (!request.operation_id) return undefined;
  const { operation_id, ...fields } = request;
  const canonical = { ...fields };
  if (canonical.kind === 'pr') canonical.pr = normalizePrUrl(canonical.pr);
  for (const field of ['worker_ids', 'request_ids', 'peer_ids'] as const) {
    if (field in canonical) (canonical as Record<string, unknown>)[field] = [...(canonical as unknown as Record<string, string[]>)[field]!].sort();
  }
  if ((canonical.kind === 'worker' || canonical.kind === 'request') && canonical.mode === undefined) canonical.mode = 'any';
  const sorted = Object.fromEntries(Object.entries(canonical).sort(([a], [b]) => a.localeCompare(b)));
  return { operationId: operation_id, requestHash: createHash('sha256').update(JSON.stringify(sorted)).digest('hex') };
}
export function replayRegistration(run: RunRecord | undefined, identity: RegistrationIdentity | undefined): Wait | undefined {
  const receipt = identity && run?.waitRegistrations?.find(row => row.operationId === identity.operationId);
  if (!receipt) return undefined;
  if (receipt.requestHash !== identity!.requestHash) throw Object.assign(new Error('This operation_id belongs to different wait arguments. Retry the original arguments or use a new operation_id.'), { code: 'operation_conflict' });
  return [...run?.waits ?? [], ...run?.lastWaits ?? []].find(wait => wait.id === receipt.wait.id) ?? receipt.wait;
}
export function registrationReceipt(identity: RegistrationIdentity | undefined, wait: Wait, deduplicated = false): WaitRegistrationReceipt | undefined {
  return identity ? { ...identity, wait, deduplicated } : undefined;
}
export function repeatRegistration(store: RunStore, runId: string, wait: Wait, requestedTimeout: number | undefined, identity?: RegistrationIdentity): Wait {
  const keptTimeout = wait.kind === 'timer' ? wait.seconds : 'timeoutSeconds' in wait ? wait.timeoutSeconds : undefined;
  if (requestedTimeout !== undefined && keptTimeout !== requestedTimeout) {
    throw Object.assign(new Error('The requested deadline change was refused; the existing wait remains active. Do not cancel it to remove a duplicate.'), { code: 'duplicate_deadline', retainedWait: wait });
  }
  const receipt = registrationReceipt(identity, wait, true);
  if (receipt) store.commitWaitRegistration(runId, receipt);
  return wait;
}
