import { RUN_STATUS, STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { createActiveRun, type ActiveRun } from './active-run.ts';
import { RunManager } from './run.ts';
import type { RunSettlement } from './run/run-settlement.ts';
import type { StepLoop } from './run/step-loop.ts';
import type { Execution, ExecutionLaunch, StepLoop as LoopOutcome } from './run/types.ts';
import { UiEventSink } from '../runs/ui-event-sink.ts';

function runInternals(manager: RunManager) {
  return manager as unknown as { runSettlement: RunSettlement; stepLoop: StepLoop; active: Map<string, ActiveRun> };
}

const step = { id: 'work', prompt: 'work' };
const next = { id: 'tail', prompt: 'tail' };

describe('step completion mark at settlement callers', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let runId: string;
  let state: ActiveRun;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-step-mark-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = new RunManager(store, root);
    runId = store.createRun({ title: 'mark', task: 'work', workflow: 'chain', steps: [] }).id;
    store.addStep(runId, { id: step.id, name: step.id, kind: STEP_KIND.agent });
    store.updateRun(runId, { status: RUN_STATUS.running });
    state = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
    state.completedStepId = step.id;
  });

  afterEach(() => {
    runInternals(manager).active.delete(runId);
    manager.dispose();
    store.flush();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([false, true])('Continue preserves the mark only when cancelled=%s', async cancelled => {
    state.cancelled = cancelled;
    const settlement = runInternals(manager).runSettlement;
    const done = vi.spyOn(settlement, 'settleDoneContinuation').mockResolvedValue(undefined);
    const sink = new UiEventSink({ persist: vi.fn(), emitLive: vi.fn() });
    await settlement.settleClosedContinuation(runId, state, step.id, sink, next, {});
    expect(state.completedStepId).toBe(cancelled ? step.id : undefined);
    expect(done).toHaveBeenCalledTimes(cancelled ? 0 : 1);
    if (cancelled) expect(store.getRun(runId)?.status).toBe(RUN_STATUS.cancelled);
  });

  it.each([step.id, 'other'])('stepLeftOpen leaves the mark intact (%s)', mark => {
    state.completedStepId = mark;
    expect(runInternals(manager).runSettlement.stepLeftOpen(state, step.id, next)).toBe(mark !== step.id);
    expect(state.completedStepId).toBe(mark);
  });

  it.each([true, false])('step loop clears a consumed mark (completed=%s)', completed => {
    state.completedStepId = completed ? step.id : 'other';
    const internal = runInternals(manager);
    internal.active.set(runId, state);
    const execution: Execution = { runId, state, workflow: { name: 'chain', source: 'file', steps: [step, next] },
      input: { task: 'work' }, startAt: 0, emit: vi.fn() };
    const launch = { taskBackend: 'codex' } as ExecutionLaunch;
    const loop: LoopOutcome = { checkFailure: null, runError: null, deliveryCapped: false };
    const result = internal.stepLoop.nextAfterAgentStep(execution, launch, loop,
      { index: 0, step, nextStep: next, failure: null, startedAt: Date.now() });
    expect(state.completedStepId).toBeUndefined();
    expect(result).toBe(completed ? 'next' : 'settle');
    expect(loop.incompleteStepId).toBe(completed ? undefined : step.id);
  });
});
