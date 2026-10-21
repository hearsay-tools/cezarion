import type { RunnerId } from '../core/agent-runner.ts';
import type { RunRecord } from '../runs/store.ts';

/**
 * The agent account a run's next turn runs on (hearsay-tools/cezarion#1236), which is what a
 * usage-limit hold is keyed by (`runAccountKey`).
 *
 * A mixed-runner workflow can run a step on another backend than the task-level `runner`, so the
 * record's runner is only the answer before any session exists. In order:
 *  1. a live session's own step settings;
 *  2. a queued continuation, resolved as `runContinuation` resolves it: the account of the session it
 *     resumes, else (a Continue that switched backend or account starts a new session) the run's
 *     account when it runs on the run's runner;
 *  3. the step that holds the latest session — what a resume reattaches to;
 *  4. the record's `runner` and `agentProfile`.
 */
export function executionAccount(
  run: Pick<RunRecord, 'runner' | 'agentProfile' | 'steps'>,
  continuation?: { backend: RunnerId; sessionId?: string },
  live?: { runner: RunnerId; agentProfile?: string },
): Pick<RunRecord, 'runner' | 'agentProfile'> {
  if (live) return { runner: live.runner, agentProfile: live.agentProfile };
  if (continuation) {
    const owning = continuation.sessionId === undefined ? undefined : run.steps.find((candidate) => candidate.sessionId === continuation.sessionId);
    const runAccount = continuation.backend === (run.runner ?? 'claude') ? run.agentProfile : undefined;
    return { runner: continuation.backend, agentProfile: owning?.profileId ?? runAccount };
  }
  const step = [...run.steps].reverse().find((candidate) => candidate.sessionId !== undefined && candidate.backend !== undefined);
  if (step) return { runner: step.backend, agentProfile: step.profileId ?? run.agentProfile };
  return { runner: run.runner, agentProfile: run.agentProfile };
}
