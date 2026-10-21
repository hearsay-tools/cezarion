import type { RunnerId } from '../core/agent-runner.ts';
import type { RunRecord } from '../runs/store.ts';

/**
 * The agent account a run's next turn runs on (hearsay-tools/cezarion#1236), which is what a
 * usage-limit hold is keyed by (`runAccountKey`).
 *
 * A mixed-runner workflow can run a step on another backend than the task-level `runner`, so the
 * record's runner is only the answer before any session exists. In order:
 *  1. a live session's own step settings;
 *  2. a continuation that switches backend (`continuationBackend` differs from the session's), on
 *     the run's account, as the continuation itself resolves it;
 *  3. the step that holds the latest session — what a resume or a continuation reattaches to;
 *  4. the record's `runner` and `agentProfile`.
 */
export function executionAccount(
  run: Pick<RunRecord, 'runner' | 'agentProfile' | 'steps'>,
  continuationBackend?: RunnerId,
  live?: { runner: RunnerId; agentProfile?: string },
): Pick<RunRecord, 'runner' | 'agentProfile'> {
  if (live) return { runner: live.runner, agentProfile: live.agentProfile };
  const step = [...run.steps].reverse().find((candidate) => candidate.sessionId !== undefined && candidate.backend !== undefined);
  if (continuationBackend !== undefined && step?.backend !== continuationBackend) {
    return { runner: continuationBackend, agentProfile: run.agentProfile };
  }
  if (step) return { runner: step.backend, agentProfile: step.profileId ?? run.agentProfile };
  return { runner: run.runner, agentProfile: run.agentProfile };
}
