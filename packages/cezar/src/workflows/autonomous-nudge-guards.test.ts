import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { AUTONOMOUS_NUDGE, RunManager } from './run.ts';

// Focused policy guards complement workflow-autonomous-parity's actual native
// wires. A refused nudge must never touch either transport or consume its budget.
type State = Parameters<RunManager['tryAutonomousNudge']>[1];
const ask = { questions: [{ header: 'Choice', question: 'Which framework?', options: [{ label: 'Vitest' }, { label: 'Node' }] }] };
const guards = ['disabled', 'cancelled', 'finish', 'disposed', 'stopping', 'input-error', 'native-ask', 'persisted-ask',
  'closed', 'queued-input', 'unread-input', 'input-flight', 'worker-wait', 'ci-wait', 'worker-wake', 'root-finish'] as const;

describe('autonomous nudge priority and lifecycle guards', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let id: string;
  let state: State;
  let session: AgentSession;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-autonomous-guards-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    id = store.createRun({ title: 'guard', task: 'work', workflow: 'quick-task', autonomous: true, steps: [{ id: 'task', name: 'Task', kind: 'agent' }] }).id;
    store.updateRun(id, { status: 'running' });
    manager = new RunManager(store, root);
    session = {
      open: true, result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
      sendMessage: vi.fn(() => true), sendAgentMessage: vi.fn(() => Promise.resolve()),
      end: vi.fn(), interrupt: vi.fn(), discardQueuedMessages: vi.fn(), holdsHumanInput: () => false,
    };
    state = { cwd: root, cancelled: false, interrupt: () => {}, pendingHumanAsk: false, autonomous: true, autoContinues: 0, session };
  });
  afterEach(() => { manager['clearIdleTimer'](state); manager.dispose(); vi.useRealTimers(); store.flush(); rmSync(root, { recursive: true, force: true }); });

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
      case 'worker-wait': store.commitDelegation([{ id, delegation: { role: 'root', permissions: ['wait'], receipts: [], wait: {
        id: randomUUID(), workerIds: [randomUUID()], deadline: new Date(Date.now() + 60_000).toISOString(), phase: 'registered', outcomes: [],
      } } }]); break;
      case 'ci-wait': store.commitCiWait(id, {
        id: randomUUID(), prUrl: 'https://github.com/acme/repo/pull/1', repository: 'acme/repo', prNumber: 1, headSha: 'a'.repeat(40),
        generation: 'generation', turnId: 'turn', timeoutSeconds: 60, registeredAt: new Date().toISOString(), deadline: new Date(Date.now() + 60_000).toISOString(), phase: 'registered',
      }); break;
      case 'worker-wake': manager['workerWakeAdmitted'].add(id); break;
      case 'root-finish': store.commitDelegation([{ id, delegation: { role: 'root', permissions: [], receipts: [], finishRequestedAt: new Date().toISOString() } }]); break;
    }
  }

  for (const portable of [false, true]) it.each(guards)('%s blocks the nudge (portable ASK=' + portable + ')', guard => {
    applyGuard(guard);
    expect(manager['tryAutonomousNudge'](id, state, 'task', portable ? ask : null)).toBe(false);
    expect(session.sendMessage).not.toHaveBeenCalled();
    expect(session.sendAgentMessage).not.toHaveBeenCalled();
    expect(state.autoContinues).toBe(0);
    expect(store.readEvents(id).some(e => e.type === 'note' && String(e.message).includes('autonomous'))).toBe(false);
  });

  it('a refused portable override leaves the question and budget untouched', () => {
    vi.mocked(session.sendMessage).mockReturnValue(false);
    expect(manager['tryAutonomousNudge'](id, state, 'task', ask)).toBe(false);
    expect(state.autoContinues).toBe(0);
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
    expect(state.autoContinues).toBe(0);
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
      expect(state.autoContinues).toBe(0);
    },
  );

  it('refused ordinary input waits for readiness without charging the cap or releasing capacity', () => {
    pendingBoundary();
    vi.mocked(session.sendAgentMessage).mockReturnValueOnce(false);
    expect(manager['tryAutonomousNudge'](id, state, 'task', null)).toBe(false);
    expect(state.autonomousNudgePending).toBe(session);
    expect(state.idleTimer).toBeDefined();
    expect(state.autoContinues).toBe(0);
    expect(store.getRun(id)?.status).toBe('running');
    expect(manager['waiting'].has(id)).toBe(false);
    manager['handleAgentInputReady'](id, state, session);
    expect(session.sendAgentMessage).toHaveBeenLastCalledWith([{ type: 'text', text: AUTONOMOUS_NUDGE }], []);
    expect(state.autonomousNudgePending).toBeUndefined();
    expect(state.idleTimer).toBeUndefined();
    expect(state.autoContinues).toBe(1);
    expect(session.sendMessage).not.toHaveBeenCalled();
  });

  it('missing readiness reaches the existing idle close bound', () => {
    vi.useFakeTimers();
    pendingBoundary();
    vi.mocked(session.sendAgentMessage).mockReturnValue(false);
    expect(manager['tryAutonomousNudge'](id, state, 'task', null)).toBe(false);
    vi.runOnlyPendingTimers();
    expect(session.end).toHaveBeenCalledOnce();
    expect(state.idleClosed).toBe(true);
    manager['handleAgentInputReady'](id, state, session);
    expect(session.sendAgentMessage).toHaveBeenCalledOnce();
    expect(state.autoContinues).toBe(0);
  });

  it('parent activity invalidates the refused boundary and its timer', () => {
    pendingBoundary();
    vi.mocked(session.sendAgentMessage).mockReturnValue(false);
    manager['tryAutonomousNudge'](id, state, 'task', null);
    manager['handleRunnerUiEvent'](id, state, manager['makeUiSink'](id, 'task'), { type: 'turn.started', turnId: randomUUID() });
    expect(state.autonomousNudgePending).toBeUndefined();
    expect(state.atTurnBoundary).toBeUndefined();
    expect(state.idleTimer).toBeUndefined();
    manager['handleAgentInputReady'](id, state, session);
    expect(session.sendAgentMessage).toHaveBeenCalledOnce();
  });

  it('a pending autonomous retry is not replaced by the final-message nudge', () => {
    pendingBoundary();
    expect(manager['maybeFinalMessageNudge'](id, state, 'task', {
      ask: false, humanGate: false, monitoring: false, silentTail: true, alreadyNudged: false,
    })).toBe(false);
    expect(session.sendAgentMessage).not.toHaveBeenCalled();
    expect(session.sendMessage).not.toHaveBeenCalled();
    expect(store.readEvents(id).some(e => e.type === 'note' && String(e.message).includes('no final message'))).toBe(false);
  });

  it('nested subagent items do not clear the final-message nudge reply bound', () => {
    state.finalMessageNudged = session;
    manager['active'].set(id, state);
    manager['armFinalMessageNudgeReplyTimer'](id, state);
    expect(state.finalMessageNudgeReplyTimer).toBeDefined();
    manager['noteFinalMessageNudgeContent'](id, state, {
      type: 'item.started',
      item: { parentItemId: 'parent' },
    });
    expect(state.finalMessageNudgeReplyTimer).toBeDefined();
    manager['noteFinalMessageNudgeContent'](id, state, { type: 'item.delta' });
    expect(state.finalMessageNudgeReplyTimer).toBeDefined();
    manager['noteFinalMessageNudgeContent'](id, state, {
      type: 'item.started',
      item: {},
    });
    expect(state.finalMessageNudgeReplyTimer).toBeUndefined();
  });

  it('text before the reply timer is armed still prevents parking', () => {
    state.finalMessageNudged = session;
    manager['active'].set(id, state);
    manager['noteFinalMessageNudgeContent'](id, state, { type: 'text' });
    manager['armFinalMessageNudgeReplyTimer'](id, state);
    expect(state.finalMessageNudgeReplyTimer).toBeUndefined();
  });

  it('turn.started before the reply timer is armed does not count as a nudge reply', () => {
    state.finalMessageNudged = session;
    manager['active'].set(id, state);
    manager['noteFinalMessageNudgeContent'](id, state, { type: 'turn.started' });
    manager['armFinalMessageNudgeReplyTimer'](id, state);
    expect(state.finalMessageNudgeReplyTimer).toBeDefined();
    manager['noteFinalMessageNudgeContent'](id, state, { type: 'turn.started' });
    expect(state.finalMessageNudgeReplyTimer).toBeUndefined();
  });

  it('user-authored delivery resets the final-message nudge latch', () => {
    state.finalMessageNudged = session;
    manager['active'].set(id, state);
    expect(manager['deliverMessage'](id, [{ type: 'text', text: 'please continue' }], true)).toBe(true);
    expect(state.finalMessageNudged).toBeUndefined();
  });

  it('expiry parks without resetting the final-message nudge latch', async () => {
    vi.useFakeTimers();
    state.finalMessageNudged = session;
    manager['active'].set(id, state);
    (manager as unknown as { finalMessageNudgeReplyMs: number }).finalMessageNudgeReplyMs = 300;
    manager['armFinalMessageNudgeReplyTimer'](id, state);
    await vi.advanceTimersByTimeAsync(300);
    expect(state.finalMessageNudged).toBe(session);
    expect(state.finalMessageNudgeParked).toBe(session);
    expect(store.getRun(id)?.status).toBe('waiting');
  });

  it('a transport exception fails without retaining a readiness retry', () => {
    pendingBoundary();
    vi.mocked(session.sendAgentMessage).mockImplementation(() => { throw new Error('failed transport'); });
    expect(manager['tryAutonomousNudge'](id, state, 'task', null)).toBe(false);
    expect(state.agentInputError).toContain('failed transport');
    expect(state.autonomousNudgePending).toBeUndefined();
    expect(state.idleTimer).toBeUndefined();
    manager['handleAgentInputReady'](id, state, session);
    expect(session.sendAgentMessage).toHaveBeenCalledOnce();
  });

});
