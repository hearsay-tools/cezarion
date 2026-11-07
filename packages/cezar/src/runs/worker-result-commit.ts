/**
 * Publish a worker-result snapshot and its parent pointer. `RunStore.commitWorkerResult` is a
 * thin call into `commitStoreWorkerResult`; ownership, obsolescence and disk writes stay here.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, openSync, readdirSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { DelegationState, RunRecord, WorkerCollectedResult } from '@open-mercato/cezar-contract';
import { workerCollectedResultSchema, workerResultFileSchema } from '@open-mercato/cezar-contract/delegation';

type WorkerResultFile = ReturnType<typeof workerResultFileSchema.parse>;
type WorkerResultReference = NonNullable<Extract<DelegationState, { role: 'root' }>['results']>[number];
type RootRun = RunRecord & { delegation: Extract<DelegationState, { role: 'root' }> };

/** The store methods a worker-result commit needs; no import of `store.ts`. */
export interface WorkerResultCommitState {
  redactResult(value: WorkerCollectedResult): WorkerCollectedResult;
  peek(id: string): RunRecord | undefined;
  readWorkerResultFile(parentId: string, workerId: string): WorkerResultFile | undefined;
  readWorkerResult(parentId: string, workerId: string): WorkerCollectedResult | undefined;
  redactText(text: string): string;
  workerResultSnapshotPath(parentId: string, workerId: string, snapshotId: string): string;
  workerResultsDir(parentId: string): string;
  commitDelegation(patches: ReadonlyArray<{ id: string; delegation: DelegationState }>): void;
}

/**
 * Two collected worker results carry the same evidence: equal but for when they were observed and
 * which snapshot file holds them, and, with `ignoreCleanup`, the cleanup phase. A retried destroy
 * that observed nothing new then rewrites and fsyncs nothing (hearsay-tools/cezarion#879).
 */
function sameWorkerResult(a: WorkerCollectedResult, b: WorkerCollectedResult, opts: { ignoreCleanup?: boolean }): boolean {
  const comparable = (value: WorkerCollectedResult) => ({ ...value, observedAt: undefined, ...(opts.ignoreCleanup ? { cleanup: undefined } : {}),
    diff: value.diff.state === 'available' ? { ...value.diff, snapshotId: undefined, path: undefined } : value.diff });
  return isDeepStrictEqual(comparable(a), comparable(b));
}

/**
 * Publish a pointer only after its redacted immutable snapshot reaches disk. Failed index writes retain the old evidence.
 * A result whose evidence is already stored returns the stored one and writes nothing; `ignoreCleanup` is for a
 * caller that only needs the payload durable, whatever cleanup phase the stored copy names.
 */
export function commitStoreWorkerResult(
  state: WorkerResultCommitState,
  parentId: string,
  value: WorkerCollectedResult,
  diffSnapshot?: string,
  opts: { ignoreCleanup?: boolean } = {},
): WorkerCollectedResult {
  const result = workerCollectedResultSchema.parse(state.redactResult(value));
  const parent = state.peek(parentId);
  const worker = state.peek(result.workerId);
  assertWorkerResultOwnership(parentId, parent, worker, result);
  const old = parent.delegation.results?.find((entry) => entry.workerId === result.workerId);
  const stored = old && state.readWorkerResultFile(parentId, result.workerId);
  const matched = matchingStoredWorkerResult(stored, result, diffSnapshot, opts, (text) => state.redactText(text));
  if (matched) return matched;
  if (workerResultIsObsolete(worker, old, result, () => state.readWorkerResult(parentId, result.workerId))) {
    throw new Error('worker result is obsolete');
  }
  const snapshotId = assignWorkerResultSnapshotPath(result, parentId, (id, workerId, snap) => state.workerResultSnapshotPath(id, workerId, snap), diffSnapshot);
  const file = workerResultFileSchema.parse({ result, ...(diffSnapshot === undefined ? {} : { diffSnapshot: state.redactText(diffSnapshot) }) });
  const dir = state.workerResultsDir(parentId);
  const path = join(dir, `${result.workerId}.${snapshotId}.json`);
  if (existsSync(path)) throw new Error('worker result snapshot identity already exists');
  writeWorkerResultSnapshot(path, file, parentId, parent, result, snapshotId, old, (patches) => state.commitDelegation(patches));
  // Keep the latest payload only; bounded previous outcome metadata lives in the pointer.
  removeStaleWorkerResultSnapshots(dir, result.workerId, snapshotId);
  return result;
}

function assertWorkerResultOwnership(
  parentId: string,
  parent: RunRecord | undefined,
  worker: RunRecord | undefined,
  result: WorkerCollectedResult,
): asserts parent is RootRun {
  if (parent?.delegation?.role !== 'root' || result.parentRunId !== parentId ||
    !parent.delegation.receipts.some((receipt) => receipt.workerId === result.workerId)) throw new Error('missing result ownership');
  if (worker && workerResultRevisionChanged(parentId, worker, result)) throw new Error('worker result revision changed');
}

function workerResultRevisionChanged(parentId: string, worker: RunRecord, result: WorkerCollectedResult): boolean {
  return worker.delegation?.role !== 'worker' || worker.delegation.parentRunId !== parentId ||
    worker.delegation.workspace.ownerRunId !== worker.id || (worker.delegation.executionRevision ?? 0) !== result.revision || worker.status !== result.status;
}

function matchingStoredWorkerResult(
  stored: WorkerResultFile | undefined | false,
  result: WorkerCollectedResult,
  diffSnapshot: string | undefined,
  opts: { ignoreCleanup?: boolean },
  redactText: (text: string) => string,
): WorkerCollectedResult | undefined {
  if (stored && sameWorkerResult(stored.result, result, opts) &&
    stored.diffSnapshot === (diffSnapshot === undefined ? undefined : redactText(diffSnapshot))) return stored.result;
  return undefined;
}

function workerResultIsObsolete(
  worker: RunRecord | undefined,
  old: WorkerResultReference | undefined,
  result: WorkerCollectedResult,
  readStored: () => WorkerCollectedResult | undefined,
): boolean {
  if (!worker && !readStored()) return true;
  if (!old) return false;
  return old.revision > result.revision || (old.revision === result.revision && old.observedAt > result.observedAt);
}

function assignWorkerResultSnapshotPath(
  result: WorkerCollectedResult,
  parentId: string,
  snapshotPath: (parentId: string, workerId: string, snapshotId: string) => string,
  diffSnapshot: string | undefined,
): string {
  const snapshotId = result.diff.state === 'available' ? result.diff.snapshotId : randomUUID();
  if (result.diff.state === 'available') result.diff.path = snapshotPath(parentId, result.workerId, snapshotId);
  if (result.diff.state === 'available' && diffSnapshot === undefined) throw new Error('missing diff snapshot');
  return snapshotId;
}

function workerResultReference(
  result: WorkerCollectedResult,
  snapshotId: string,
  old: WorkerResultReference | undefined,
): WorkerResultReference {
  return {
    workerId: result.workerId, revision: result.revision, observedAt: result.observedAt, snapshotId,
    lastExecutionOutcome: result.lastExecutionOutcome,
    ...(old ? { previous: old.revision === result.revision ? old.previous : { revision: old.revision, observedAt: old.observedAt, lastExecutionOutcome: old.lastExecutionOutcome } } : {}),
  };
}

function writeWorkerResultSnapshot(
  path: string,
  file: WorkerResultFile,
  parentId: string,
  parent: RootRun,
  result: WorkerCollectedResult,
  snapshotId: string,
  old: WorkerResultReference | undefined,
  commitDelegation: WorkerResultCommitState['commitDelegation'],
): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(file)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    const reference = workerResultReference(result, snapshotId, old);
    commitDelegation([{ id: parentId, delegation: { ...parent.delegation,
      results: [...(parent.delegation.results ?? []).filter((entry) => entry.workerId !== result.workerId), reference],
    } }]);
  } catch (error) { rmSync(temp, { force: true }); if (old?.snapshotId !== snapshotId) rmSync(path, { force: true }); throw error; }
}

function removeStaleWorkerResultSnapshots(dir: string, workerId: string, snapshotId: string): void {
  for (const name of readdirSync(dir)) if (name.startsWith(`${workerId}.`) && name !== `${workerId}.${snapshotId}.json`) {
    try { rmSync(join(dir, name), { force: true }); } catch { /* retry on next collection */ }
  }
}
