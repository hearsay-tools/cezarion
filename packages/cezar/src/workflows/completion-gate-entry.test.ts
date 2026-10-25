import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../core/agent-runner.ts';
import { handoffPath, seedHandoffFile } from '../handoff.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';

// The completion gate's refusal of a live session's done outside a turn end (`settleTurn`'s `gate`
// entry, hearsay-tools/cezarion#1525). Mid-turn, the live turn end decides the refusal; at the
// boundary, owed input runs first, as at a turn end. Also the turn end's monitoring alias beside
// an ask line.
type State = Parameters<RunManager['tryAutonomousNudge']>[1];
const workerId = randomUUID();
const refusal = { code: 'workers_outstanding' as const, message: `Workers are still live: ${workerId}.`,
  workers: [{ worker_id: workerId, reason: 'outstanding' as const }], liveWorkerIds: [workerId] };

describe('the completion gate outside a turn end', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let id: string;
  let state: State;
  let session: AgentSession;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-gate-entry-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    id = store.createRun({ title: 'gate', task: 'work', workflow: 'quick-task', steps: [{ id: 'task', name: 'Task', kind: 'agent' }] }).id;
    store.updateRun(id, { status: 'running', currentStepId: 'task' });
    store.updateStep(id, 'task', { status: 'running' });
    await store.factsWarmIdle();
    manager = new RunManager(store, root);
    session = {
      open: true, result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
      sendMessage: vi.fn(() => true), sendAgentMessage: vi.fn(() => Promise.resolve()),
      end: vi.fn(), interrupt: vi.fn(), discardQueuedMessages: vi.fn(), holdsHumanInput: () => false,
    };
    state = { cwd: root, cancelled: false, interrupt: () => {}, pendingHumanAsk: false, session, currentStepId: 'task' };
    manager['active'].set(id, state);
    vi.spyOn(manager as unknown as { completionGate: () => unknown }, 'completionGate').mockReturnValue(refusal);
  });
  afterEach(() => { manager['clearIdleTimer'](state); manager.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); });

  const queueInput = () => store.commitAgentInputs(id, [{ id: randomUUID(), source: 'agent', parentRunId: randomUUID(), text: 'Read this first', createdAt: new Date().toISOString() }]);
  const openWorkerWait = () => store.commitWait(id, { kind: 'worker', id: randomUUID(), source: 'agent', via: 'cezar_wait', registeredAt: new Date().toISOString(),
    deadline: new Date(Date.now() + 60_000).toISOString(), timeoutSeconds: 60, phase: 'open', turnId: 'turn', mode: 'all',
    workerIds: [workerId], revisions: [], outcomes: [] });
  const sent = () => vi.mocked(session.sendMessage).mock.calls.length + vi.mocked(session.sendAgentMessage).mock.calls.length;

  it.each([['queued input', queueInput], ['an open agent wait', openWorkerWait]])('mid-turn, %s leaves the refusal to the live turn end', (_name, setup) => {
    setup();
    expect(manager['deferParentCompletion'](id)).toBe(true);
    expect(store.getRun(id)?.status).toBe('running');
    expect(manager['waiting'].has(id)).toBe(false);
    expect(sent()).toBe(0);
  });

  it('at the boundary, queued input runs before the run parks', () => {
    state.atTurnBoundary = session;
    queueInput();
    expect(manager['deferParentCompletion'](id)).toBe(true);
    expect(sent()).toBe(1);
    expect(store.getRun(id)?.status).toBe('running');
    expect(manager['waiting'].has(id)).toBe(false);
  });

  it('at the boundary, an open agent wait parks the run', () => {
    state.atTurnBoundary = session;
    openWorkerWait();
    expect(manager['deferParentCompletion'](id)).toBe(true);
    expect(store.getRun(id)?.status).toBe('waiting');
    expect(sent()).toBe(0);
  });

  // A turn end with an ask line skips owed input; its monitoring line still opens the timer alias,
  // as on main's `applyTurnEnd` (hearsay-tools/cezarion#1525 review).
  it('a turn end with an ask line and a monitoring line opens the timer alias', () => {
    state.atTurnBoundary = session;
    const ask = { questions: [{ header: 'Choice', question: 'Which framework?', options: [{ label: 'Vitest' }, { label: 'Node' }] }] };
    manager['settleTurn'](id, state, 'turn-end', { stepId: 'task', monitoring: true, humanGate: false, ask,
      askNudged: false, done: false, nudgedLastTurn: false });
    expect(store.getRun(id)?.waits?.some(wait => wait.kind === 'timer')).toBe(true);
    expect(store.getRun(id)?.status).toBe('waiting');
  });

  // A run an earlier entry already parked keeps that park: a second one would free its slot twice.
  it('at the boundary, a second refusal keeps the park the first one made and frees no second slot', () => {
    state.atTurnBoundary = session;
    openWorkerWait();
    const release = vi.spyOn(manager as unknown as { releaseSlot: () => void }, 'releaseSlot');
    expect(manager['deferParentCompletion'](id)).toBe(true);
    expect(manager['deferParentCompletion'](id)).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    expect(store.getRun(id)?.status).toBe('waiting');
  });

  // The gate held the done itself (a stopped root, or a question that parked for the user): a turn
  // end keeps the done at the boundary and writes the park line; an acknowledgement writes the line
  // only.
  describe('a done the gate holds', () => {
    const lines = () => readFileSync(handoffPath(join(root, '.ai/cezar'), id), 'utf8').match(/status=\S+/g) ?? [];
    const turnEnd = () => manager['settleTurn'](id, state, 'turn-end', { stepId: 'task', monitoring: false, humanGate: false,
      ask: null, askNudged: false, done: true, nudgedLastTurn: false });
    beforeEach(() => {
      vi.mocked(manager['completionGate']).mockReturnValue('held');
      seedHandoffFile(join(root, '.ai/cezar'), store.getRun(id)!);
      state.atTurnBoundary = session;
      state.heldHumanInputSince = Date.now();
    });

    it('a turn end keeps the done at the boundary, resets the held-input clock and writes the park line', () => {
      expect(turnEnd()).toBe(true);
      expect(state.doneAtBoundary).toBe(session);
      expect(state.doneClose).toEqual({ via: 'done-line' });
      expect(state.heldHumanInputSince).toBeUndefined();
      expect(lines()).toEqual(['status=waiting']);
    });

    it('a turn end whose input checkpoint failed settles nothing and writes no line', () => {
      state.agentInputError = 'agent input delivery checkpoint failed';
      expect(turnEnd()).toBe(false);
      expect(state.doneAtBoundary).toBe(session);
      expect(lines()).toEqual([]);
    });

    it('an acknowledgement writes the park line and leaves the boundary and the held-input clock as they were', () => {
      state.doneAtBoundary = session;
      expect(manager['settleTurn'](id, state, 'ack', manager['boundaryTurn'](id, state, session, true))).toBe(true);
      expect(state.doneAtBoundary).toBe(session);
      expect(state.heldHumanInputSince).toBeDefined();
      expect(lines()).toEqual(['status=waiting']);
    });
  });
});
