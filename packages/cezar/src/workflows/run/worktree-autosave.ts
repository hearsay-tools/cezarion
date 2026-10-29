import { autosaveCleanupBlocker, retainAutosaveCleanup, clearAutosaveCleanup } from '../../autosave-cleanup.ts';
import { autosaveCommit, type AutosaveOutcome, type AutosaveReason } from '../../git-worktree.ts';
import { recordHandoffAutosave, recordHandoffPeriodicAutosave } from '../../handoff.ts';
import type { ActiveRun } from '../active-run.ts';
import type { RunModuleContext } from './types.ts';

interface WorktreeAutosaveHost {
  holdForMaintenance(runIds: readonly string[]): (() => void) | null;
  reapTerminalScratch(runId: string): void;
  releaseSlot(): void;
  saveWorktree(runId: string, state: ActiveRun, reason: AutosaveReason): Promise<void>;
  trackTurn(runId: string, task: Promise<void>): void;
}

/** Periodic "cezar autosave" commit in the task worktree (spec 006). */
export const AUTOSAVE_INTERVAL_MS = 90_000;

/**
 * Periodic saves are opt-in. Turn-end, finalization and pre-PR flushes remain enabled; only
 * pre-PR follows a repointed HEAD. Coalesce timer-save evidence in the handoff.
 */
export function periodicAutosaveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_AUTOSAVE === '1';
}

/** The handoff block's autosave record and cockpit note for a save that committed or left work
 *  behind (hearsay-tools/cezarion#1004): a resumed session reads this, not `git log`. */
function autosaveReportLine(reason: AutosaveReason, outcome: AutosaveOutcome, taskBranch: string | undefined): string {
  const where = outcome.branch ?? 'detached HEAD';
  if (outcome.result === 'committed') {
    const what = outcome.sha ? `${outcome.sha} on ${where}` : `on ${where} (sha unavailable)`;
    return `${reason}: cezar autosave committed ${what}; ` +
      `to fold it into your own commits while it is HEAD, run \`git reset --soft ${outcome.sha ?? 'HEAD'}~1\``;
  }
  return `${reason}: ${outcome.changedPaths} changed path(s) left uncommitted on ${where}; ` +
    `cezar does not autosave on a branch other than the task branch ${taskBranch ?? '(unrecorded)'}`;
}

export class WorktreeAutosave {
  constructor(private readonly context: RunModuleContext, private readonly host: WorktreeAutosaveHost) {}

  /** The save may finish execution while its strict writer proof remains pending. */
  private readonly autosaveTasks = new Map<string, { settlement: Promise<void>; blocker?: string }>();

  /** Cleanup evidence survives manager disposal and store close/reopen. */
  autosaveCleanupBlocker(runId: string): string | undefined {
    return this.autosaveTasks.get(runId)?.blocker ?? autosaveCleanupBlocker(this.context.dataDir, runId);
  }

  /** Keep a separate maintenance hold until autosave proves all its processes exited.
   *  Commits only while HEAD is the run's recorded branch (hearsay-tools/cezarion#1004), and
   *  records a commit or a skip in the run store, shown in the handoff's records block, and as a
   *  note; a periodic save records only a commit, with no note, merged with the
   *  periodic commits right before it. A run with no recorded branch keeps committing on
   *  whatever HEAD is. */
  saveWorktree(runId: string, state: ActiveRun, reason: AutosaveReason): Promise<void> {
    return this.context.work.track('saveWorktree', this.saveWorktreeWork(runId, state, reason));
  }

  private async saveWorktreeWork(runId: string, state: ActiveRun, reason: AutosaveReason): Promise<void> {
    if (state.cwd === this.context.repoRoot) return;
    for (;;) {
      const previous = this.autosaveTasks.get(runId);
      if (!previous) break;
      await previous.settlement;
      // A blocked save still owns the tree. Do not queue another writer behind it.
      if (previous.blocker) return;
    }
    const note = (message: string) => {
      try { this.context.store.appendEvent(runId, { type: 'note', message }); }
      catch { /* Cleanup may outlive the store or its history; reporting cannot interrupt it. */ }
    };
    let settle!: () => void;
    const entry: { settlement: Promise<void>; blocker?: string } = { settlement: new Promise(resolve => { settle = resolve; }) };
    this.autosaveTasks.set(runId, entry);
    let release: (() => void) | undefined;
    let retained = false;
    let cleanupConfirmed = false;
    let taskBranch: string | undefined;
    try { taskBranch = this.context.store.getRun(runId)?.branch; } catch { /* A closed store keeps the old rule. */ }
    let outcome: AutosaveOutcome | undefined;
    const task = autosaveCommit(state.cwd, reason, {
      ...(taskBranch ? { taskBranch } : {}),
      onOutcome: reported => { outcome = reported; },
      onWarning: note,
      onBlocked: (message, proof) => {
        retainAutosaveCleanup(this.context.dataDir, runId, state.cwd, message, proof);
        retained = true;
        if (!release) {
          const hold = this.host.holdForMaintenance([runId]);
          if (!hold) return; // Never release execution without a replacement writer guard.
          release = hold;
          note(`${reason} autosave unsuccessful; run can settle, working files remain in ${state.cwd}`);
        }
        entry.blocker = message;
        settle();
      },
    });
    void task.then(result => {
      cleanupConfirmed = true;
      if (result === 'failed') note(`${reason} autosave failed; working files remain in ${state.cwd}`);
      else if (result === 'refused') note(`${reason} autosave refused: unresolved conflicts or an unfinished merge, cherry-pick or revert; working files remain in ${state.cwd}`);
      else if (outcome && reason === 'periodic') {
        // The timer reports its commits too, since a clean closing flush reports nothing
        // (review on hearsay-tools/cezarion#1111): one coalesced handoff line per run of
        // periodic commits and no note, as a note every 90 s would flood the timeline. A
        // periodic skip stays silent; the closing flush reports one with the final count.
        if (outcome.result === 'committed') {
          recordHandoffPeriodicAutosave(this.context.store, this.context.dataDir, runId, outcome);
        }
      } else if (outcome) {
        const message = autosaveReportLine(reason, outcome, taskBranch);
        note(message);
        recordHandoffAutosave(this.context.store, this.context.dataDir, runId, message);
      }
    }, error => note(`${reason} autosave failed: ${String(error)}; working files remain in ${state.cwd}`)).finally(() => {
      if (this.autosaveTasks.get(runId) === entry) this.autosaveTasks.delete(runId);
      if (retained && cleanupConfirmed) {
        try { clearAutosaveCleanup(this.context.dataDir, runId); }
        catch { note('autosave cleanup confirmed but retained evidence could not be cleared; worktree reuse remains blocked'); }
      }
      try { release?.(); } catch { /* The store may already be closed; durable evidence is independent. */ }
      if (entry.blocker) {
        note(this.autosaveCleanupBlocker(runId) ? 'autosave cleanup confirmed; retained evidence still blocks worktree reuse' : 'autosave cleanup confirmed; worktree reuse is available again');
        if (!this.context.disposed()) this.host.reapTerminalScratch(runId);
        if (!this.context.disposed()) this.host.releaseSlot();
      }
      settle();
    });
    await entry.settlement;
  }

  /** Autosave-commit the worktree every 90 s while the run lives (spec 006).
   *  Opt-in via CEZ_AUTOSAVE=1 (open-mercato/cezar#471) — see periodicAutosaveEnabled. */
  armAutosave(runId: string, state: ActiveRun): void {
    if (!periodicAutosaveEnabled()) return;
    if (state.cwd === this.context.repoRoot || state.autosaveTimer) return;
    state.autosaveTimer = setInterval(() => {
      const task = this.host.saveWorktree(runId, state, 'periodic');
      this.host.trackTurn(runId, task);
    }, AUTOSAVE_INTERVAL_MS);
    state.autosaveTimer.unref?.();
  }

  dispose(): void { this.autosaveTasks.clear(); }
}
