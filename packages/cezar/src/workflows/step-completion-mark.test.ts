import { testHome } from '../home/test-home.testkit.ts';
import { bindLaunchSource } from './run/launch-read-resolver.ts';
import { transitionTurnBoundary } from './run/turn-boundary.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
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
import { noRunners } from '../core/runners-under-test.testkit.ts';

function unused<T extends object>(name: string, values: Partial<T> = {}): T {
  return new Proxy(values, { get(target, key) {
    if (key in target) return Reflect.get(target, key);
    throw new Error(`unused collaborator ${name}.${String(key)}`);
  } }) as T;
}

function fakeState(root: string): ActiveRun {
  const state = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
  transitionTurnBoundary(state, { kind: 'done-step-consumed', phase: 'completed', session: state.liveSession.session, stepId: step.id });
  return state;
}

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
    context = { createRunner: noRunners, home: testHome(), store, repoRoot: root, dataDir: join(root, '.ai/cezar'), work: new TrackedWork(),
      semaphore: new WorkspaceSemaphore({ home: testHome() }), disposed: () => false };
    type SettlementArgs = ConstructorParameters<typeof RunSettlement>;
    settlement = new RunSettlement(context, unused<SettlementArgs[1]>('line'),
      unused<SettlementArgs[2]>('humanWaits', { supersedeWorkerFallback: vi.fn() }),
      unused<SettlementArgs[3]>('autoResume'), unused<SettlementArgs[4]>('bookkeeper'),
      unused<SettlementArgs[5]>('workerExecutions'), unused<SettlementArgs[6]>('workerQuestions'),
      unused<SettlementArgs[7]>('subagentWaits'),
      unused<SettlementArgs[8]>('gate', { active, holdsAgentWaits: () => false }),
      unused<SettlementArgs[9]>('host', { move: (id, exit, patch) => store.move(id, exit, patch) }), '', '');
    type LoopArgs = ConstructorParameters<typeof StepLoop>;
    stepLoop = new StepLoop(context,
      unused<LoopArgs[1]>('loopHost', { active, executionBlockedByRootFinish: () => false,
        owesDelivery: () => false, closingWakeDecision: () => 'settle' }),
      unused<LoopArgs[2]>('line'), unused<LoopArgs[3]>('autosave'),
      unused<LoopArgs[4]>('humanWaits', { withdrawSquawkHumanWaits: vi.fn() }), settlement,
      unused<LoopArgs[6]>('stepSession'), unused<LoopArgs[7]>('gate', { holdsAgentWaits: () => false }), '');
    runId = store.createRun({ title: 'mark', task: 'work', workflow: 'chain', steps: [] }).id;
    store.addStep(runId, { id: step.id, name: step.id, kind: STEP_KIND.agent });
    setRunStatus(store, runId, RUN_STATUS.running);
    state = fakeState(root);
  });

  afterEach(() => {
    active.clear();
    store.flush();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([false, true])('Continue preserves the mark only when cancelled=%s', async cancelled => {
    if (cancelled) state.liveSession.cancel();
    const done = vi.spyOn(settlement, 'settleDoneContinuation').mockResolvedValue(undefined);
    const sink = new UiEventSink({ persist: vi.fn(), emitLive: vi.fn() });
    await settlement.settleClosedContinuation(runId, state, step.id, sink, next, {});
    expect(state.boundary.completedStepId).toBe(cancelled ? step.id : undefined);
    expect(done).toHaveBeenCalledTimes(cancelled ? 0 : 1);
    if (cancelled) expect(store.getRun(runId)?.status).toBe(RUN_STATUS.cancelled);
  });

  it.each([step.id, 'other'])('stepLeftOpen leaves the mark intact (%s)', mark => {
    transitionTurnBoundary(state, { kind: 'done-step-consumed', phase: 'completed', session: state.liveSession.session, stepId: mark });
    expect(settlement.stepLeftOpen(state, step.id, next)).toBe(mark !== step.id);
    expect(state.boundary.completedStepId).toBe(mark);
  });

  it.each([true, false])('step loop clears a consumed mark (completed=%s)', completed => {
    transitionTurnBoundary(state, { kind: 'done-step-consumed', phase: 'completed', session: state.liveSession.session, stepId: completed ? step.id : 'other' });
    active.set(runId, state);
    const execution: Execution = { runId, state, workflow: { name: 'chain', source: 'file', steps: [step, next] },
      input: bindLaunchSource({ task: 'work' }), startAt: 0, emit: vi.fn() };
    const launch = { taskBackend: 'codex' } as ExecutionLaunch;
    const loop: LoopOutcome = { checkFailure: null, runError: null, deliveryCapped: false };
    const result = stepLoop.nextAfterAgentStep(execution, launch, loop,
      { index: 0, step, nextStep: next, failure: null, startedAt: Date.now() });
    expect(state.boundary.completedStepId).toBeUndefined();
    expect(result).toBe(completed ? 'next' : 'settle');
    expect(loop.incompleteStepId).toBe(completed ? undefined : step.id);
  });
});
