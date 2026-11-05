import { describe, expect, it, vi } from 'vitest';
import { makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunRecord } from '../../runs/store.ts';
import { createActiveRun } from '../active-run.ts';
import { workerExecutionStopped } from './run-guards.ts';
import { staleContinuationDisposition } from './continuation-session.ts';
import { sessionCloseKeepsWaiting, terminalScratchDisposition } from './run-settlement.ts';
import { latchInputFault } from './input-delivery.ts';
import { selectSessionFault } from './session-events.ts';

function root(deleting = false): RunRecord {
  return makeRunRecord({ id: 'parent', delegation: { role: 'root', permissions: [], receipts: [], historyDeletion: deleting ? 'pending' : undefined } });
}

function worker(destroy = false): RunRecord {
  return makeRunRecord({ id: 'child', delegation: { role: 'worker', parentRunId: 'parent', permissions: [],
    destroy: destroy ? { requestedAt: '2026-11-05T00:00:00Z', phase: 'requested', remaining: [] } : undefined,
    workspace: { ownerRunId: 'child', resourceId: 'resource', kind: 'owned-isolated', path: '/work', branch: 'task', baselineSha: 'a'.repeat(40) } } });
}

describe('workerExecutionStopped without an ActiveRun', () => {
  it.each([
    ['deleting root', root(true), undefined, false, true, ['parent', 'parent']],
    ['deleting parent', worker(), root(true), false, true, ['child', 'child', 'parent']],
    ['invalid', makeRunRecord({ id: 'run', delegation: { role: 'invalid' } }), undefined, false, true, ['run', 'run']],
    ['destroying', worker(true), root(), false, true, ['child', 'child', 'parent']],
    ['stopped', worker(), root(), true, true, ['child', 'child', 'parent', 'stopped:child']],
    ['live', worker(), root(), false, false, ['child', 'child', 'parent', 'stopped:child']],
    ['missing parent', worker(), undefined, false, false, ['child', 'child', 'parent', 'stopped:child']],
    ['ordinary', makeRunRecord({ id: 'run' }), root(true), false, false, ['run', 'run']],
    ['absent', undefined, undefined, false, false, ['missing', 'missing']],
  ] as const)('%s preserves ordered store and stop reads', (_name, row, parent, stopped, expected, order) => {
    const calls: string[] = [];
    const id = row?.id ?? 'missing';
    const store = { getRun(key: string) { calls.push(key); return key === id ? row : parent; } };
    expect(workerExecutionStopped(store, id, key => { calls.push(`stopped:${key}`); return stopped; })).toBe(expected);
    expect(calls).toEqual(order);
  });
});

describe('staleContinuationDisposition', () => {
  it.each(['missing', 'replaced', 'cancelled', 'stopped', 'hold'] as const)('%s keeps identity before cancellation and stop reads', mode => {
    const state = createActiveRun({ cwd: '.', pendingHumanAsk: false, autonomous: false });
    const replacement = createActiveRun({ cwd: '.', pendingHumanAsk: false, autonomous: false });
    const revoke = vi.fn();
    replacement.liveSession.installCiRevoker(revoke);
    replacement.liveSession.installDelegationRevoker(revoke);
    if (mode === 'cancelled') state.liveSession.cancel();
    const calls: string[] = [];
    const observed = { ...state, get liveSession() { calls.push('cancelled'); return state.liveSession; } };
    const current = mode === 'missing' ? undefined : mode === 'replaced' ? replacement : observed;
    const stopped = () => { calls.push('stopped'); return mode === 'stopped'; };
    const expected = mode === 'missing' || mode === 'replaced' ? 'replaced' : mode === 'hold' ? 'hold' : 'cancel';
    expect(staleContinuationDisposition(current, observed, stopped)).toBe(expected);
    expect(calls).toEqual(expected === 'replaced' ? [] : mode === 'cancelled' ? ['cancelled'] : ['cancelled', 'stopped']);
    expect(replacement.liveSession.revokeCiTools).toBe(revoke);
    expect(replacement.liveSession.revokeDelegation).toBe(revoke);
    expect(revoke).not.toHaveBeenCalled();
  });
});

describe('sessionCloseKeepsWaiting', () => {
  it.each([true, false])('execution error=%s preserves error-before-step reads', failed => {
    const calls: string[] = [];
    const loop = {
      get runError() { calls.push('error'); return failed ? 'failure' : undefined; },
      get incompleteStepId() { calls.push('step'); return 'unfinished'; },
    };
    const ask = vi.fn(() => true);
    expect(sessionCloseKeepsWaiting({ cancelled: false,
      get incomplete() { return !!loop.runError || !!loop.incompleteStepId; },
      get idleClosed(): boolean { throw new Error('incomplete execution must skip idle'); },
    }, ask)).toBe(false);
    expect(calls).toEqual(failed ? ['error'] : ['error', 'step']);
    expect(ask).not.toHaveBeenCalled();
  });

  it.each([
    [true, false, true, true, false, ['cancelled']],
    [false, true, true, true, false, ['cancelled', 'incomplete']],
    [false, false, true, false, true, ['cancelled', 'incomplete', 'idle']],
    [false, false, false, true, true, ['cancelled', 'incomplete', 'idle', 'ask']],
    [false, false, false, false, false, ['cancelled', 'incomplete', 'idle', 'ask']],
    [false, false, undefined, false, false, ['cancelled', 'incomplete', 'idle', 'ask']],
  ] as const)('cancelled=%s incomplete=%s idle=%s ask=%s', (cancelled, incomplete, idle, ask, expected, order) => {
    const calls: string[] = [];
    expect(sessionCloseKeepsWaiting({
      get cancelled() { calls.push('cancelled'); return cancelled; },
      get incomplete() { calls.push('incomplete'); return incomplete; },
      get idleClosed() { calls.push('idle'); return idle; },
    }, () => { calls.push('ask'); return ask; })).toBe(expected);
    expect(calls).toEqual(order);
  });
});

describe('latchInputFault', () => {
  it.each([
    [false, undefined, undefined, false, ['current']],
    [true, 'provider', undefined, false, ['current', 'session']],
    [true, undefined, 'input', false, ['current', 'session', 'input']],
    [true, undefined, undefined, true, ['current', 'session', 'input']],
    [true, '', 'input', false, ['current', 'session', 'input']],
    [true, '', '', true, ['current', 'session', 'input']],
  ] as const)('current=%s session=%s input=%s', (current, session, input, expected, order) => {
    const calls: string[] = [];
    expect(latchInputFault({
      current: () => { calls.push('current'); return current; },
      sessionFault: () => { calls.push('session'); return session; },
      inputFault: () => { calls.push('input'); return input; },
    })).toBe(expected);
    expect(calls).toEqual(order);
  });
});

describe('selectSessionFault', () => {
  it.each([
    [undefined, undefined, 'provider'],
    [undefined, 'input', 'input'],
    ['provider first', 'later input', 'provider first'],
    ['input first', 'later input', 'input first'],
    ['', 'later input', ''],
    [undefined, '', ''],
  ] as const)('existing=%s input=%s retains %s', (existing, input, expected) => {
    const state = createActiveRun({ cwd: '.', pendingHumanAsk: false, autonomous: false });
    if (input !== undefined) state.inputState.recordInputError(input);
    const read = vi.fn(() => state.inputState.agentInputError);
    expect(selectSessionFault(existing, read, 'provider')).toBe(expected);
    expect(read).toHaveBeenCalledTimes(existing === undefined ? 1 : 0);
  });
});

function scratchReads(calls: string[], stop?: string, evidence: () => string[] | undefined = () => []) {
  const flag = (name: string) => { calls.push(name); return name === stop; };
  return {
    active: () => flag('active'), starting: () => flag('starting'), queued: () => flag('queued'), claimed: () => flag('claimed'),
    autosaveBlocker: () => flag('autosave') ? 'saving' : undefined,
    privateWorkers: () => { calls.push('evidence'); return evidence(); },
  };
}

describe('terminalScratchDisposition', () => {
  it('keeps scratch for a missing record without liveness or evidence reads', () => {
    const calls: string[] = [];
    expect(terminalScratchDisposition('missing', undefined, scratchReads(calls))).toBe('keep');
    expect(calls).toEqual([]);
  });

  it.each([RUN_STATUS.done, RUN_STATUS.review, RUN_STATUS.failed, RUN_STATUS.cancelled])('removes unheld %s scratch after checking evidence', status => {
    const run = makeRunRecord({ status });
    const calls: string[] = [];
    expect(terminalScratchDisposition(run.id, run, scratchReads(calls))).toBe('remove');
    expect(calls).toEqual(['active', 'starting', 'queued', 'claimed', 'autosave', 'evidence']);
  });

  it.each(['active', 'starting', 'queued', 'claimed', 'autosave'])('keeps scratch at the first %s hold', stop => {
    const run = makeRunRecord();
    const calls: string[] = [];
    expect(terminalScratchDisposition(run.id, run, scratchReads(calls, stop))).toBe('keep');
    const order = ['active', 'starting', 'queued', 'claimed', 'autosave'];
    expect(calls).toEqual(order.slice(0, order.indexOf(stop) + 1));
  });

  it.each([
    ['worker', worker(), [], 'schedule'],
    ['invalid', makeRunRecord({ id: 'run', delegation: { role: 'invalid' } }), [], 'schedule'],
    ['unreadable', makeRunRecord({ id: 'run' }), undefined, 'schedule'],
    ['listed', makeRunRecord({ id: 'run' }), ['lookup'], 'schedule'],
    ['not listed', makeRunRecord({ id: 'run' }), ['run'], 'remove'],
  ] as const)('%s reads evidence once before delegation and uses the lookup id', (_name, run, evidence, expected) => {
    const calls: string[] = [];
    const input = { ...run, get delegation() { calls.push('delegation'); return run.delegation; } };
    expect(terminalScratchDisposition('lookup', input, scratchReads(calls, undefined, () => evidence ? [...evidence] : undefined))).toBe(expected);
    expect(calls.slice(0, 6)).toEqual(['active', 'starting', 'queued', 'claimed', 'autosave', 'evidence']);
    expect(calls[6]).toBe('delegation');
    expect(calls.filter(value => value === 'evidence')).toHaveLength(1);
  });
});
