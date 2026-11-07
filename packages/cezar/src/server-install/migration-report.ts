import type { PlatformMigrationReport, ServerState, StepArtifact } from './types.ts';

function matches(a: StepArtifact, b: StepArtifact): boolean {
  return a.kind === b.kind && a.type === b.type && a.name === b.name && a.path === b.path;
}

/** Apply successful resource moves after group commit. Never mutate the input ledger. */
export function applyMigrationReport(state: ServerState, report: PlatformMigrationReport): ServerState {
  const steps = { ...state.steps };
  for (const { stepId, from, to } of report.moved) {
    const step = steps[stepId];
    if (!step) throw new Error(`Unknown migration step: ${stepId}`);
    const artifacts = [...(step.created?.artifacts ?? [])];
    const index = artifacts.findIndex((artifact) => matches(artifact, from));
    if (index >= 0) artifacts[index] = { ...to };
    else if (!artifacts.some((artifact) => matches(artifact, to))) artifacts.push({ ...to });
    steps[stepId] = { ...step, created: { ...step.created, artifacts } };
  }
  return { ...state, steps };
}
