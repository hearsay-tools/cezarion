import { logPrefix } from '../../home/display.ts';
import { testHome } from '../../home/test-home.testkit.ts';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUN_STATUS, STEP_STATUS, STEP_KIND, WAIT_VIA, makeTimerWait } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { AgentInput } from '@open-mercato/cezar-contract/delegation';
import { RunStore } from '../../runs/store.ts';
import { setRunStatus } from '../../runs/run-store.testkit.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import { createFixtureManager, drainFixtureManagers, fixtureWork } from '../fixture-no-runner.testkit.ts';
import type { RunManager } from '../run.ts';
import { COMPLETION_NUDGE_NOTE } from '../turn-end.ts';
import { COMPLETION_WILL_WAIT, MAX_AUTO_CONTINUES } from './constants.ts';
import { QUICK_TASK_WORKFLOW } from '../types.ts';
import { observationClock } from '../../core/observation-clock.testkit.ts';
import { completionRefusalQueueDecision } from './turn-nudges.ts';

describe('completionRefusalQueueDecision', () => {
  it.each([
    { held: true, owed: true, spent: 40, decision: 'held', trace: ['held'] },
    { held: false, owed: true, spent: 40, decision: 'owed', trace: ['held', 'owed'] },
    { held: false, owed: false, spent: 40, decision: 'budget', trace: ['held', 'owed', 'count'] },
    { held: false, owed: false, spent: 41, decision: 'budget', trace: ['held', 'owed', 'count'] },
    { held: false, owed: false, spent: 39, decision: 'enqueue', trace: ['held', 'owed', 'count'] },
  ])('returns $decision with lazy ordered reads: $held/$owed/$spent', row => {
    const trace: string[] = [];
    const read = (name: string, value: boolean | number, id: string) => { expect(id).toBe('run'); trace.push(name); return value; };
    const decision = completionRefusalQueueDecision('run', {
      holdsAgentWaits: id => !!read('held', row.held, id),
      owesCompletionRefusal: id => !!read('owed', row.owed, id),
      countAutomaticWakes: id => Number(read('count', row.spent, id)),
    }, 40);
    expect(decision).toBe(row.decision);
    expect(trace).toEqual(row.trace);
  });
});

describe('closed-session refusal effects through public recovery', () => {
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let id: string;
  let workerId: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-refusal-decision-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    const parent = store.createRun({ title: 'legacy parent', task: 'history', workflow: 'quick-task',
      workflowDef: QUICK_TASK_WORKFLOW, runner: 'claude', steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] });
    id = parent.id;
    store.updateStep(id, 'task', { status: STEP_STATUS.waiting, sessionId: 'previous-session', backend: 'claude' });
    setRunStatus(store, id, RUN_STATUS.waiting, { automaticWakes: 7, delegation: { role: 'root', permissions: [], receipts: [] } });
    workerId = randomUUID();
    store.createOwnedRun({ title: 'live worker', task: 'history', workflow: 'quick-task', steps: [] }, id, randomUUID(), {
      role: 'worker', parentRunId: id, permissions: [], workspace: { ownerRunId: workerId, resourceId: randomUUID(),
        kind: 'owned-isolated', path: join(root, 'worker'), branch: `cez/${workerId.slice(0, 8)}`, baselineSha: '0'.repeat(40) },
    }, 'a'.repeat(64));
    store.commitRootFinishIntent(id);
    // Recovery must reach the gate, while owned capacity prevents later continuation launches.
    const semaphore = new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 0 }, load: async () => ({ maxParallel: 0, memoryLimitMb: null }) });
    manager = createFixtureManager(store, root, { home: testHome(), semaphore });
    vi.stubEnv('CEZ_AUTONAME', '0');
  });
  afterEach(async () => {
    manager.dispose();
    await drainFixtureManagers(root);
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    store.close(); rmSync(root, { recursive: true, force: true });
  });

  function refusalInput(): AgentInput {
    return { id: randomUUID(), parentRunId: id, source: 'lifecycle', purpose: 'completion-refusal',
      text: `Workers are still live: ${workerId}. ${COMPLETION_WILL_WAIT}`, createdAt: new Date().toISOString() };
  }

  function observeGate(expected: string[], beforeEvent?: (event: Parameters<RunStore['appendEvent']>[1]) => void) {
    const trace: string[] = [];
    let inGate = false;
    let checked = false;
    const append = store.appendEvent.bind(store), move = store.move.bind(store), flush = store.flush.bind(store);
    vi.spyOn(store, 'appendEvent').mockImplementation((runId, event) => {
      if (runId === id && event.type === 'note' && String(event.message).startsWith('Completion blocked:')) {
        inGate = true; trace.push('warning');
      } else if (runId === id && inGate) {
        beforeEvent?.(event);
        trace.push(`event:${event.type}`);
      }
      return append(runId, event);
    });
    vi.spyOn(store, 'move').mockImplementation((...args) => {
      if (args[0] === id && inGate) trace.push(args[1]);
      return move(...args);
    });
    vi.spyOn(store, 'flush').mockImplementation(() => { if (inGate) trace.push('flush'); return flush(); });
    // The gate is synchronous. Recovery next enumerates runs after its live-run loop,
    // before rearmRecoveredWakes. Check the complete trace at that owned store boundary.
    const list = store.listRuns.bind(store);
    vi.spyOn(store, 'listRuns').mockImplementation((...args) => {
      if (inGate) {
        expect(trace).toEqual(expected);
        checked = true;
        inGate = false;
      }
      return list(...args);
    });
    const retry = observationClock(delay => {
      if (delay !== 1000 || !/\bat WakeRetries\.retryWaitAdmission \(/.test(new Error().stack ?? '')) return false;
      if (inGate) trace.push('retry');
      return true;
    });
    return { trace, retry, inGate: () => inGate, checked: () => checked };
  }

  it('keeps the exact owed input and charge through the gate, then rearms its wake', async () => {
    const input = refusalInput();
    store.commitAgentInputs(id, [input]);
    const expected = ['warning', 'park', 'flush'];
    const gate = observeGate(expected);
    const outcome = vi.spyOn(store, 'commitOutcome');
    const wait = vi.spyOn(store, 'commitWait');
    const inputs = vi.spyOn(store, 'commitAgentInputs');
    await manager.recover(id);
    expect(gate.checked()).toBe(true);
    expect(gate.trace).toEqual(expected);
    expect(gate.retry.captured).toBe(1);
    expect(gate.retry.pending).toBe(1);
    expect(store.getRun(id)?.agentInputs).toEqual([input]);
    expect(store.getRun(id)?.automaticWakes).toBe(7);
    expect(store.getRun(id)?.delegation).not.toHaveProperty('finishRequestedAt');
    expect(fixtureWork(manager).liveSessions.size).toBe(0);
    expect(outcome.mock.calls.filter(([runId]) => runId === id)).toEqual([]);
    expect(wait.mock.calls.filter(([runId]) => runId === id)).toEqual([]);
    expect(inputs.mock.calls.filter(([runId]) => runId === id)).toEqual([]);
    expect(store.readEvents(id).filter(event => event.type === 'agent-input' || String(event.message).startsWith(COMPLETION_NUDGE_NOTE))).toEqual([]);
  });

  it('commits the budget alias before surfacing its note, with no refusal charge', async () => {
    store.updateRun(id, { automaticWakes: MAX_AUTO_CONTINUES });
    const expected = ['warning', 'park', 'flush', 'alias', 'event:note', 'surfaced'];
    let aliasId: string | undefined;
    const gate = observeGate(expected, event => {
      if (event.type !== 'note' || !String(event.message).includes('automatic-wake budget spent')) return;
      expect(aliasId).toBeDefined();
      expect(store.getRun(id)?.waits).toEqual([expect.objectContaining({ id: aliasId, via: WAIT_VIA.budget })]);
      expect(gate.trace).toEqual(['warning', 'park', 'flush', 'alias']);
    });
    const commit = store.commitWait.bind(store);
    vi.spyOn(store, 'commitWait').mockImplementation((...args) => {
      if (args[0] === id && gate.inGate()) {
        if (args[1].kind !== 'human' || args[1].askSeq === undefined) {
          expect(gate.trace).toEqual(['warning', 'park', 'flush']);
          gate.trace.push('alias');
          aliasId = args[1].id;
        } else {
          expect(gate.trace).toEqual(['warning', 'park', 'flush', 'alias', 'event:note']);
          expect(args[1].id).toBe(aliasId);
          expect(args[1].askSeq).toBe(store.readEvents(id).at(-1)?.seq);
          gate.trace.push('surfaced');
        }
      }
      return commit(...args);
    });
    const outcome = vi.spyOn(store, 'commitOutcome');
    await manager.recover(id);
    expect(gate.checked()).toBe(true);
    expect(gate.trace).toEqual(expected);
    expect(gate.retry.captured).toBe(0);
    expect(store.getRun(id)?.agentInputs ?? []).toEqual([]);
    expect(store.getRun(id)?.automaticWakes).toBe(MAX_AUTO_CONTINUES);
    expect(store.getRun(id)?.waits).toEqual([expect.objectContaining({ id: aliasId, askSeq: expect.any(Number) })]);
    expect(outcome.mock.calls.filter(([runId]) => runId === id)).toEqual([]);
    expect(store.readEvents(id).filter(event => String(event.message).includes('automatic-wake budget spent'))).toHaveLength(1);
  });

  it.each([false, true])('enqueues with an atomic charge, persistence failure=%s', async failure => {
    const expected = failure ? ['warning', 'park', 'flush', 'charge']
      : ['warning', 'park', 'flush', 'charge', 'event:agent-input', 'event:note'];
    const gate = observeGate(expected);
    const commit = store.commitOutcome.bind(store);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(store, 'commitOutcome').mockImplementation((...args) => {
      if (args[0] !== id || !gate.inGate()) return commit(...args);
      expect(gate.trace).toEqual(['warning', 'park', 'flush']);
      gate.trace.push('charge');
      expect(args[1]).toEqual({ kind: 'charged', automaticWakes: 8 });
      expect(args[2]?.enqueue).toEqual([expect.objectContaining({ purpose: 'completion-refusal', parentRunId: id })]);
      if (failure) throw Error('owned outcome checkpoint failure');
      const committed = commit(...args);
      expect(store.getRun(id)?.agentInputs).toEqual(args[2]?.enqueue);
      expect(store.getRun(id)?.automaticWakes).toBe(8);
      return committed;
    });
    await manager.recover(id);
    expect(gate.checked()).toBe(true);
    expect(gate.trace).toEqual(expected);
    expect(gate.retry.captured).toBe(failure ? 0 : 1);
    if (failure) {
      expect(gate.trace).toEqual(['warning', 'park', 'flush', 'charge']);
      expect(store.getRun(id)?.agentInputs ?? []).toEqual([]);
      expect(store.getRun(id)?.automaticWakes).toBe(7);
      expect(console.warn).toHaveBeenCalledWith(`${logPrefix()} completion refusal not queued: owned outcome checkpoint failure`);
    } else {
      expect(store.getRun(id)?.agentInputs).toEqual([expect.objectContaining({ text: expect.stringContaining(`Workers are still live: ${workerId}.`), purpose: 'completion-refusal' })]);
      expect(store.getRun(id)?.automaticWakes).toBe(8);
      expect(store.getRun(id)?.agentInputs?.[0]?.text.endsWith(COMPLETION_WILL_WAIT)).toBe(true);
    }
  });

  it('keeps an agent wait ahead of an owed refusal without a new charge or wake', async () => {
    const input = refusalInput();
    store.commitAgentInputs(id, [input]);
    store.commitWait(id, makeTimerWait({ deadline: new Date(Date.now() + 60_000).toISOString() }));
    const expected = ['warning', 'park', 'flush'];
    const gate = observeGate(expected);
    const outcome = vi.spyOn(store, 'commitOutcome');
    const wait = vi.spyOn(store, 'commitWait');
    const inputs = vi.spyOn(store, 'commitAgentInputs');
    await manager.recover(id);
    expect(gate.checked()).toBe(true);
    expect(gate.trace).toEqual(expected);
    expect(gate.retry.captured).toBe(1);
    expect(gate.retry.pending).toBe(1);
    expect(outcome.mock.calls.filter(([runId]) => runId === id)).toEqual([]);
    expect(wait.mock.calls.filter(([runId]) => runId === id)).toEqual([]);
    expect(inputs.mock.calls.filter(([runId]) => runId === id)).toEqual([]);
    expect(store.getRun(id)?.agentInputs).toEqual([input]);
    expect(store.getRun(id)?.automaticWakes).toBe(7);
  });
});
