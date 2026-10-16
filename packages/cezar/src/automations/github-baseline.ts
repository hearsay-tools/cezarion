import type { AutomationRuntimeState, GithubAutomationDefinition } from './types.ts';

/** A fresh discovery window. Receipts live separately and survive every re-arm. */
export function githubBaselineState(
  definition: GithubAutomationDefinition,
  now = Date.now(),
): Partial<AutomationRuntimeState> {
  const baselineAt = new Date(now - (definition.filters.includeExisting ? definition.filters.lookbackDays * 86_400_000 : 0)).toISOString();
  return {
    revision: definition.revision,
    baselineAt,
    armedAt: new Date(now).toISOString(),
    cursor: { timestamp: baselineAt },
    historyScan: undefined,
    frozenHighWatermark: undefined,
    backlogAfter: undefined,
    backoffUntil: undefined,
    consecutiveFailures: 0,
    nextCheckAt: new Date(now + definition.intervalSeconds * 1_000).toISOString(),
  };
}
