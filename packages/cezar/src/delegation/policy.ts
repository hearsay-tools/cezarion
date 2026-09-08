import { delegationStateSchema } from '@open-mercato/cezar-contract';
import type { DelegationErrorResponse, WorkerOperation, WorkerCollectedResult } from '@open-mercato/cezar-contract';
import type { RunRecord } from '../runs/store.ts';
import { isAuthenticatedCaller, type Caller } from './credentials.ts';

export type { WorkerOperation } from '@open-mercato/cezar-contract';

export class DelegationPolicyError extends Error {
  constructor(readonly code: DelegationErrorResponse['code'], message: string) {
    super(message);
    this.name = 'DelegationPolicyError';
  }
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
    throw new DelegationPolicyError('incompatible_state', 'Worker no longer accepts steering');
  }
  // Reads, wait and idempotent stop/destroy remain scoped but are allowed through destruction.
  // This grants no permission to relaunch or delete resources without the manager/Git barriers.
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

/** Authorizes a NEW creation. The service resolves existing idempotency receipts before this cap. */
export function authorizeSpawn(caller: Caller, parent: RunRecord | undefined, projectId: string): void {
  authorizeSpawnReplay(caller, parent, projectId);
  if (parent?.delegation?.role !== 'root') denyScope();
  if (parent.delegation.receipts.length >= 32) {
    throw new DelegationPolicyError('capacity_limit', 'Parent worker creation limit reached');
  }
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
