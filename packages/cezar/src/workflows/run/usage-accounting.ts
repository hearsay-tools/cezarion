import type { RunnerId } from '../../core/agent-runner.ts';
import { unregisterRunProcess } from '../../core/process-usage.ts';
import type { UiEvent } from '../../core/ui-events.ts';
import type { RunRecord, RunStore, StepState } from '../../runs/store.ts';
import type { ActiveRun } from '../active-run.ts';

export interface UsageAccountingHost {
  isDisposedDelegatedRun(runId: string): boolean;
}

/** Persist the invocation checkpoint before launching a runner. A throw or
 * process exit before `turn.started` therefore leaves a durable mismatch. */
export function beginUsageInvocation(store: RunStore, runId: string, state: ActiveRun, stepId: string): void {
  const step = store.getRun(runId)?.steps.find((candidate) => candidate.id === stepId);
  if (!step) return;
  const epoch = (step.usageInvocationEpoch ?? 0) + 1;
  persistUsageCheckpoint(store, runId, stepId, {
    usageInvocationEpoch: epoch,
    usageInvocationsStarted: (step.usageInvocationsStarted ?? 0) + 1,
  });
  state.usageInvocation = {
    stepId,
    epoch,
    observed: false,
    startedTurns: new Set(),
    recordedTurns: new Set(),
  };
}

/** Claude's `total_cost_usd` is cumulative for the conversation, including
 * turns in Continue steps. Other runners emit per-message cost deltas. */
export function recordReportedCost(store: RunStore, runId: string, stepId: string, state: ActiveRun, backend: RunnerId, reportedUsd: number): void {
  if (!Number.isFinite(reportedUsd) || reportedUsd < 0) return;
  const run = store.getRun(runId);
  const step = run?.steps.find((candidate) => candidate.id === stepId);
  if (!run || !step) return;
  let delta = reportedUsd;
  if (backend === 'claude') {
    const sessionKey = step.sessionId ?? step.id;
    state.reportedClaudeCost ??= new Map();
    let previous = state.reportedClaudeCost.get(sessionKey);
    if (previous === undefined) {
      previous = restoreReportedClaudeCost(store, runId, stepId, run, step, reportedUsd);
    }
    delta = Math.max(0, reportedUsd - previous);
    state.reportedClaudeCost.set(sessionKey, Math.max(previous, reportedUsd));
  }
  store.updateStep(runId, stepId, { costUsd: (step.costUsd ?? 0) + delta });
}

/** Rebuild Claude's session checkpoint and restore reports missing from step totals. */
function restoreReportedClaudeCost(
  store: RunStore,
  runId: string,
  stepId: string,
  run: RunRecord,
  step: StepState,
  reportedUsd: number,
): number {
  // The current cost event was appended immediately before this call. Rebuild
  // the checkpoint from raw reports, since older records summed cumulative
  // reports into costUsd and cannot be used as the baseline on Continue.
  const events = store.readEvents(runId);
  let currentReportIndex = -1;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.type === 'cost' && event.stepId === stepId && event.usd === reportedUsd) {
      currentReportIndex = index;
      break;
    }
  }
  const sessionStepIds = new Set(run.steps.filter((candidate) => {
    return (candidate.backend === 'claude' || candidate.backend === undefined) && (step.sessionId
      ? candidate.sessionId === step.sessionId
      : candidate.id === step.id);
  }).map((candidate) => candidate.id));
  let previous = 0;
  const priorCostByStep = new Map<string, number>();
  for (let index = 0; index < events.length; index++) {
    if (index === currentReportIndex) continue;
    const event = events[index]!;
    if (event.type === 'cost' && event.stepId && sessionStepIds.has(event.stepId) &&
        typeof event.usd === 'number' && Number.isFinite(event.usd) && event.usd >= 0) {
      priorCostByStep.set(event.stepId,
        (priorCostByStep.get(event.stepId) ?? 0) + Math.max(0, event.usd - previous));
      previous = Math.max(previous, event.usd);
    }
  }
  // The event log is appended before the step total. A process exit between
  // those writes leaves a report whose USD never reached the run record.
  // Restore missing amounts, while preserving older inflated totals rather
  // than silently migrating historical run state.
  for (const [priorStepId, expectedCost] of priorCostByStep) {
    const priorStep = run.steps.find((candidate) => candidate.id === priorStepId);
    if (priorStep && (priorStep.costUsd === undefined || priorStep.costUsd < expectedCost)) {
      store.updateStep(runId, priorStepId, { costUsd: expectedCost });
    }
  }
  return previous;
}

/** Fold backend-neutral completed-turn usage into the current step exactly
 * once. Invocation/turn counters are written before the event reaches the
 * NDJSON sink so crashes cannot preserve a falsely complete subtotal. */
export function recordUsageUiEvent(store: RunStore, runId: string, state: ActiveRun, event: UiEvent): void {
  const invocation = state.usageInvocation;
  if (!invocation) return;
  const step = store.getRun(runId)?.steps.find((candidate) => candidate.id === invocation.stepId);
  if (!step) return;

  if (event.type === 'turn.started') {
    if (invocation.startedTurns.has(event.turnId)) return;
    invocation.startedTurns.add(event.turnId);
    const firstObservedTurn = !invocation.observed;
    invocation.observed = true;
    persistUsageCheckpoint(store, runId, invocation.stepId, {
      usageTurnsStarted: (step.usageTurnsStarted ?? 0) + 1,
      ...(firstObservedTurn
        ? { usageInvocationsObserved: (step.usageInvocationsObserved ?? 0) + 1 }
        : {}),
    });
    return;
  }

  if (event.type !== 'turn.completed') return;
  recordCompletedTurnUsage(store, runId, invocation, step, event);
}

/** Record valid completed-turn usage after a matching start, once per turn. */
function recordCompletedTurnUsage(
  store: RunStore,
  runId: string,
  invocation: NonNullable<ActiveRun['usageInvocation']>,
  step: StepState,
  event: Extract<UiEvent, { type: 'turn.completed' }>,
): void {
  if (!invocation.startedTurns.has(event.turnId) || invocation.recordedTurns.has(event.turnId)) return;
  const input = event.usage?.input;
  const output = event.usage?.output;
  if (
    typeof input !== 'number' ||
    !Number.isFinite(input) ||
    input < 0 ||
    typeof output !== 'number' ||
    !Number.isFinite(output) ||
    output < 0
  ) {
    return;
  }
  invocation.recordedTurns.add(event.turnId);
  persistUsageCheckpoint(store, runId, invocation.stepId, {
    inputTokens: (step.inputTokens ?? 0) + input,
    outputTokens: (step.outputTokens ?? 0) + output,
    usageTurnsRecorded: (step.usageTurnsRecorded ?? 0) + 1,
  });
}

/** Usage completeness is a crash boundary, unlike high-frequency token
 * snapshots: the checkpoint must reach `runs.json` before the runner starts
 * or the matching UI event is persisted and forwarded. */
export function persistUsageCheckpoint(
  store: RunStore,
  runId: string,
  stepId: string,
  patch: Partial<Omit<StepState, 'id'>>,
): void {
  store.updateStep(runId, stepId, patch);
  store.flush();
}

/**
 * End-of-session telemetry (#348): stop sampling the run's process tree and
 * fold the session's peaks into the run record. `max` with existing values —
 * a run can hold several sessions (multiple agent steps, Continue) and the
 * record keeps the highest water mark across all of them.
 */
export function recordUsagePeaks(store: RunStore, host: UsageAccountingHost, runId: string): void {
  const peaks = unregisterRunProcess(runId);
  if (!peaks || host.isDisposedDelegatedRun(runId)) return;
  const run = store.getRun(runId);
  store.updateRun(runId, {
    peakRssBytes: Math.max(run?.peakRssBytes ?? 0, peaks.peakRssBytes),
    peakProcCount: Math.max(run?.peakProcCount ?? 0, peaks.peakProcCount),
  });
}
