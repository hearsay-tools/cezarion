import type { RunnerId } from '../core/agent-runner.ts';
import type { RunRecord } from '../runs/store.ts';

/**
 * Resolve the next turn’s account: live step, queued continuation, latest session-owning step,
 * then run-level fields. Use this result for usage-limit holds in mixed-runner workflows.
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
