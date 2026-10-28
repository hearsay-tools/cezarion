import type { AgentSession } from '../../core/claude-cli-runner.ts';
import type { ActiveRun } from '../active-run.ts';
import type { WorkflowStepDef } from '../types.ts';

/** The session whose done completes a step that is not the last, and the step it starts next. */
export function stepScope(session: AgentSession, next: WorkflowStepDef | undefined): ActiveRun['nextStep'] {
  return next ? { session, label: stepLabel(next) } : undefined;
}

/** A step a successful settlement completes: still open, and not the one kept for a resume. */
export function settlesAsDone(step: { id: string; status: string }, keepStepId: string | undefined): boolean {
  return (step.status === 'running' || step.status === 'waiting') && step.id !== keepStepId;
}

/** How `cezar_done` names the step its done starts: the rail's name, else the id. A workflow file
 *  may give a step an empty name, and the done answer's `next_step` must not be empty. */
export function stepLabel(step: WorkflowStepDef): string {
  return step.name?.trim() ? step.name : step.id;
}
