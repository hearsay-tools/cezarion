import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkerDestroyResult } from '@open-mercato/cezar-contract/delegation';
import type { RunRecord } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { agentTmpDirLocations, agentTmpDirOwnershipProven } from '../runs/agent-tmpdir.ts';
import type { DelegationProject } from './service.ts';
import { reapDestroyHolders } from './destroy-holders.ts';
import { assertDarwinMountBoundary, assertLinuxMountBoundary } from './mount-boundary.ts';
import { isCurrentProcess, recordedProcessLive } from './process-liveness.ts';
import { collectWorkerEvidence } from './results.ts';
import { windowsAssertMountBoundary } from './windows-workspace-identity.ts';
import { prepareDestroyAccess } from './workspace.ts';

type TerminationBlocker = NonNullable<ReturnType<RunManager['takeWorkerTerminationBlocker']>>;

export function assertDestroyIdentity(project: DelegationProject, workerId: string, worker: RunRecord,
  workspace: Extract<NonNullable<RunRecord['delegation']>, { role: 'worker' }>['workspace'], requestedAt: string, generation: string | undefined): void {
  if (worker.delegation?.role !== 'worker' || JSON.stringify(worker.delegation.workspace) !== JSON.stringify(workspace) ||
      worker.delegation.destroy?.requestedAt !== requestedAt || project.store.readWorkerExecution(workerId)?.generation !== generation) {
    throw new Error('Worker resource ownership changed');
  }
}

export function terminationFailure(workerId: string, resources: ('worktree' | 'branch')[], taken: TerminationBlocker | undefined) {
  const blocker = taken?.blocker;
  const reason = !blocker ? undefined : blocker.kind === 'unreadable' ? 'worker process record is unreadable; termination cannot be proven'
    : blocker.kind === 'controller' ? `the worker is still controlled by a live cezar (pid ${blocker.pid})`
    : `${blocker.pids.length === 1 ? 'process' : 'processes'} ${blocker.pids.join(', ')} still ${blocker.pids.length === 1 ? 'holds' : 'hold'} the worker's worktree or scratch`;
  const error = !blocker ? 'Worker termination is not proven; retry cleanup later'
    : blocker.kind === 'unreadable' ? reason! : `Worker termination is not proven: ${reason}; retry cleanup later`;
  const holders = blocker?.kind === 'processes' ? blocker.pids : blocker?.kind === 'controller' ? [blocker.pid] : [];
  const result: WorkerDestroyResult = { workerId, state: 'incomplete', remaining: ['process', ...resources], error };
  return { result, holders, reason };
}

export function assertRecordedProcessesStopped(project: DelegationProject, workerId: string, generation: string): void {
  const record = project.store.readWorkerProcesses(workerId, generation);
  if (record === 'unknown' || (record !== 'absent' &&
    ((!isCurrentProcess(record.controller) && recordedProcessLive(record.controller)) || record.processes.some(recordedProcessLive)))) {
    throw new Error('Recorded worker processes remain or cannot be verified; cleanup will retry');
  }
}

/** Authenticate and snapshot before a destroy-only resource reaper can signal. */
export async function prepareAuthoritativeReaper(project: DelegationProject, workerId: string, workspace: Extract<NonNullable<RunRecord['delegation']>, { role: 'worker' }>['workspace'],
  check: () => RunRecord, assertAttached: () => void): Promise<() => Promise<void>> {
  const dataDir = join(project.root, '.ai/cezar');
  const initialPaths = [workspace.path, ...agentTmpDirLocations(dataDir, workerId)];
  assertLinuxMountBoundary(initialPaths);
  assertDarwinMountBoundary(initialPaths);
  if (process.platform === 'win32') windowsAssertMountBoundary(initialPaths);
  let rootPresent = true;
  try { lstatSync(workspace.path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    rootPresent = false;
  }
  if (!agentTmpDirOwnershipProven(dataDir, workerId)) throw new Error('Worker scratch ownership cannot be verified');
  const generation = project.store.readWorkerExecution(workerId)?.generation;
  const initial = check();
  const requestedAt = initial.delegation?.role === 'worker' ? initial.delegation.destroy?.requestedAt : undefined;
  if (!requestedAt) throw new Error('Worker destroy intent is missing');
  const assertDestroyCurrent = () => {
    assertAttached();
    assertLinuxMountBoundary(initialPaths); assertDarwinMountBoundary(initialPaths);
    if (process.platform === 'win32') windowsAssertMountBoundary(initialPaths);
    const run = check();
    if (run.delegation?.role !== 'worker' || run.delegation.destroy?.requestedAt !== requestedAt || JSON.stringify(run.delegation.workspace) !== JSON.stringify(workspace) ||
        !agentTmpDirOwnershipProven(dataDir, workerId) || project.store.readWorkerExecution(workerId)?.generation !== generation) throw new Error('Worker resource ownership changed');
  };
  const rootCurrent = rootPresent ? await prepareDestroyAccess(project.root, workspace, assertDestroyCurrent) : () => {
    try { lstatSync(workspace.path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    throw new Error('Worker workspace appeared during scratch cleanup');
  };
  const current = async () => {
    assertLinuxMountBoundary([workspace.path, ...agentTmpDirLocations(dataDir, workerId)]);
    assertDarwinMountBoundary([workspace.path, ...agentTmpDirLocations(dataDir, workerId)]);
    assertAttached(); await rootCurrent(); assertAttached();
    const run = check();
    if (run.delegation?.role !== 'worker' || run.delegation.destroy?.requestedAt !== requestedAt || JSON.stringify(run.delegation.workspace) !== JSON.stringify(workspace) ||
        !agentTmpDirOwnershipProven(dataDir, workerId) ||
        project.store.readWorkerExecution(workerId)?.generation !== generation) throw new Error('Worker resource ownership changed');
  };
  const snapshot = structuredClone(check());
  const evidence = await collectWorkerEvidence(project.root, project.store, snapshot);
  await current();
  project.store.commitWorkerResult(evidence.result.parentRunId, evidence.result, evidence.diffSnapshot, { ignoreCleanup: true });
  return async () => {
    await current();
    const paths = [...(rootPresent ? [workspace.path] : []), ...agentTmpDirLocations(dataDir, workerId)];
    await reapDestroyHolders(paths, current);
  };
}
