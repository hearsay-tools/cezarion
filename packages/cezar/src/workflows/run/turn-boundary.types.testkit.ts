import type { ActiveRun } from '../active-run.ts';
import type { AgentSession } from '../../core/agent-runner.ts';
import { transitionTurnBoundary } from './turn-boundary.ts';

/** Compile-only fixture. The test tsconfig checks overload separation without running these calls. */
export function boundaryOverloadProof(state: ActiveRun, session: AgentSession): void {
  transitionTurnBoundary(state, { kind: 'done-request', session });
  transitionTurnBoundary('run', state, { kind: 'input-error', phase: 'interrupt', session }, { interruptSession: wire => wire.interrupt() });
  // @ts-expect-error Fact-only phases cannot receive effects, even with a run identifier.
  transitionTurnBoundary('run', state, { kind: 'done-request', session }, {});
  // @ts-expect-error Effect phases require the run identifier and named effects.
  transitionTurnBoundary(state, { kind: 'input-error', phase: 'interrupt', session });
  // @ts-expect-error A named effect is required for the input-error phase.
  transitionTurnBoundary('run', state, { kind: 'input-error', phase: 'interrupt', session }, {});
}
