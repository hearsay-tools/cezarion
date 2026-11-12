import { productName } from '../home/display.ts';
import { delegationStateSchema } from '@open-mercato/cezar-contract/delegation';
import type { DelegationErrorResponse, WorkerOperation, WorkerCollectedResult, ModelChoices } from '@open-mercato/cezar-contract';
import { messagingAllowed, workersAllowed } from '@open-mercato/cezar-contract/task-options';
import type { RunRecord } from '../runs/store.ts';
import { isAuthenticatedCaller, type Caller } from './credentials.ts';
import { capacityError, workerCapacity } from './capacity.ts';

export type { WorkerOperation } from '@open-mercato/cezar-contract';

export class DelegationPolicyError extends Error {
  constructor(readonly code: DelegationErrorResponse['code'], message: string, readonly modelChoices?: ModelChoices) {
    super(message);
    this.name = 'DelegationPolicyError';
  }
}

/** Task access (hearsay-tools/cezarion#2784): the human's per-task switches, read at every call. */
export const WORKERS_OFF = `${productName('Cezar')} workers are off for this task. A human can turn them on in the task menu.`;
export const MESSAGING_OFF = 'Task messaging is off for this task. A human can turn it on in the task menu.';
export function requireWorkersAllowed(parent: RunRecord): void {
  if (!workersAllowed(parent)) throw new DelegationPolicyError('incompatible_state', WORKERS_OFF);
}
export function requireMessagingAllowed(run: RunRecord): void {
  if (!messagingAllowed(run)) throw new DelegationPolicyError('incompatible_state', MESSAGING_OFF);
}

function denyScope(): never {
  // Deliberately identical for absent, malformed, wrong-project and unrelated records.
  throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
}

function requireRootAuthority(caller: Caller, parent: RunRecord | undefined, projectId: string, operation: WorkerOperation): void {
  if (!isAuthenticatedCaller(caller) || caller.projectId !== projectId || !parent || caller.runId !== parent.id) denyScope();
  const parsed = delegationStateSchema.safeParse(parent.delegation);
  if (!parsed.success || parsed.data.role !== 'root' || !parsed.data.permissions.includes(operation)) denyScope();
}

function requireActiveParent(parent: RunRecord): void {
  if (parent.delegation?.role === 'root' && parent.delegation.historyDeletion) {
    throw new DelegationPolicyError('incompatible_state', 'Parent history deletion is pending; retry deletion');
  }
  if (parent.status !== 'running' && parent.status !== 'waiting') {
    throw new DelegationPolicyError('incompatible_state', 'Parent session is not active');
  }
}

/** projectId is the service's trusted store context; RunRecord itself has no project field. */
export function authorizeWorker(caller: Caller, target: RunRecord | undefined, operation: WorkerOperation, parent: RunRecord | undefined, projectId: string): void {
  requireRootAuthority(caller, parent, projectId, operation);
  if (operation === 'spawn' || !target || !parent || target.id === parent.id) denyScope();
  const parsed = delegationStateSchema.safeParse(target.delegation);
  if (!parsed.success || parsed.data.role !== 'worker' ||
      parsed.data.parentRunId !== parent.id || parsed.data.workspace.ownerRunId !== target.id) denyScope();
  requireActiveParent(parent);
  if (parent.delegation?.role === 'root' && parent.delegation.finishRequestedAt && (operation === 'steer' || operation === 'wait')) {
    throw new DelegationPolicyError('incompatible_state', 'Parent finish is pending');
  }
  if (operation === 'steer' && (parsed.data.destroy || !['queued', 'running', 'waiting'].includes(target.status))) {
    const instruction = !parsed.data.destroy && !target.stopping && ['review', 'done', 'failed'].includes(target.status)
      ? ` To resume it with a new instruction, run worker resume ${target.id} "<instruction>" --id <new-message-UUID>; use a new message ID.`
      : '';
    throw new DelegationPolicyError('incompatible_state', `Worker no longer accepts steering.${instruction}`);
  }
  // Reads, wait and idempotent stop/destroy remain scoped but are allowed through destruction.
  // This grants no permission to relaunch or delete resources without the manager/Git barriers.
}

/** Listing is an inspection of the authenticated parent's durable receipts. */
export function authorizeWorkerList(caller: Caller, parent: RunRecord | undefined, projectId: string): void {
  requireRootAuthority(caller, parent, projectId, 'inspect');
  requireActiveParent(parent!);
}

/** Check before receipt lookup: replay skips the creation cap, never authority or lifecycle. */
export function authorizeSpawnReplay(caller: Caller, parent: RunRecord | undefined, projectId: string): void {
  requireRootAuthority(caller, parent, projectId, 'spawn');
  if (!parent) denyScope();
  requireActiveParent(parent);
  if (parent.delegation?.role === 'root' && parent.delegation.finishRequestedAt) {
    throw new DelegationPolicyError('incompatible_state', 'Parent finish is pending');
  }
}

/** Authorizes a NEW creation against reclaimable capacity and the creation ceiling (#816).
 * The service resolves existing idempotency receipts before these limits. */
export function authorizeSpawn(caller: Caller, parent: RunRecord | undefined, projectId: string, getRun: (id: string) => RunRecord | undefined): void {
  authorizeSpawnReplay(caller, parent, projectId);
  if (parent?.delegation?.role !== 'root') denyScope();
  // Read again at the serial queue head and just before acceptance: a switch turned off while a
  // spawn waited refuses it. A replayed request ID skips this, as accepted work finishes.
  requireWorkersAllowed(parent);
  const refusal = capacityError(workerCapacity(parent, getRun));
  if (refusal) throw new DelegationPolicyError('capacity_limit', refusal);
}

/** Cancellation and settled receipt reads share ownership and the wait grant, not registration's active-session requirement. */
export function authorizeCancelWait(caller: Caller, parent: RunRecord | undefined, projectId: string): void {
  requireRootAuthority(caller, parent, projectId, 'wait');
  if (parent?.delegation?.role === 'root' && parent.delegation.historyDeletion) {
    throw new DelegationPolicyError('incompatible_state', 'Parent history deletion is pending; retry deletion');
  }
}

/** Retained results require both durable ownership and an actual parent-owned payload. */
export function authorizeRetainedResult(caller: Caller, parent: RunRecord | undefined, projectId: string, workerId: string, result: WorkerCollectedResult | undefined): void {
  requireRootAuthority(caller, parent, projectId, 'inspect');
  if (!parent || parent.delegation?.role !== 'root' || !parent.delegation.receipts.some(receipt => receipt.workerId === workerId) ||
    !result || result.parentRunId !== parent.id || result.workerId !== workerId) denyScope();
  requireActiveParent(parent);
}
