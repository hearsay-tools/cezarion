/**
 * The label a run is listed under.
 *
 * No runtime import, so a consumer of it loads no schema (hearsay-tools/cezarion#1237).
 */
import type { RunRecord } from './runs.ts';

/** `(planned)` and `(inbox)` chains carry their meaning in their first agent step's name. */
export function runWorkflowLabel(run: Pick<RunRecord, 'workflow' | 'steps'>): string {
  if (run.workflow === '(planned)' || run.workflow === '(inbox)') {
    // `?? []`: the cockpit also projects streamed records, whose shape only `id` was checked on.
    const agent = (run.steps ?? []).find((step) => step.kind === 'agent');
    if (agent?.name) return agent.name;
  }
  return run.workflow;
}
