import { existsSync } from 'node:fs';
import type { RunRecord } from '../../runs/store.ts';
import { rematerializeReclaimedWorktree } from '../../runs/retention.ts';
import { ownedContinuationWorkspace } from './run-workspace.ts';
import type { RunExitId } from '../run-states.ts';
import type { RunLine } from './run-line.ts';
import type { RunModuleContext, WorkerDelegationRecord } from './types.ts';

export interface ContinuationSessionHost {
  move(runId: string, exit: RunExitId, patch?: Partial<RunRecord>): void;
  dropActive(runId: string): void;
}

/** Owns the Continue workspace and launch session. */
export class ContinuationSession {
  constructor(
    private readonly context: RunModuleContext,
    private readonly host: ContinuationSessionHost,
    private readonly line: RunLine,
  ) {}

  /** Where a Continue runs: an owned worker's verified workspace, or the task's worktree, which
   *  retention may have reclaimed (#483), else the repository root. Returns undefined after an
   *  unavailable owned workspace failed the run. */
  async continuationWorkspace(
    runId: string,
    stepId: string,
    record: RunRecord | undefined,
  ): Promise<{ cwd: string; rematerialized: boolean } | undefined> {
    if (record?.delegation?.role === 'worker') {
      const cwd = await this.ownedContinuationWorkspace(runId, stepId, record, record.delegation);
      return cwd === undefined ? undefined : { cwd, rematerialized: false };
    }
    // Retention (#483) rebuilt a reclaimed directory: a bare checkout that needs setup again (#917).
    const rematerialized = await rematerializeReclaimedWorktree(this.context.repoRoot, this.context.store, runId);
    const cwd = record?.worktreePath && existsSync(record.worktreePath) ? record.worktreePath : this.context.repoRoot;
    return { cwd, rematerialized };
  }


  /** An owned worker's workspace for a Continue, verified with its parent's context. Returns
   *  undefined after it failed the run: owned workers never adopt or recreate an unverified resource. */
  async ownedContinuationWorkspace(
    runId: string,
    stepId: string,
    record: RunRecord,
    delegation: WorkerDelegationRecord,
  ): Promise<string | undefined> {
    try {
      return await ownedContinuationWorkspace(this.context.store, this.context.repoRoot, this.context.dataDir, record, delegation);
    } catch (error) {
      const message = `owned workspace unavailable: ${error instanceof Error ? error.message : String(error)}`;
      const finishedAt = new Date().toISOString();
      this.context.store.updateStep(runId, stepId, { status: 'failed', error: message, finishedAt });
      this.host.move(runId, 'fail-start', { error: message, finishedAt, currentStepId: undefined });
      this.context.store.appendEvent(runId, { type: 'lifecycle', message });
      this.line.unmarkStarting(runId);
      this.host.dropActive(runId);
      return undefined;
    }
  }


  /** A Stop that arrived while the Continue resolved its workspace cancels the run before it
   *  becomes active. */
  settleStoppedContinuation(runId: string): boolean {
    if (!this.context.store.getRun(runId)?.stopping) return false;
    this.host.move(runId, 'cancel', { finishedAt: new Date().toISOString() });
    this.line.unmarkStarting(runId);
    this.host.dropActive(runId);
    return true;
  }

}
