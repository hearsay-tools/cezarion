import { WakeRetries } from './run/wake-retries.ts';
import { RunLine } from './run/run-line.ts';
import { WorkerQuestions } from './run/worker-questions.ts';
import { FamilyReconciler } from './run/family-reconciler.ts';
import { WaitWatches } from './run/wait-watches.ts';
import { WaitRegistry } from './run/wait-registry.ts';
import { HumanWaits } from './run/human-waits.ts';
import { TurnNudges } from './run/turn-nudges.ts';
import { WorktreeAutosave } from './run/worktree-autosave.ts';
import { WorkerOrphans } from './run/worker-orphans.ts';
import { WorkerExecutions } from './run/worker-executions.ts';
import { AutomationToolsSlot } from './run/cezar-tools.ts';
import { MaintenanceClaims } from './run/maintenance-claims.ts';
import { AttachmentWriter } from './run/attachment-writer.ts';
import { QueuedInput } from './run/queued-input.ts';
import { InboxClaims } from './run/inbox-claims.ts';
import { RepoRootLease } from './run/repo-root-lease.ts';
import { TurnBookkeeper } from './run/turn-bookkeeping.ts';
import { RunSkills } from './run/run-skills.ts';
import { StepSession } from './run/step-session.ts';
import { AutoResumeScheduler } from './run/auto-resume.ts';
import { RunRecovery } from './run/run-recovery.ts';
import { WakeAdmission } from './run/wake-admission.ts';
import { ContinuationAcceptance } from './run/continuation-acceptance.ts';
import { RunSettlement } from './run/run-settlement.ts';
import { ContinuationSession } from './run/continuation-session.ts';
import { StepLoop as WorkflowStepLoop } from './run/step-loop.ts';
import { TurnSettler } from './run/turn-settler.ts';
import { InputDelivery } from './run/input-delivery.ts';
import type { RunManager } from './run.ts';
import type { RunModuleContext } from './run/types.ts';
import type { ActiveRun } from './active-run.ts';

export const RUN_MODULE_CLASSES = {
  retries: WakeRetries,
  line: RunLine,
  workerQuestions: WorkerQuestions,
  familyReconciler: FamilyReconciler,
  waitWatches: WaitWatches,
  waitRegistry: WaitRegistry,
  humanWaits: HumanWaits,
  turnNudges: TurnNudges,
  worktreeAutosave: WorktreeAutosave,
  orphans: WorkerOrphans,
  workerExecutions: WorkerExecutions,
  automationToolsSlot: AutomationToolsSlot,
  claims: MaintenanceClaims,
  attachments: AttachmentWriter,
  queuedInput: QueuedInput,
  inboxClaims: InboxClaims,
  repoRootLease: RepoRootLease,
  turnBookkeeper: TurnBookkeeper,
  runSkills: RunSkills,
  stepSession: StepSession,
  autoResumeScheduler: AutoResumeScheduler,
  recovery: RunRecovery,
  wakeAdmission: WakeAdmission,
  continuationAcceptance: ContinuationAcceptance,
  runSettlement: RunSettlement,
  continuationSession: ContinuationSession,
  stepLoop: WorkflowStepLoop,
  turnSettler: TurnSettler,
  inputDelivery: InputDelivery,
} as const;

type RunInternals = { [K in keyof typeof RUN_MODULE_CLASSES]: InstanceType<(typeof RUN_MODULE_CLASSES)[K]> } & {
  context: RunModuleContext; active: Map<string, ActiveRun>; disposed: boolean;
};

/** The single typed test read of facade-owned module instances and shared state. */
export function runInternals(manager: RunManager): RunInternals {
  return manager as unknown as RunInternals;
}
