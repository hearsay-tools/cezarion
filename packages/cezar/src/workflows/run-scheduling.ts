import { isUsageLimitHold } from '@open-mercato/cezar-contract/waits';
import type { RunnerId } from '../core/agent-runner.ts';
import type { RunRecord } from '../runs/store.ts';
import type { AccountHolds } from '../workspace/semaphore.ts';
import type { StartRunInput } from './run/types.ts';
import type { WorkflowDef } from './types.ts';
import type { resolvedWaits } from './waits.ts';

/**
 * A deadline hold blocks all work on its account. An in-flight resume holds fresh work only;
 * other resumes must remain eligible.
 */
export function accountHeldFor(
  run: Pick<RunRecord, 'runner' | 'agentProfile' | 'status' | 'autoResumeAttempts'>,
  holds: AccountHolds,
  fallbackRunner: RunnerId,
): boolean {
  const key = runAccountKey(run, fallbackRunner);
  if (holds.deadline.has(key)) return true;
  return holds.inFlight.has(key) && !resumeInFlight(run);
}

/**
 * Key usage-limit holds by resolved runner and account. fallbackRunner applies before a run
 * records its runner.
 */
export function runAccountKey(
  run: Pick<RunRecord, 'runner' | 'agentProfile'>,
  fallbackRunner: RunnerId,
): string {
  return `${run.runner ?? fallbackRunner}:${run.agentProfile ?? 'default'}`;
}

/**
 * Whether an automatic resume has not completed its first turn. Such resumes bypass in-flight
 * holds, but not a future deadline hold.
 */
export function resumeInFlight(run: Pick<RunRecord, 'status' | 'autoResumeAttempts'>): boolean {
  return (
    run.autoResumeAttempts !== undefined && (run.status === 'queued' || run.status === 'running')
  );
}

/** Fixed opening turn; the queued results themselves are delivered after its turn end. */
export function sessionlessWakePrompt(resolved: ReturnType<typeof resolvedWaits>): string {
  return resolved.some(wait => wait.kind === 'pr')
    ? 'Resume to receive the queued CI observation. End this opening turn so Cezar can deliver it; do not poll CI.'
    : resolved.some(wait => wait.kind === 'worker')
      ? 'Resume to receive the queued worker wait result. End this opening turn so Cezar can deliver it.'
      : resolved.some(wait => wait.kind === 'subagent')
        ? 'Resume to receive the queued subagent wait result: your native subagents are no longer running. End this opening turn so Cezar can deliver it.'
      : resolved.length ? 'Resume to receive the queued timer result. End this opening turn so Cezar can deliver it.'
        : 'Resume to receive queued messages. End this opening turn so Cezar can deliver them.';
}

/** Resume the persisted pending tail instead of replaying completed agents. */
export function queuedStartAt(run: RunRecord, workflow: WorkflowDef): number {
  return Math.max(0, workflow.steps.findIndex(definition =>
    run.steps.find(step => step.id === definition.id)?.status === 'pending'));
}

/** Input before hydration, preserving autonomy and an explicit worktree opt-out on restart. */
export function queuedRecoveryInput(run: RunRecord): StartRunInput {
  return {
    task: run.task,
    agentProfile: run.agentProfile,
    systemPrompt: run.systemPrompt,
    model: run.model,
    effort: run.effort,
    runner: run.runner,
    autonomous: run.autonomous,
    worktree: run.worktree,
  };
}

/**
 * The wake instant as a human reads it — local, to the SECOND, with the zone named. The
 * transcript line is what someone scanning a stalled task actually reads, and "18:41" is not
 * enough to tell a wait that is nearly over from one that just started; the machine-readable ISO
 * copy lives on `RunRecord.autoResumeAt`. Server-side formatting is honest here because cezar is
 * local-first: the process and the browser reading it are the same machine.
 */
export function formatWakeInstant(at: Date): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' }).format(at);
}

/**
 * Derive this project’s future-deadline and in-flight account holds from records for the shared
 * semaphore. Past deadlines do not block the queue.
 */
export function deriveAccountHolds(
  records: RunRecord[],
  withExecutionAccount: <T extends RunRecord>(run: T) => T,
  now = Date.now(),
): AccountHolds {
  const deadline = new Set<string>();
  const inFlight = new Set<string>();
  for (const run of records) {
    // A holding run always carries the runner it actually ran on, so the fallback is unused
    // here — it is spelled out rather than `!` so a future record shape degrades, not throws.
    const key = () => runAccountKey(withExecutionAccount(run), run.runner ?? 'claude');
    if (isUsageLimitHold(run)) {
      const at = Date.parse(run.autoResumeAt);
      if (Number.isFinite(at) && at > now) deadline.add(key());
    } else if (resumeInFlight(run)) {
      inFlight.add(key());
    }
  }
  return { deadline, inFlight };
}
