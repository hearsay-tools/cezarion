import { runInternals } from './run-internals.testkit.ts';
import type { ActiveRun } from './active-run.ts';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { AUTONOMOUS_NUDGE, COMPLETION_NO_REPLY_NOTE, NO_WAIT_NO_REPLY_NOTE, NO_WAIT_NUDGE_NOTE, RunManager } from './run.ts';

// Focused policy guards complement workflow-autonomous-parity's actual native
// wires. A refused nudge must never touch either transport or consume its budget.
type State = ActiveRun;
const ask = { questions: [{ header: 'Choice', question: 'Which framework?', options: [{ label: 'Vitest' }, { label: 'Node' }] }] };
const guards = ['disabled', 'cancelled', 'finish', 'disposed', 'stopping', 'input-error', 'native-ask', 'persisted-ask',
  'closed', 'queued-input', 'unread-input', 'input-flight', 'worker-wait', 'ci-wait', 'root-finish'] as const;

describe('autonomous nudge priority and lifecycle guards', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let id: string;
  let state: State;
  let session: AgentSession;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-autonomous-guards-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    id = store.createRun({ title: 'guard', task: 'work', workflow: 'quick-task', autonomous: true, steps: [{ id: 'task', name: 'Task', kind: 'agent' }] }).id;
    store.updateRun(id, { status: 'running' });
    // Worker startup belongs to fixture setup, before policy tests replace timers.
    await store.factsWarmIdle();
    manager = new RunManager(store, root, { noWaitNudgeReplyMs: 300 });
    session = {
      open: true, result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
      sendMessage: vi.fn(() => true), sendAgentMessage: vi.fn(() => Promise.resolve()),
      end: vi.fn(), interrupt: vi.fn(), discardQueuedMessages: vi.fn(), holdsHumanInput: () => false,
    };
    state = { cwd: root, cancelled: false, interrupt: () => {}, pendingHumanAsk: false, autonomous: true, session };
  });
  afterEach(() => { manager['clearIdleTimer'](state); manager.dispose(); vi.useRealTimers(); store.close(); rmSync(root, { recursive: true, force: true }); });

  function applyGuard(guard: typeof guards[number]): void {
    switch (guard) {
      case 'disabled': state.autonomous = false; break; // includes the memory-limit pause
      case 'cancelled': state.cancelled = true; break;
      case 'finish': state.finishRequested = true; break;
      case 'disposed': manager.dispose(); break;
      case 'stopping': store.updateRun(id, { stopping: true }); break;
      case 'input-error': state.agentInputError = 'transport failed'; break;
      case 'native-ask': state.pendingHumanAsk = true; break;
      case 'persisted-ask': store.appendEvent(id, { type: 'ask.requested', requestId: randomUUID(), ...ask }); break;
      case 'closed': state.session = { ...session, open: false }; break;
      case 'queued-input': store.commitAgentInputs(id, [{ id: randomUUID(), source: 'agent', parentRunId: randomUUID(), text: 'Read this first', createdAt: new Date().toISOString() }]); break;
      case 'unread-input': state.unreadInputIds = new Set([randomUUID()]); break;
      case 'input-flight': state.agentInputFlight = { session, inputIds: [randomUUID()] }; break;
      // A worker wait is a list entry (hearsay-tools/cezarion#1235, #1301).
      case 'worker-wait': store.commitWait(id, { kind: 'worker', id: randomUUID(), source: 'agent', via: 'cezar_wait', registeredAt: new Date().toISOString(),
        deadline: new Date(Date.now() + 60_000).toISOString(), timeoutSeconds: 60, phase: 'open', turnId: 'turn', mode: 'all',
        workerIds: [randomUUID()], revisions: [], outcomes: [] }); break;
      case 'ci-wait': store.commitCiWait(id, {
        id: randomUUID(), prUrl: 'https://github.com/acme/repo/pull/1', repository: 'acme/repo', prNumber: 1, headSha: 'a'.repeat(40),
        generation: 'generation', turnId: 'turn', timeoutSeconds: 60, until: 'checks' as const, wakeOnConflict: true, registeredAt: new Date().toISOString(), deadline: new Date(Date.now() + 60_000).toISOString(), phase: 'registered',
      }); break;
      case 'root-finish': store.commitDelegation([{ id, delegation: { role: 'root', permissions: [], receipts: [], finishRequestedAt: new Date().toISOString() } }]); break;
    }
  }

  for (const portable of [false, true]) it.each(guards)('%s blocks the nudge (portable ASK=' + portable + ')', guard => {
    applyGuard(guard);
    expect(runInternals(manager).turnNudges.tryAutonomousNudge(id, state, 'task', portable ? ask : null)).toBe(false);
    expect(session.sendMessage).not.toHaveBeenCalled();
    expect(session.sendAgentMessage).not.toHaveBeenCalled();
    expect(store.getRun(id)?.automaticWakes ?? 0).toBe(0);
    expect(store.readEvents(id).some(e => e.type === 'note' && String(e.message).includes('autonomous'))).toBe(false);
  });

  // hearsay-tools/cezarion#1234: one budget of automatic wakes on the record, for nudges and timers.
  it('autonomous nudges and timer wakes share one budget of 40', async () => {
    store.updateRun(id, { automaticWakes: 39 });
    expect(runInternals(manager).turnNudges.tryAutonomousNudge(id, state, 'task', null)).toBe(true);
    expect(store.getRun(id)?.automaticWakes).toBe(40);
    // The charge is committed at once, so a crash before the debounced save cannot lose it.
    expect(readPersistedRuns(join(root, '.ai/cezar')).find(record => record.id === id)?.automaticWakes).toBe(40);
    expect(store.readEvents(id).some(e => e.type === 'note' && e.message === 'autonomous — continuing without pausing (40/40)')).toBe(true);
    // The nudge's input was acknowledged; only the budget stands in the way of the next one.
    await state.agentInputFlight?.settled;
    state.agentInputFlight = undefined;
    expect(runInternals(manager).turnNudges.tryAutonomousNudge(id, state, 'task', null)).toBe(false);
    expect(store.getRun(id)?.automaticWakes).toBe(40);
    expect(store.readEvents(id).some(e => e.type === 'note' && String(e.message).startsWith('autonomous — safety cap reached (40)'))).toBe(true);
  });

  it('a nudge the wire refuses after an ask line leaves the question and budget untouched', () => {
    vi.mocked(session.sendMessage).mockReturnValue(false);
    expect(runInternals(manager).turnNudges.tryAutonomousNudge(id, state, 'task', ask)).toBe(false);
    expect(store.getRun(id)?.automaticWakes ?? 0).toBe(0);
    expect(store.readEvents(id).filter(e => e.type === 'note' || e.type === 'human-input-delivered')).toEqual([]);
  });

  function pendingBoundary(): void {
    state.currentStepId = 'task';
    state.atTurnBoundary = session;
    state.autonomousNudgePending = session;
    manager['active'].set(id, state);
  }

  it.each(guards)('%s blocks a readiness retry', guard => {
    pendingBoundary();
    applyGuard(guard);
    manager['handleAgentInputReady'](id, state, session);
    expect(session.sendMessage).not.toHaveBeenCalled();
    expect(store.getRun(id)?.automaticWakes ?? 0).toBe(0);
    if (guard === 'queued-input') {
      expect(session.sendAgentMessage).toHaveBeenCalledOnce();
      expect(session.sendAgentMessage).not.toHaveBeenCalledWith([{ type: 'text', text: AUTONOMOUS_NUDGE }], []);
      expect(state.autonomousNudgePending).toBeUndefined();
    } else expect(session.sendAgentMessage).not.toHaveBeenCalled();
  });

  it.each(['replaced-state', 'replaced-session', 'new-boundary', 'done', 'no-pending', 'closed-by-idle', 'session-error'] as const)(
    '%s revokes readiness authority', guard => {
      pendingBoundary();
      switch (guard) {
        case 'replaced-state': manager['active'].set(id, { ...state }); break;
        case 'replaced-session': state.session = { ...session }; break;
        case 'new-boundary': state.atTurnBoundary = undefined; break;
        case 'done': state.doneAtBoundary = session; break;
        case 'no-pending': state.autonomousNudgePending = undefined; break;
        case 'closed-by-idle': state.idleClosed = true; break;
        case 'session-error': state.agentSessionError = 'provider failed'; break;
      }
      manager['handleAgentInputReady'](id, state, session);
      expect(session.sendMessage).not.toHaveBeenCalled();
      expect(session.sendAgentMessage).not.toHaveBeenCalled();
      expect(store.getRun(id)?.automaticWakes ?? 0).toBe(0);
    },
  );

  it('refused ordinary input waits for readiness without charging the cap or releasing capacity', () => {
    pendingBoundary();
    vi.mocked(session.sendAgentMessage).mockReturnValueOnce(false);
    expect(runInternals(manager).turnNudges.tryAutonomousNudge(id, state, 'task', null)).toBe(false);
    expect(state.autonomousNudgePending).toBe(session);
    expect(state.idleTimer).toBeDefined();
    expect(store.getRun(id)?.automaticWakes ?? 0).toBe(0);
    expect(store.getRun(id)?.status).toBe('running');
    expect(runInternals(manager).line.waiting.has(id)).toBe(false);
    manager['handleAgentInputReady'](id, state, session);
    expect(session.sendAgentMessage).toHaveBeenLastCalledWith([{ type: 'text', text: AUTONOMOUS_NUDGE }], []);
    expect(state.autonomousNudgePending).toBeUndefined();
    expect(state.idleTimer).toBeUndefined();
    expect(store.getRun(id)?.automaticWakes).toBe(1);
    expect(session.sendMessage).not.toHaveBeenCalled();
  });

  it('missing readiness reaches the existing idle close bound', () => {
    vi.useFakeTimers();
    pendingBoundary();
    vi.mocked(session.sendAgentMessage).mockReturnValue(false);
    expect(runInternals(manager).turnNudges.tryAutonomousNudge(id, state, 'task', null)).toBe(false);
    vi.runOnlyPendingTimers();
    expect(session.end).toHaveBeenCalledOnce();
    expect(state.idleClosed).toBe(true);
    manager['handleAgentInputReady'](id, state, session);
    expect(session.sendAgentMessage).toHaveBeenCalledOnce();
    expect(store.getRun(id)?.automaticWakes ?? 0).toBe(0);
  });

  it('parent activity invalidates the refused boundary and its timer', () => {
    pendingBoundary();
    vi.mocked(session.sendAgentMessage).mockReturnValue(false);
    runInternals(manager).turnNudges.tryAutonomousNudge(id, state, 'task', null);
    manager['handleRunnerUiEvent'](id, state, manager['makeUiSink'](id, 'task'), { type: 'turn.started', turnId: randomUUID() });
    expect(state.autonomousNudgePending).toBeUndefined();
    expect(state.atTurnBoundary).toBeUndefined();
    expect(state.idleTimer).toBeUndefined();
    manager['handleAgentInputReady'](id, state, session);
    expect(session.sendAgentMessage).toHaveBeenCalledOnce();
  });

  it('a pending autonomous retry is not replaced by the no-wait nudge', () => {
    pendingBoundary();
    // The turn end an acknowledgement settles late decides by the same rule (hearsay-tools/cezarion#1525).
    expect(manager['settleTurn'](id, state, 'ack', manager['boundaryTurn'](id, state, session, false))).toBe(true);
    expect(state.autonomousNudgePending).toBe(session);
    expect(session.sendAgentMessage).not.toHaveBeenCalled();
    expect(session.sendMessage).not.toHaveBeenCalled();
    expect(store.readEvents(id).some(e => e.type === 'note' && String(e.message).startsWith(NO_WAIT_NUDGE_NOTE))).toBe(false);
  });

  it('nested subagent items do not clear the no-wait nudge reply bound', () => {
    state.noWaitNudged = session;
    manager['active'].set(id, state);
    runInternals(manager).turnNudges.armNoWaitNudgeReplyTimer(id, state);
    expect(state.noWaitNudgeReplyTimer).toBeDefined();
    runInternals(manager).turnNudges.noteNoWaitNudgeContent(id, state, {
      type: 'item.started',
      item: { parentItemId: 'parent' },
    });
    expect(state.noWaitNudgeReplyTimer).toBeDefined();
    runInternals(manager).turnNudges.noteNoWaitNudgeContent(id, state, { type: 'item.delta' });
    expect(state.noWaitNudgeReplyTimer).toBeDefined();
    runInternals(manager).turnNudges.noteNoWaitNudgeContent(id, state, {
      type: 'item.started',
      item: {},
    });
    expect(state.noWaitNudgeReplyTimer).toBeUndefined();
  });

  it('text before the reply timer is armed means the nudge was answered', () => {
    state.noWaitNudged = session;
    manager['active'].set(id, state);
    runInternals(manager).turnNudges.noteNoWaitNudgeContent(id, state, { type: 'text' });
    runInternals(manager).turnNudges.armNoWaitNudgeReplyTimer(id, state);
    expect(state.noWaitNudgeReplyTimer).toBeUndefined();
  });

  it('turn.started before the reply timer is armed does not count as a nudge reply', () => {
    state.noWaitNudged = session;
    manager['active'].set(id, state);
    runInternals(manager).turnNudges.noteNoWaitNudgeContent(id, state, { type: 'turn.started' });
    runInternals(manager).turnNudges.armNoWaitNudgeReplyTimer(id, state);
    expect(state.noWaitNudgeReplyTimer).toBeDefined();
    runInternals(manager).turnNudges.noteNoWaitNudgeContent(id, state, { type: 'turn.started' });
    expect(state.noWaitNudgeReplyTimer).toBeUndefined();
  });

  it('user-authored delivery resets the no-wait nudge latch', () => {
    state.noWaitNudged = session;
    manager['active'].set(id, state);
    expect(manager['deliverMessage'](id, [{ type: 'text', text: 'please continue' }], true)).toBe(true);
    expect(state.noWaitNudged).toBeUndefined();
  });

  // hearsay-tools/cezarion#1234: an unanswered nudge opens Cezar's no-wait human wait, so the run
  // waits on the user and a late reply stays on that question.
  it('expiry opens the no-wait human wait and the run waits for the user', async () => {
    vi.useFakeTimers();
    state.currentStepId = 'task';
    state.noWaitNudged = session;
    manager['active'].set(id, state);
    runInternals(manager).turnNudges.armNoWaitNudgeReplyTimer(id, state);
    await vi.advanceTimersByTimeAsync(300);
    expect(store.getRun(id)?.status).toBe('waiting');
    expect(store.getRun(id)?.waits).toMatchObject([{ kind: 'human', via: 'no-wait', source: 'cezar', phase: 'open', askSeq: expect.any(Number) }]);
    expect(store.readEvents(id).filter(e => e.type === 'note' && e.message === NO_WAIT_NO_REPLY_NOTE)).toHaveLength(1);
  });

  // hearsay-tools/cezarion#1301: an unanswered completion refusal nudge says so, not "no-wait".
  it('expiry after a completion nudge names the completion nudge', async () => {
    vi.useFakeTimers();
    state.currentStepId = 'task';
    state.completionNudged = session;
    manager['active'].set(id, state);
    runInternals(manager).turnNudges.armNoWaitNudgeReplyTimer(id, state);
    await vi.advanceTimersByTimeAsync(300);
    expect(store.getRun(id)?.status).toBe('waiting');
    const notes = store.readEvents(id).filter(e => e.type === 'note').map(e => e.message);
    expect(notes.filter(message => message === COMPLETION_NO_REPLY_NOTE)).toHaveLength(1);
    expect(notes).not.toContain(NO_WAIT_NO_REPLY_NOTE);
  });

  it('a transport exception fails without retaining a readiness retry', () => {
    pendingBoundary();
    vi.mocked(session.sendAgentMessage).mockImplementation(() => { throw new Error('failed transport'); });
    expect(runInternals(manager).turnNudges.tryAutonomousNudge(id, state, 'task', null)).toBe(false);
    expect(state.agentInputError).toContain('failed transport');
    expect(state.autonomousNudgePending).toBeUndefined();
    expect(state.idleTimer).toBeUndefined();
    manager['handleAgentInputReady'](id, state, session);
    expect(session.sendAgentMessage).toHaveBeenCalledOnce();
  });

});
