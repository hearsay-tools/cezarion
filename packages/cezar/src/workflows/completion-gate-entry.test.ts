import { runInternals } from './run-internals.testkit.ts';
import { clearIdleTimer } from './run/input-timers.ts';
import type { ActiveRun } from './active-run.ts';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../core/agent-runner.ts';
import { handoffPath, seedHandoffFile } from '../handoff.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { watchTurnOutcomes } from './turn-outcomes.testkit.ts';

// The completion gate's refusal of a live session's done outside a turn end (`settleTurn`'s `gate`
// entry, hearsay-tools/cezarion#1525). Mid-turn, the live turn end decides the refusal; at the
// boundary, owed input runs first, as at a turn end. Also the turn end's monitoring alias beside
// an ask line.
type State = ActiveRun;
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
    runInternals(manager).active.set(id, state);
    vi.spyOn(runInternals(manager).runFinish, 'completionGate').mockReturnValue(refusal);
  });
  afterEach(() => { clearIdleTimer(state); manager.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); });

  describe('the real root gate', () => {
    beforeEach(() => {
      vi.mocked(runInternals(manager).runFinish.completionGate).mockRestore();
      store.commitDelegation([{ id, delegation: { role: 'root', permissions: ['wait'], receipts: [] } }]);
    });

    it.each(['done', 'review', 'failed', 'cancelled'] as const)('holds a stopped root at %s without reopening it', status => {
      store.updateRun(id, { status });
      const queue = vi.spyOn(runInternals(manager).turnNudges, 'queueCompletionRefusal');
      expect(runInternals(manager).runFinish.completionGate(id)).toBe('held');
      expect(store.getRun(id)?.status).toBe(status);
      expect(queue).not.toHaveBeenCalled();
    });

    it('retires a legacy Finish intent before refusing a live session', () => {
      store.commitDelegation([{ id, delegation: { role: 'root', permissions: ['wait'], receipts: [], finishRequestedAt: new Date().toISOString() } }]);
      vi.spyOn(manager, 'parentCompletionBlockers' as never);
      vi.mocked(manager['parentCompletionBlockers']).mockReturnValue([{ workerId, reason: 'outstanding' }]);
      expect(runInternals(manager).runFinish.completionGate(id)).toMatchObject({ code: 'workers_outstanding' });
      expect(store.getRun(id)?.delegation).not.toHaveProperty('finishRequestedAt');
    });

    it('queues a refusal for a closed session', () => {
      Object.assign(session, { open: false });
      vi.spyOn(manager, 'parentCompletionBlockers' as never);
      vi.mocked(manager['parentCompletionBlockers']).mockReturnValue([{ workerId, reason: 'outstanding' }]);
      const queue = vi.spyOn(runInternals(manager).turnNudges, 'queueCompletionRefusal').mockImplementation(() => true);
      expect(runInternals(manager).runFinish.completionGate(id)).toBe('held');
      expect(queue).toHaveBeenCalledWith(id, expect.objectContaining({ code: 'workers_outstanding' }));
    });

    it('parks a root with a human question and releases its slot after the step waits', () => {
      state.pendingHumanAsk = true;
      state.idleTimer = setTimeout(() => {}, 60_000);
      const release = vi.spyOn(runInternals(manager).line, 'releaseSlot').mockImplementation(() => {
        expect(store.getRun(id)?.status).toBe('waiting');
        expect(store.getRun(id)?.steps[0]?.status).toBe('waiting');
        expect(state.idleTimer).toBeUndefined();
        expect(runInternals(manager).line.waiting.has(id)).toBe(true);
      });
      expect(runInternals(manager).runFinish.completionGate(id)).toBe('held');
      expect(release).toHaveBeenCalledOnce();
      expect(store.readEvents(id)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'note', message: 'Completion blocked: answer the pending human question.' })]));
    });
  });

  const queueInput = () => store.commitAgentInputs(id, [{ id: randomUUID(), source: 'agent', parentRunId: randomUUID(), text: 'Read this first', createdAt: new Date().toISOString() }]);
  const openWorkerWait = () => store.commitWait(id, { kind: 'worker', id: randomUUID(), source: 'agent', via: 'cezar_wait', registeredAt: new Date().toISOString(),
    deadline: new Date(Date.now() + 60_000).toISOString(), timeoutSeconds: 60, phase: 'open', turnId: 'turn', mode: 'all',
    workerIds: [workerId], revisions: [], outcomes: [] });
  const sent = () => vi.mocked(session.sendMessage).mock.calls.length + vi.mocked(session.sendAgentMessage).mock.calls.length;

  it.each([['queued input', queueInput], ['an open agent wait', openWorkerWait]])('mid-turn, %s leaves the refusal to the live turn end', (_name, setup) => {
    setup();
    expect(runInternals(manager).runFinish.deferParentCompletion(id)).toBe(true);
    expect(runInternals(manager).runFinish.completionGate).toHaveBeenCalled();
    expect(store.getRun(id)?.status).toBe('running');
    expect(runInternals(manager).line.waiting.has(id)).toBe(false);
    expect(sent()).toBe(0);
  });

  it('at the boundary, queued input runs before the run parks', () => {
    state.atTurnBoundary = session;
    queueInput();
    expect(runInternals(manager).runFinish.deferParentCompletion(id)).toBe(true);
    expect(runInternals(manager).runFinish.completionGate).toHaveBeenCalled();
    expect(sent()).toBe(1);
    expect(store.getRun(id)?.status).toBe('running');
    expect(runInternals(manager).line.waiting.has(id)).toBe(false);
  });

  it('at the boundary, an open agent wait parks the run', () => {
    state.atTurnBoundary = session;
    openWorkerWait();
    expect(runInternals(manager).runFinish.deferParentCompletion(id)).toBe(true);
    expect(runInternals(manager).runFinish.completionGate).toHaveBeenCalled();
    expect(store.getRun(id)?.status).toBe('waiting');
    expect(sent()).toBe(0);
  });

  // A run an earlier entry already parked keeps that park: a second one would free its slot twice.
  it('at the boundary, a second refusal keeps the park the first one made and frees no second slot', () => {
    state.atTurnBoundary = session;
    openWorkerWait();
    const release = vi.spyOn(runInternals(manager).line, 'releaseSlot');
    expect(runInternals(manager).runFinish.deferParentCompletion(id)).toBe(true);
    expect(runInternals(manager).runFinish.completionGate).toHaveBeenCalled();
    expect(runInternals(manager).runFinish.deferParentCompletion(id)).toBe(true);
    expect(runInternals(manager).runFinish.completionGate).toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(store.getRun(id)?.status).toBe('waiting');
  });

  // The gate held the done itself (a stopped root, or a question that parked for the user): a turn
  // end keeps the done at the boundary and settles the park; an acknowledgement settles the park
  // only. Neither writes to the handoff file (hearsay-tools/cezarion#1809).
  describe('a done the gate holds', () => {
    let seeded: string;
    const handoff = () => readFileSync(handoffPath(join(root, '.ai/cezar'), id), 'utf8');
    const turnEnd = () => runInternals(manager).turnSettler.settleTurn(id, state, 'turn-end', { stepId: 'task', monitoring: false, humanGate: false,
      ask: null, done: true, nudgedLastTurn: false });
    const ack = () => runInternals(manager).turnSettler.settleTurn(id, state, 'ack', runInternals(manager).turnSettler.boundaryTurn(id, state, session, true));
    beforeEach(() => {
      vi.mocked(runInternals(manager).runFinish.completionGate).mockReturnValue('held');
      seedHandoffFile(join(root, '.ai/cezar'), store.getRun(id)!);
      seeded = handoff();
      state.atTurnBoundary = session;
      state.heldHumanInputSince = Date.now();
    });
    afterEach(() => expect(handoff()).toBe(seeded));

    it('a turn end and an acknowledgement write nothing to the handoff file', () => {
      expect(turnEnd()).toBe(true);
      expect(runInternals(manager).runFinish.completionGate).toHaveBeenCalled();
      expect(ack()).toBe(true);
      expect(handoff()).toBe(seeded);
    });

    it('a turn end keeps the done at the boundary, resets the held-input clock and settles the park', () => {
      const turns = watchTurnOutcomes();
      expect(turnEnd()).toBe(true);
      expect(runInternals(manager).runFinish.completionGate).toHaveBeenCalled();
      expect(state.doneAtBoundary).toBe(session);
      expect(state.doneClose).toEqual({ via: 'cezar_done' });
      expect(state.heldHumanInputSince).toBeUndefined();
      expect(turns.words(id)).toEqual(['waiting']);
    });

    it('a turn end whose input checkpoint failed settles nothing', () => {
      const turns = watchTurnOutcomes();
      state.agentInputError = 'agent input delivery checkpoint failed';
      expect(turnEnd()).toBe(false);
      expect(state.doneAtBoundary).toBe(session);
      expect(turns.words(id)).toEqual([]);
    });

    it('an acknowledgement settles the park and leaves the boundary and the held-input clock as they were', () => {
      const turns = watchTurnOutcomes();
      state.doneAtBoundary = session;
      expect(ack()).toBe(true);
      expect(state.doneAtBoundary).toBe(session);
      expect(state.heldHumanInputSince).toBeDefined();
      expect(turns.words(id)).toEqual(['waiting']);
    });
  });
});
