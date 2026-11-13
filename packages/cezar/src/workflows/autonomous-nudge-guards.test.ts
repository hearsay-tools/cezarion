import { testHome } from '../home/test-home.testkit.ts';
import { transitionTurnBoundary } from './run/turn-boundary.ts';
import { InputFlight } from './run/input-delivery.ts';
import { runnerHook, setupMonitoringFixture, waitForProduct } from './run-fixture.testkit.ts';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import {
  RUN_STATUS,
  STEP_KIND,
  WAIT_KIND,
  WAIT_PHASE,
  WAIT_SOURCE,
  WAIT_VIA,
} from '@open-mercato/cezar-contract/test-factories.testkit';
import { clearIdleTimer } from './run/input-timers.ts';
import { TurnNudges } from './run/turn-nudges.ts';
import { InputDelivery } from './run/input-delivery.ts';
import { TurnSettler } from './run/turn-settler.ts';
import { TrackedWork } from './run/tracked-work.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import type { RunModuleContext } from './run/types.ts';
import { createActiveRun, type ActiveRun } from './active-run.ts';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession, AgentEvent, AgentRunResult } from '../core/agent-runner.ts';
import { ciWaitEntry, RunStore } from '../runs/store.ts';
import { setRunStatus, readPersistedRuns } from '../runs/run-store.testkit.ts';
import { createFixtureManager } from './fixture-cleanup.testkit.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import { AUTONOMOUS_NUDGE, COMPLETION_NO_REPLY_NOTE, NO_WAIT_NO_REPLY_NOTE, NO_WAIT_NUDGE_NOTE, IDLE_TIMEOUT_MS } from './run.ts';
import { noRunners } from '../core/runners-under-test.testkit.ts';

function unused<T extends object>(name: string, values: Partial<T> = {}): T {
  return new Proxy(values, { get(target, key) {
    if (key in target) return Reflect.get(target, key);
    throw new Error(`unused collaborator ${name}.${String(key)}`);
  } }) as T;
}

// Focused policy guards complement workflow-autonomous-parity's actual native
// wires. A refused nudge must never touch either transport or consume its budget.
type State = ActiveRun;
const ask = { questions: [{ header: 'Choice', question: 'Which framework?', options: [{ label: 'Vitest' }, { label: 'Node' }] }] };
const guards = ['disabled', 'cancelled', 'finish', 'disposed', 'stopping', 'input-error', 'native-ask', 'persisted-ask',
  'closed', 'queued-input', 'unread-input', 'input-flight', 'worker-wait', 'ci-wait', 'root-finish'] as const;

describe('autonomous nudge priority and lifecycle guards', () => {
  let root: string;
  let store: RunStore;
  let context: RunModuleContext;
  let nudges: TurnNudges;
  let disposed: boolean;
  const active = new Map<string, ActiveRun>();
  const submit = vi.fn(() => true);
  const charge = vi.fn(() => 40);
  const arm = vi.fn();
  const count = vi.fn(() => 0);
  const stopped = vi.fn(() => false);
  const blocked = vi.fn(() => false);
  const queued = vi.fn(() => false);
  const settle = vi.fn<ConstructorParameters<typeof InputDelivery>[1]['settleTurn']>(() => true);
  const canContinue = vi.fn(() => true);
  const readySubmit = vi.fn(() => true);
  function fakeState() {
    const value = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: true });
    value.liveSession.attachSession(session);
    return value;
  }
  function readiness() {
    type Host = ConstructorParameters<typeof InputDelivery>[1];
    const host = unused<Host>('inputHost', { active, workerExecutionStopped: stopped,
      executionBlockedByRootFinish: blocked, countAutomaticWakes: count, canAutoContinue: canContinue,
      settleTurn: settle, boundaryTurn: () => ({ stepId: 'task', humanGate: false, ask: null, done: false, monitoring: false, nudgedLastTurn: false }),
      pendingConversationWakes: () => [], routedAnswer: () => undefined, hasUnansweredHumanAsk: () => false,
      submitAgentInput: readySubmit, parkForUser: vi.fn(),
      line: unused<Host['line']>('inputLine', { isParked: () => false, isAdmitted: () => false }),
      humanWaits: unused<Host['humanWaits']>('inputHumanWaits', { holdsAgentWaits: () => false }),
      workerQuestions: unused<Host['workerQuestions']>('inputWorkerQuestions', { supersedeWorkerFallback: () => false }),
    });
    return new InputDelivery(context, host, 40, 'Reply to the parent.');
  }
  let id: string;
  let state: State;
  let session: AgentSession;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-autonomous-guards-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    id = store.createRun({ title: 'guard', task: 'work', workflow: 'quick-task', autonomous: true, steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] }).id;
    setRunStatus(store, id, RUN_STATUS.running);
    // Worker startup belongs to fixture setup, before policy tests replace timers.
    await store.factsWarmIdle();
    disposed = false; active.clear();
    vi.resetAllMocks();
    submit.mockReturnValue(true); charge.mockReturnValue(40); count.mockReturnValue(0);
    stopped.mockReturnValue(false); blocked.mockReturnValue(false); queued.mockReturnValue(false);
    settle.mockReturnValue(true); canContinue.mockReturnValue(true); readySubmit.mockReturnValue(true);
    context = { createRunner: noRunners, home: testHome(), store, repoRoot: root, dataDir: join(root, '.ai/cezar'), work: new TrackedWork(),
      semaphore: new WorkspaceSemaphore({ home: testHome() }), disposed: () => disposed };
    type Args = ConstructorParameters<typeof TurnNudges>;
    nudges = new TurnNudges(context, unused<Args[1]>('nudgeHumanWaits'),
      unused<Args[2]>('nudgeLine', { isParked: () => false }), unused<Args[3]>('completionGate'),
      unused<Args[4]>('nudgeHost', { active, workerExecutionStopped: stopped, executionBlockedByRootFinish: blocked,
        countAutomaticWakes: count, hasQueuedAgentInputs: queued, submitAgentInput: submit, chargeAutomaticWake: charge, armIdleTimer: arm }),
      40, 'Wait for workers.', 300);
    session = {
      open: true, result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
      sendMessage: vi.fn(() => true), sendAgentMessage: vi.fn(() => Promise.resolve()),
      end: vi.fn(), interrupt: vi.fn(), discardQueuedMessages: vi.fn(), holdsHumanInput: () => false,
    };
    state = fakeState();
    active.set(id, state);
  });
  afterEach(() => { clearIdleTimer(state); disposed = true; vi.useRealTimers(); store.close(); rmSync(root, { recursive: true, force: true }); });

  function applyGuard(guard: typeof guards[number]): void {
    canContinue.mockReturnValue(false);
    switch (guard) {
      case 'disabled': transitionTurnBoundary(state, { kind: 'mode-disabled', phase: 'disable', session: state.liveSession.session }); break; // includes the memory-limit pause
      case 'cancelled': state.liveSession.cancel(); break;
      case 'finish': state.liveSession.requestFinish(); break;
      case 'disposed': disposed = true; break;
      case 'stopping': store.updateRun(id, { stopping: true }); break;
      case 'input-error': state.inputState.recordInputError('transport failed'); break;
      case 'native-ask': transitionTurnBoundary(state, { kind: 'human-wait-opened', phase: 'refresh-question', session: state.liveSession.session, pending: true }); break;
      case 'persisted-ask': store.appendEvent(id, { type: 'ask.requested', requestId: randomUUID(), ...ask }); break;
      case 'closed': state.liveSession.attachSession({ ...session, open: false }); break;
      case 'queued-input': queued.mockReturnValue(true); store.commitAgentInputs(id, [{ id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId: randomUUID(), text: 'Read this first', createdAt: new Date().toISOString() }]); break;
      case 'unread-input': state.inputState.resetUnreadInputs(); state.inputState.recordUnreadInput(randomUUID()); break;
      case 'input-flight': state.inputState.attachFlight(new InputFlight(session, [randomUUID()])); break;
      // A worker wait is a list entry (hearsay-tools/cezarion#1235, #1301).
      case 'worker-wait': store.commitWait(id, { kind: WAIT_KIND.worker, id: randomUUID(), source: WAIT_SOURCE.agent, via: WAIT_VIA.cezar_wait, registeredAt: new Date().toISOString(),
        deadline: new Date(Date.now() + 60_000).toISOString(), timeoutSeconds: 60, phase: WAIT_PHASE.open, turnId: 'turn', mode: 'all',
        workerIds: [randomUUID()], revisions: [], outcomes: [] }); break;
      case 'ci-wait': store.commitWait(id, ciWaitEntry({
        id: randomUUID(), prUrl: 'https://github.com/acme/repo/pull/1', repository: 'acme/repo', prNumber: 1, headSha: 'a'.repeat(40),
        generation: 'generation', turnId: 'turn', timeoutSeconds: 60, until: 'checks' as const, wakeOnConflict: true, registeredAt: new Date().toISOString(), deadline: new Date(Date.now() + 60_000).toISOString(), phase: 'registered',
      })); break;
      case 'root-finish': blocked.mockReturnValue(true); store.commitDelegation([{ id, delegation: { role: 'root', permissions: [], receipts: [], finishRequestedAt: new Date().toISOString() } }]); break;
    }
  }

  it.each(guards)('%s blocks the nudge', guard => {
    applyGuard(guard);
    expect(nudges.tryAutonomousNudge(id, state, 'task')).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    expect(charge).not.toHaveBeenCalled();
    expect(arm).not.toHaveBeenCalled();
    expect(store.getRun(id)?.automaticWakes ?? 0).toBe(0);
    expect(store.readEvents(id).some(e => e.type === 'note' && String(e.message).includes('autonomous'))).toBe(false);
  });

  // hearsay-tools/cezarion#1234: one budget of automatic wakes on the record, for nudges and timers.
  it('autonomous nudges and timer wakes share one budget of 40', () => {
    count.mockReturnValue(39);
    expect(nudges.tryAutonomousNudge(id, state, 'task')).toBe(true);
    expect(submit).toHaveBeenCalledOnce();
    expect(charge).toHaveBeenCalledWith(id);
    expect(store.readEvents(id).some(e => e.type === 'note' && e.message === 'autonomous — continuing without pausing (40/40)')).toBe(true);
    count.mockReturnValue(40);
    expect(nudges.tryAutonomousNudge(id, state, 'task')).toBe(false);
    expect(charge).toHaveBeenCalledOnce();
    expect(store.readEvents(id).some(e => e.type === 'note' && String(e.message).startsWith('autonomous — safety cap reached (40)'))).toBe(true);
  });

  function pendingBoundary(): void {
    state.liveSession.selectStep('task');
    transitionTurnBoundary(state, { kind: 'turn-end', phase: 'ui-completed', session: session });
    transitionTurnBoundary(state, { kind: 'input-ready', phase: 'retain-nudge', session: session });
    active.set(id, state);
  }

  it.each(guards)('%s blocks a readiness retry', guard => {
    pendingBoundary();
    applyGuard(guard);
    readiness().handleAgentInputReady(id, state, session);
    expect(settle.mock.calls.some(call => call[2] === 'ready')).toBe(false);
    expect(store.getRun(id)?.automaticWakes ?? 0).toBe(0);
    if (guard === 'queued-input') {
      expect(readySubmit).toHaveBeenCalledOnce();
      expect(readySubmit).not.toHaveBeenCalledWith([{ type: 'text', text: AUTONOMOUS_NUDGE }], []);
    } else expect(readySubmit).not.toHaveBeenCalled();
  });

  it.each(['replaced-state', 'replaced-session', 'new-boundary', 'done', 'no-pending', 'closed-by-idle', 'session-error'] as const)(
    '%s revokes readiness authority', guard => {
      pendingBoundary();
      switch (guard) {
        case 'replaced-state': active.set(id, fakeState()); break;
        case 'replaced-session': state.liveSession.attachSession({ ...session }); break;
        case 'new-boundary': transitionTurnBoundary(state, { kind: 'turn-started', phase: 'clear-boundary', session: state.liveSession.session }); break;
        case 'done': transitionTurnBoundary(state, { kind: 'turn-end', phase: 'retain-done', session: session }); break;
        case 'no-pending': transitionTurnBoundary(state, { kind: 'input-ready', phase: 'clear-nudge', session: state.liveSession.session }); break;
        case 'closed-by-idle': transitionTurnBoundary(state, { kind: 'idle-expired', phase: 'close', session: state.liveSession.session }); break;
        case 'session-error': state.liveSession.recordSessionError('provider failed'); break;
      }
      readiness().handleAgentInputReady(id, state, session);
      expect(settle.mock.calls.some(call => call[2] === 'ready')).toBe(false);
      expect(readySubmit).not.toHaveBeenCalled();
      expect(store.getRun(id)?.automaticWakes ?? 0).toBe(0);
    },
  );

  it('a pending autonomous retry is not replaced by the no-wait nudge', () => {
    pendingBoundary();
    // The turn end an acknowledgement settles late decides by the same rule (hearsay-tools/cezarion#1525).
    type Args = ConstructorParameters<typeof TurnSettler>;
    const outcomes = vi.fn();
    const settler = new TurnSettler(context, unused<Args[1]>('settlerHost', {
      line: unused<Args[1]['line']>('settlerLine', { isParked: () => false }),
      humanWaits: unused<Args[1]['humanWaits']>('settlerHumanWaits', { holdsAgentWaits: () => false }),
      countAutomaticWakes: count, hasQueuedAgentInputs: queued, settledTurnOutcome: outcomes,
    }), 60_000, 40, 'Wait for workers.', 3600);
    expect(settler.settleTurn(id, state, 'ack', { stepId: 'task', humanGate: false, ask: null, done: false, monitoring: false, nudgedLastTurn: false })).toBe(true);
    expect(outcomes).toHaveBeenCalledWith(id, 'ack', { kind: 'readiness' });
    expect(state.boundary.autonomousNudgePending).toBe(session);
    expect(session.sendAgentMessage).not.toHaveBeenCalled();
    expect(session.sendMessage).not.toHaveBeenCalled();
    expect(store.readEvents(id).some(e => e.type === 'note' && String(e.message).startsWith(NO_WAIT_NUDGE_NOTE))).toBe(false);
  });

  it('nested subagent items do not clear the no-wait nudge reply bound', () => {
    transitionTurnBoundary(state, { kind: 'input-submitted', phase: 'nudge-delivered', session: session });
    active.set(id, state);
    nudges.armNoWaitNudgeReplyTimer(id, state);
    expect(state.boundary.noWaitNudgeReplyTimer).toBeDefined();
    nudges.noteNoWaitNudgeContent(id, state, {
      type: 'item.started',
      item: { parentItemId: 'parent' },
    });
    expect(state.boundary.noWaitNudgeReplyTimer).toBeDefined();
    nudges.noteNoWaitNudgeContent(id, state, { type: 'item.delta' });
    expect(state.boundary.noWaitNudgeReplyTimer).toBeDefined();
    nudges.noteNoWaitNudgeContent(id, state, {
      type: 'item.started',
      item: {},
    });
    expect(state.boundary.noWaitNudgeReplyTimer).toBeUndefined();
  });

  it('text before the reply timer is armed means the nudge was answered', () => {
    transitionTurnBoundary(state, { kind: 'input-submitted', phase: 'nudge-delivered', session: session });
    active.set(id, state);
    nudges.noteNoWaitNudgeContent(id, state, { type: 'text' });
    nudges.armNoWaitNudgeReplyTimer(id, state);
    expect(state.boundary.noWaitNudgeReplyTimer).toBeUndefined();
  });

  it('turn.started before the reply timer is armed does not count as a nudge reply', () => {
    transitionTurnBoundary(state, { kind: 'input-submitted', phase: 'nudge-delivered', session: session });
    active.set(id, state);
    nudges.noteNoWaitNudgeContent(id, state, { type: 'turn.started' });
    nudges.armNoWaitNudgeReplyTimer(id, state);
    expect(state.boundary.noWaitNudgeReplyTimer).toBeDefined();
    nudges.noteNoWaitNudgeContent(id, state, { type: 'turn.started' });
    expect(state.boundary.noWaitNudgeReplyTimer).toBeUndefined();
  });

  // hearsay-tools/cezarion#1234: an unanswered nudge opens Squawk's no-wait human wait, so the run
  // waits on the user and a late reply stays on that question.

  // hearsay-tools/cezarion#1301: an unanswered completion refusal nudge says so, not "no-wait".

});

describe('nudge bounds through a live runner', () => {
  const f = setupMonitoringFixture();
  let session: AgentSession | undefined;
  let emit: (event: AgentEvent) => void;
  let ready: () => void;
  let emitUi: (event: import('../core/ui-events.ts').UiEvent) => void;

  beforeEach(() => {
    session = undefined;
    f.manager.dispose();
    f.manager = createFixtureManager(f.store, f.repoRoot, { home: testHome(), noWaitNudgeReplyMs: 300 });
    runnerHook.runner = {
      backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => {},
      startSession(_spec, onEvent, options) {
        let open = true;
        let finish!: (result: AgentRunResult) => void;
        const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
        emit = event => onEvent?.(event);
        ready = () => options?.onAgentInputReady?.();
        emitUi = event => options?.onUiEvent?.(event);
        const close = () => { open = false; finish({ text: '', toolCalls: [], tokensUsed: 0 }); };
        session = { get open() { return open; }, result, sendMessage: vi.fn(() => true), sendAgentMessage: vi.fn(async () => {}),
          end: vi.fn(close), interrupt: vi.fn(close), discardQueuedMessages: vi.fn(), holdsHumanInput: () => false };
        queueMicrotask(() => emit({ type: 'session', sessionId: 'nudge-session' }));
        return session;
      },
    };
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  async function start(autonomous: boolean) {
    const record = f.manager.startRun(f.SINGLE_STEP, { task: 'work', runner: 'claude', autonomous, worktree: false });
    f.currentId = record.id;
    await waitForProduct(f.manager, f.store, () => !!session);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    if (!session) throw new Error('runner session missing');
    return { id: record.id, session };
  }

  it('refused ordinary input waits for readiness without charging the cap or releasing capacity', async () => {
    const { id, session } = await start(true);
    f.store.updateRun(id, { automaticWakes: 39 });
    vi.mocked(session.sendAgentMessage).mockReturnValueOnce(false);
    emit({ type: 'turn-end' });
    expect(f.store.getRun(id)).toMatchObject({ status: RUN_STATUS.running, automaticWakes: 39 });
    ready();
    expect(session.sendAgentMessage).toHaveBeenLastCalledWith([{ type: 'text', text: AUTONOMOUS_NUDGE }], []);
    expect(session.sendAgentMessage).toHaveBeenCalledTimes(2);
    expect(f.store.getRun(id)).toMatchObject({ status: RUN_STATUS.running, automaticWakes: 40 });
    expect(readPersistedRuns(join(f.repoRoot, '.ai/cezar')).find(record => record.id === id)?.automaticWakes).toBe(40);
    expect(session.sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 1);
    expect(session.open).toBe(true);
    expect(session.end).not.toHaveBeenCalled();
  });

  it('queued input takes readiness before an autonomous retry', async () => {
    const { id, session } = await start(true);
    vi.mocked(session.sendAgentMessage).mockReturnValueOnce(false);
    emit({ type: 'turn-end' });
    const inputId = randomUUID();
    f.store.commitAgentInputs(id, [{ id: inputId, parentRunId: randomUUID(), source: agentInputSchema.shape.source.enum.agent,
      text: 'Read this first', createdAt: new Date().toISOString() }]);
    ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.sendAgentMessage).toHaveBeenCalledTimes(2);
    expect(session.sendAgentMessage).toHaveBeenLastCalledWith([{ type: 'text', text: expect.stringContaining('Read this first') }], [inputId]);
    expect(f.store.getRun(id)?.automaticWakes ?? 0).toBe(0);
    expect(f.store.getRun(id)?.agentInputs?.find(input => input.id === inputId)?.deliveredAt).toEqual(expect.any(String));
  });

  it('parent activity invalidates the refused boundary and its timer', async () => {
    const { id, session } = await start(true);
    vi.mocked(session.sendAgentMessage).mockReturnValue(false);
    emit({ type: 'turn-end' });
    emitUi({ type: 'turn.started', turnId: randomUUID() });
    ready();
    expect(session.sendAgentMessage).toHaveBeenCalledOnce();
    expect(f.store.getRun(id)?.automaticWakes ?? 0).toBe(0);
    expect(f.store.getRun(id)?.status).toBe(RUN_STATUS.running);
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 1);
    expect(session.open).toBe(true);
    expect(session.end).not.toHaveBeenCalled();
  });

  it('user-authored delivery resets the no-wait nudge latch', async () => {
    const { id, session } = await start(false);
    emit({ type: 'turn-end' });
    await vi.advanceTimersByTimeAsync(0);
    expect(session.sendAgentMessage).toHaveBeenCalledOnce();
    expect(f.manager.sendMessage(id, [{ type: 'text', text: 'please continue' }])).toBe(true);
    emit({ type: 'turn-end' });
    expect(session.sendAgentMessage).toHaveBeenCalledTimes(2);
    expect(f.store.getRun(id)?.automaticWakes).toBe(1);
  });

  it('a transport exception fails without retaining a readiness retry', async () => {
    const { id, session } = await start(true);
    vi.mocked(session.sendAgentMessage).mockImplementation(() => { throw new Error('failed transport'); });
    emit({ type: 'turn-end' });
    expect(f.store.readEvents(id)).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'error', message: expect.stringContaining('failed transport'),
    })]));
    expect(session.interrupt).toHaveBeenCalledOnce();
    ready();
    expect(session.sendAgentMessage).toHaveBeenCalledOnce();
    expect(f.store.getRun(id)?.automaticWakes ?? 0).toBe(0);
  });

  it('missing readiness reaches the existing idle close bound', async () => {
    const { id, session } = await start(true);
    vi.mocked(session.sendAgentMessage).mockReturnValue(false);
    emit({ type: 'turn-end' });
    expect(f.store.getRun(id)?.automaticWakes ?? 0).toBe(0);
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    expect(session.end).toHaveBeenCalledOnce();
    expect(f.store.readEvents(id)).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'lifecycle', message: 'session closed after 15m of inactivity',
    })]));
    ready();
    expect(session.sendAgentMessage).toHaveBeenCalledOnce();
  });

  it('expiry opens the no-wait human wait and the run waits for the user', async () => {
    const { id } = await start(false);
    emit({ type: 'turn-end' });
    await vi.advanceTimersByTimeAsync(300);
    expect(f.store.getRun(id)?.status).toBe('waiting');
    expect(f.store.getRun(id)?.waits).toMatchObject([{ kind: WAIT_KIND.human, via: WAIT_VIA['no-wait'], source: WAIT_SOURCE.cezar, phase: WAIT_PHASE.open, askSeq: expect.any(Number) }]);
    expect(f.store.readEvents(id).filter(e => e.type === 'note' && e.message === NO_WAIT_NO_REPLY_NOTE)).toHaveLength(1);
  });

  it('expiry after a completion nudge names the completion nudge', async () => {
    const tools = vi.spyOn(f.manager, 'squawkToolHandlers');
    const { id } = await start(false);
    f.store.commitDelegation([{ id, delegation: { role: 'root', permissions: [], receipts: [] } }]);
    const handlers = tools.mock.results.find(result => result.type === 'return')?.value;
    expect(handlers).toBeDefined();
    expect(await handlers!.finishTurn({}, new AbortController().signal)).toMatchObject({ ok: true });
    const recipient = f.store.createRun({ title: 'peer', task: 'peer', workflow: 'quick-task', steps: [] });
    f.store.commitConversation(id, { messages: [{ id: randomUUID(), senderRunId: id, recipientRunId: recipient.id,
      kind: 'request', relationship: 'peer', text: 'Check', createdAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 600_000).toISOString(), state: 'accepted', requestHash: 'a'.repeat(64),
    }], outcomes: [] });
    emit({ type: 'turn-end' });
    await vi.advanceTimersByTimeAsync(300);
    expect(f.store.getRun(id)?.status).toBe('waiting');
    const notes = f.store.readEvents(id).filter(e => e.type === 'note').map(e => e.message);
    expect(notes.filter(message => message === COMPLETION_NO_REPLY_NOTE)).toHaveLength(1);
    expect(notes).not.toContain(NO_WAIT_NO_REPLY_NOTE);
  });
});
