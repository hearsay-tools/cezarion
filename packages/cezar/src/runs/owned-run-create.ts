/**
 * Create an owned worker run and its parent receipt. `RunStore.createOwnedRun` is a thin call
 * into `createStoreOwnedRun`; parent, capacity, ownership and resource checks stay here.
 */
import { randomUUID } from 'node:crypto';
import type { DelegationState, RunRecord } from '@open-mercato/cezar-contract';
import { delegationStateSchema, workerCreationReceiptSchema } from '@open-mercato/cezar-contract/delegation';
import { workerExecutionIdentitySchema, type WorkerExecutionIdentity } from '../delegation/execution-identity.ts';
import { capacityError, workerCapacity } from '../delegation/capacity.ts';
import type { WorkerExecution } from './worker-execution.ts';

type RootDelegation = Extract<DelegationState, { role: 'root' }>;
type WorkerDelegation = Extract<DelegationState, { role: 'worker' }>;
type CreationIdentity = Pick<RootDelegation['receipts'][number], 'requestId' | 'requestHash'>;
type WorkerWorkspace = WorkerDelegation['workspace'];

/** The store lookups owned-run creation needs; no import of `store.ts`. */
export interface OwnedRunCreateLookup {
  peek(id: string): RunRecord | undefined;
  hasRun(id: string): boolean;
  held: ReadonlyMap<string, RunRecord>;
  deleted: ReadonlySet<string>;
  db: { findResourceHolders(resource: { branch: string; worktreePath: string }): string[] } | null;
}

/** The store methods owned-run creation needs, including the typed `buildRun` input. */
export interface OwnedRunCreateState<TInput extends { worktree?: false | undefined }> extends OwnedRunCreateLookup {
  buildRun(input: TInput, id: string): RunRecord;
  writeWorkerIdentity(id: string, identity: WorkerExecutionIdentity): void;
  writeWorkerExecution(id: string, proof: WorkerExecution, fresh?: boolean): void;
  commitIndex(input: ReadonlyMap<string, RunRecord | null>): void;
}

/**
 * requestHash is supplied only by the trusted service: hash the ORIGINAL normalized request,
 * before resolving refs. A retry keeps the original worker and pinned SHA even if HEAD moved.
 * workspace.ownerRunId is the trusted service's preallocated worker UUID.
 */
export function createStoreOwnedRun<TInput extends { worktree?: false | undefined }>(
  state: OwnedRunCreateState<TInput>,
  input: TInput,
  parentId: string,
  requestId: string,
  worker: DelegationState,
  requestHash: string,
  executionIdentity: WorkerExecutionIdentity,
): RunRecord {
  const { parent, authority } = resolveOwnedRunParent(state, parentId);
  // Validate retry identity independently of the newly proposed resource.
  const identity = workerCreationReceiptSchema.pick({ requestId: true, requestHash: true })
    .parse({ requestId, requestHash });
  const receipt = authority.receipts.find((entry) => entry.requestId === identity.requestId);
  if (receipt) return existingOwnedRunReceipt(state, parentId, receipt, identity);
  // #816: the same check the spawn policy makes, inside the receipt transaction, so no path
  // writes a receipt past either limit.
  const refusal = capacityError(workerCapacity(parent, (id) => state.peek(id)));
  if (refusal) throw new Error(refusal);
  const metadata = parseOwnedWorkerMetadata(worker, parentId, input.worktree);
  assertWorkerResourceFree(state, metadata.workspace);
  return publishOwnedRun(state, parentId, parent, authority, identity, metadata, input, executionIdentity);
}

function resolveOwnedRunParent(
  state: OwnedRunCreateLookup,
  parentId: string,
): { parent: RunRecord; authority: RootDelegation } {
  const parent = state.peek(parentId);
  const authority = delegationStateSchema.safeParse(parent?.delegation);
  if (!parent || !authority.success || authority.data.role !== 'root' || authority.data.historyDeletion) {
    throw new Error('invalid delegation parent');
  }
  return { parent, authority: authority.data };
}

function existingOwnedRunReceipt(
  state: OwnedRunCreateLookup,
  parentId: string,
  receipt: RootDelegation['receipts'][number],
  identity: CreationIdentity,
): RunRecord {
  if (receipt.requestHash !== identity.requestHash) throw new Error('request ID payload conflict');
  const existing = state.peek(receipt.workerId);
  const metadata = delegationStateSchema.safeParse(existing?.delegation);
  if (!existing || !metadata.success || metadata.data.role !== 'worker' ||
    metadata.data.parentRunId !== parentId || metadata.data.workspace.ownerRunId !== existing.id ||
    existing.id === parentId) throw new Error('invalid request receipt ownership');
  return existing;
}

function parseOwnedWorkerMetadata(
  worker: DelegationState,
  parentId: string,
  worktree: false | undefined,
): WorkerDelegation {
  const metadata = delegationStateSchema.parse(worker);
  if (metadata.role !== 'worker' || metadata.parentRunId !== parentId ||
    metadata.workspace.ownerRunId === parentId || worktree === false) {
    throw new Error('invalid worker ownership');
  }
  return metadata;
}

function assertWorkerResourceFree(
  state: OwnedRunCreateLookup,
  workspace: WorkerWorkspace,
): void {
  if (state.hasRun(workspace.ownerRunId)) throw new Error('worker run ID collision');
  assertHeldResourcesFree(state.held, workspace);
  assertStoredResourcesFree(state, workspace);
}

function assertHeldResourcesFree(held: ReadonlyMap<string, RunRecord>, workspace: WorkerWorkspace): void {
  for (const run of held.values()) {
    if (heldResourceCollides(run, workspace)) throw new Error('worker resource ownership collision');
  }
}

function heldResourceCollides(run: RunRecord, workspace: WorkerWorkspace): boolean {
  const owned = run.delegation?.role === 'worker' ? run.delegation.workspace : undefined;
  return Boolean((owned && (owned.resourceId === workspace.resourceId || owned.path === workspace.path ||
    owned.branch === workspace.branch)) || run.worktreePath === workspace.path || run.branch === workspace.branch);
}

function assertStoredResourcesFree(
  state: OwnedRunCreateLookup,
  workspace: WorkerWorkspace,
): void {
  // Runs not in memory answer through the branch and worktree columns. A worker's planned
  // branch is its `branch` column; its path and resource id derive from its own run id, which
  // the id check above already proved unused.
  if ((state.db?.findResourceHolders({ branch: workspace.branch, worktreePath: workspace.path }) ?? [])
    .some((id) => !state.held.has(id) && !state.deleted.has(id))) throw new Error('worker resource ownership collision');
}

function publishOwnedRun<TInput extends { worktree?: false | undefined }>(
  state: OwnedRunCreateState<TInput>,
  parentId: string,
  parent: RunRecord,
  authority: RootDelegation,
  identity: CreationIdentity,
  metadata: WorkerDelegation,
  input: TInput,
  executionIdentity: WorkerExecutionIdentity,
): RunRecord {
  const workspace = metadata.workspace;
  const delegation = delegationStateSchema.parse({
    ...authority,
    receipts: [...authority.receipts, { ...identity, workerId: workspace.ownerRunId }],
  });
  const run = { ...state.buildRun(input, workspace.ownerRunId), delegation: metadata };
  // This transaction precedes materialization. Every launch must rotate this
  // generation to starting before touching the workspace or a session.
  state.writeWorkerIdentity(run.id, workerExecutionIdentitySchema.parse(executionIdentity));
  state.writeWorkerExecution(run.id, { generation: randomUUID(), phase: 'queued' }, true);
  // No pruning here: deleting run history cannot be part of a proposed index transaction.
  state.commitIndex(new Map([[parentId, { ...parent, delegation }], [run.id, run]]));
  return run;
}
