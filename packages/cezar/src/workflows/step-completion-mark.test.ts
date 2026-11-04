import { RUN_STATUS, STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { createActiveRun, type ActiveRun } from './active-run.ts';
import { RunSettlement } from './run/run-settlement.ts';
import { StepLoop } from './run/step-loop.ts';
import { TrackedWork } from './run/tracked-work.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import type { RunModuleContext } from './run/types.ts';
import type { Execution, ExecutionLaunch, StepLoop as LoopOutcome } from './run/types.ts';
import { UiEventSink } from '../runs/ui-event-sink.ts';

const step = { id: 'work', prompt: 'work' };
const next = { id: 'tail', prompt: 'tail' };

describe('step completion mark at settlement callers', () => {
  let root: string;
  let store: RunStore;
  let context: RunModuleContext;
  let settlement: RunSettlement;
  let stepLoop: StepLoop;
  const active = new Map<string, ActiveRun>();
  let runId: string;
  let state: ActiveRun;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-step-mark-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    context = { store, repoRoot: root, dataDir: join(root, '.ai/cezar'), work: new TrackedWork(),
      semaphore: new WorkspaceSemaphore(), disposed: () => false };
    type SettlementArgs = ConstructorParameters<typeof RunSettlement>;
    settlement = new RunSettlement(context, {} as SettlementArgs[1], { supersedeWorkerFallback: vi.fn() } as unknown as SettlementArgs[2], {} as SettlementArgs[3],
      {} as SettlementArgs[4], {} as SettlementArgs[5], {} as SettlementArgs[6], {} as SettlementArgs[7],
      { active, holdsAgentWaits: () => false } as unknown as SettlementArgs[8],
      { move: (id, exit, patch) => store.move(id, exit, patch) } as SettlementArgs[9], '', '');
    type LoopArgs = ConstructorParameters<typeof StepLoop>;
    stepLoop = new StepLoop(context, { active, executionBlockedByRootFinish: () => false, owesDelivery: () => false, closingWakeDecision: () => 'settle' } as unknown as LoopArgs[1], {} as LoopArgs[2], {} as LoopArgs[3], { withdrawCezarHumanWaits: vi.fn() } as unknown as LoopArgs[4],
      settlement, {} as LoopArgs[6], { holdsAgentWaits: () => false } as unknown as LoopArgs[7], '');
    runId = store.createRun({ title: 'mark', task: 'work', workflow: 'chain', steps: [] }).id;
    store.addStep(runId, { id: step.id, name: step.id, kind: STEP_KIND.agent });
    store.updateRun(runId, { status: RUN_STATUS.running });
    state = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
    state.completedStepId = step.id;
  });

  afterEach(() => {
    active.clear();
    store.flush();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([false, true])('Continue preserves the mark only when cancelled=%s', async cancelled => {
    state.cancelled = cancelled;
    const done = vi.spyOn(settlement, 'settleDoneContinuation').mockResolvedValue(undefined);
    const sink = new UiEventSink({ persist: vi.fn(), emitLive: vi.fn() });
    await settlement.settleClosedContinuation(runId, state, step.id, sink, next, {});
    expect(state.completedStepId).toBe(cancelled ? step.id : undefined);
    expect(done).toHaveBeenCalledTimes(cancelled ? 0 : 1);
    if (cancelled) expect(store.getRun(runId)?.status).toBe(RUN_STATUS.cancelled);
  });

  it.each([step.id, 'other'])('stepLeftOpen leaves the mark intact (%s)', mark => {
    state.completedStepId = mark;
    expect(settlement.stepLeftOpen(state, step.id, next)).toBe(mark !== step.id);
    expect(state.completedStepId).toBe(mark);
  });

  it.each([true, false])('step loop clears a consumed mark (completed=%s)', completed => {
    state.completedStepId = completed ? step.id : 'other';
    active.set(runId, state);
    const execution: Execution = { runId, state, workflow: { name: 'chain', source: 'file', steps: [step, next] },
      input: { task: 'work' }, startAt: 0, emit: vi.fn() };
    const launch = { taskBackend: 'codex' } as ExecutionLaunch;
    const loop: LoopOutcome = { checkFailure: null, runError: null, deliveryCapped: false };
    const result = stepLoop.nextAfterAgentStep(execution, launch, loop,
      { index: 0, step, nextStep: next, failure: null, startedAt: Date.now() });
    expect(state.completedStepId).toBeUndefined();
    expect(result).toBe(completed ? 'next' : 'settle');
    expect(loop.incompleteStepId).toBe(completed ? undefined : step.id);
  });
});
