import { WaitEngine } from './wait-engine.ts';
import type { RunLine } from './run-line.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished, vi } from 'vitest';
import { STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { AgentSession } from '../../core/agent-runner.ts';
import { type RunRecord, RunStore } from '../../runs/store.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import { createActiveRun, type ActiveRun } from '../active-run.ts';
import { unused } from '../fixture-no-runner.testkit.ts';
import { TurnSettler } from './turn-settler.ts';
import { HumanWaits } from './human-waits.ts';
import { WorkerQuestions } from './worker-questions.ts';
import type { RunModuleContext } from './types.ts';
import type { TurnEndOutcome } from '../turn-end.ts';
import { clearIdleTimer } from './input-timers.ts';
import * as boundary from './turn-boundary.ts';

/** Fact traces mark completed writes. Effect entries are traced before their named collaborators. */
export function traceBoundary(log: string[], observe?: (state: ActiveRun, event: boundary.TurnBoundaryEvent) => void,
  after?: (state: ActiveRun, event: boundary.TurnBoundaryEvent) => void): void {
  const original = boundary.transitionTurnBoundary;
  const trace = (...args:
    | [state: ActiveRun, event: boundary.FactOnlyBoundaryEvent]
    | [runId: string, state: ActiveRun, event: boundary.EffectBoundaryEvent, effects: boundary.TurnBoundaryEffects]
  ): TurnEndOutcome | undefined => {
    const event = args.length === 2 ? args[1] : args[2];
    observe?.(args.length === 2 ? args[0] : args[1], event);
    const entry = `boundary:${event.kind}/${'phase' in event ? event.phase : 'request'}`;
    if (args.length === 4) log.push(entry);
    const result = Reflect.apply(original, undefined, args);
    after?.(args.length === 2 ? args[0] : args[1], event);
    if (args.length === 2) log.push(entry);
    return result;
  };
  const spy = vi.spyOn(boundary, 'transitionTurnBoundary').mockImplementation(trace as typeof original);
  onTestFinished(() => spy.mockRestore());
}

interface BoundaryOrderFixture {
  root: string; run: RunRecord; store: RunStore; log: string[]; state: ActiveRun; wire: AgentSession;
  active: Map<string, ActiveRun>; context: RunModuleContext; waitEngine: WaitEngine; humanWaits: HumanWaits; questions: WorkerQuestions;
  questionHost: ConstructorParameters<typeof WorkerQuestions>[1]; host: ConstructorParameters<typeof TurnSettler>[1];
  line: RunLine; settler: TurnSettler;
}
export function boundaryOrderFixture(autonomous = false): BoundaryOrderFixture {
  const root = mkdtempSync(join(tmpdir(), 'cez-boundary-order-'));
  const log: string[] = [];
  const store = RunStore.open(join(root, '.ai/cezar'));
  const run = store.createRun({ title: 'boundary', task: 'work', workflow: 'quick-task', steps: [{ id: 'step', name: 'Step', kind: STEP_KIND.agent }] });
  store.move(run.id, 'start');
  store.updateStep(run.id, 'step', { status: STEP_STATUS.running });
  const state = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous });
  const active = new Map([[run.id, state]]);
  const call = <T>(name: string, result: T) => vi.fn(() => { log.push(name); return result; });
  const wire: AgentSession = { open: true, result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
    sendMessage: call('human-input', true), sendAgentMessage: call('agent-input', Promise.resolve()),
    holdsHumanInput: call('holds', false), discardQueuedMessages: call('discard', undefined), end: call('end', undefined), interrupt: call('interrupt', undefined) };
  state.liveSession.attachSession(wire); state.liveSession.selectStep('step');
  const append = store.appendEvent.bind(store);
  vi.spyOn(store, 'appendEvent').mockImplementation((id, event) => { log.push(`event:${event.type}`); return append(id, event); });
  const flush = store.flush.bind(store);
  vi.spyOn(store, 'flush').mockImplementation(() => { log.push('flush'); flush(); });
  const context = unused<RunModuleContext>('context', { store, repoRoot: root, dataDir: join(root, '.ai/cezar'), disposed: () => false,
    semaphore: unused<WorkspaceSemaphore>('semaphore', { monitoringWakeIntervalMinutes: () => 1, memoryLimitMb: () => 1 }) });
  const waitEngine = new WaitEngine(context, unused<ConstructorParameters<typeof WaitEngine>[1]>('engine', {
    withdrawCezarHumanWaits: id => humanWaits.withdrawCezarHumanWaits(id),
  }), 40);
  const humanWaits = new HumanWaits(context, { waitEngine, routeWorkerQuestion: call('route', undefined) }, 40);
  type QuestionHost = ConstructorParameters<typeof WorkerQuestions>[1];
  const questionHost = unused<QuestionHost>('workerQuestions', {
    active: id => active.get(id), deliverConversationInput: call('parent-input', undefined), openHumanAlias: (...args) => { log.push('alias'); return humanWaits.openHumanAlias(...args); },
    prepareHumanAsk: value => { log.push('prepare'); humanWaits.prepareHumanAsk(value); },
    markHumanWaitSurfaced: (...args) => { log.push('surfaced'); humanWaits.markHumanWaitSurfaced(...args); },
    routeWorkerQuestion: call('route', undefined),
  });
  const questions = new WorkerQuestions(context, questionHost, 40);
  type Host = ConstructorParameters<typeof TurnSettler>[1];
  const line = unused<RunLine>('line', { park: call('line-park', undefined), isParked: () => false,
    inPool: () => false, joinPool: call('join', undefined) });
  const host = unused<Host>('settler', {
    waitEngine, humanWaits, line, workerQuestions: questions,
    completionGateHost: unused<Host['completionGateHost']>('completionGate', { parentCompletionBlockers: () => [] }),
    subagentWaits: unused<Host['subagentWaits']>('subagents', { holdsLiveSubagents: () => false, atTurnEnd: call('subagents', undefined) }),
    move: (id, exit, patch, details) => { log.push('move'); return store.move(id, exit, patch, details); },
    releaseSlot: call('release', undefined), queueWaitWake: call('wake', undefined), leaveMonitoringPool: call('leave-pool', undefined),
    noticeParkedWorker: call('notice', undefined), canAutoContinue: () => true, countAutomaticWakes: () => 0,
    hasQueuedAgentInputs: () => false, workerExecutionStopped: () => false, executionBlockedByRootFinish: () => false,
    settledTurnOutcome: (_id, _entry, outcome) => { log.push('outcome'); return outcome; },
  });
  const settler = new TurnSettler(context, host, 60_000, 40, 'wait for workers', 3600);
  traceBoundary(log);
  onTestFinished(async () => {
    clearIdleTimer(state); store.flush(); await store.factsWarmIdle(); store.close(); rmSync(root, { recursive: true, force: true });
  });
  log.length = 0;
  return { root, run, store, log, state, wire, active, context, waitEngine, humanWaits, questions, questionHost, host, line, settler };
}
