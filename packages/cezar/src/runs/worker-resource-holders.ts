/**
 * Holder proof for worker persistent paths (worktree and scratch). `RunStore.workerResourceHolders`
 * reads the row and checkpoints, then these helpers decide whether the generation is gone.
 */
import { lstatSync } from 'node:fs';
import type { RunRecord } from '@open-mercato/cezar-contract';
import { isCurrentProcess, recordedProcessLive, type GenerationProbe, type WorkerProcessRecord } from '../delegation/process-liveness.ts';
import type { WorkerExecution } from './worker-execution.ts';

type WorkerOwnedRun = RunRecord & { delegation: Extract<RunRecord['delegation'], { role: 'worker' }> };

/** The row owns this generation's workspace and the checkpoint is complete, or queued when admitting. */
export function workerResourceAuthorized(
  run: RunRecord | undefined,
  proof: WorkerExecution | undefined,
  id: string,
  generation: string,
  resourceId: string,
  admittingQueued?: boolean,
): run is WorkerOwnedRun {
  return !(run?.delegation?.role !== 'worker' || run.delegation.workspace.ownerRunId !== id ||
    run.delegation.workspace.resourceId !== resourceId || proof?.generation !== generation ||
    (proof.phase !== 'complete' && !(admittingQueued && proof.phase === 'queued')));
}

/** Only ENOENT at every path proves absence; existsSync would also hide access errors. */
export function workerResourcePathsGone(paths: readonly string[]): boolean {
  return paths.every((path) => {
    try { lstatSync(path); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
  });
}

/** Recorded survivors still block reuse when every persistent path is already gone. */
export function workerResourceAbsentHolders(record: WorkerProcessRecord | 'absent'): 'safe' | number[] {
  return record === 'absent' ||
    ((!recordedProcessLive(record.controller) || isCurrentProcess(record.controller)) && !record.processes.some(recordedProcessLive)) ? 'safe' : [];
}

/** Live PIDs that refuse reuse, or `safe` when the generation is gone. */
export function workerResourceLiveHolders(probe: GenerationProbe): 'safe' | number[] {
  return probe.liveness === 'gone' ? 'safe' : probe.controller !== undefined ? [probe.controller] : probe.pids;
}
