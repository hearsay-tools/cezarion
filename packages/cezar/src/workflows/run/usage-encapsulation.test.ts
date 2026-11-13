import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { RunStore } from '../../runs/store.ts';
import { createActiveRun } from '../active-run.ts';
import { beginUsageInvocation, recordReportedCost, recordUsageUiEvent } from './usage-accounting.ts';

// Generic receivers deliberately exercise the runtime boundary after syntax/type information
// has been erased. No mutation below receives the owner's private write capability.
const mutations = {
  assign: (target: object, key: string, value: unknown) => Object.assign(target, { [key]: value }),
  spread: (target: object, key: string, value: unknown) => Object.assign(target, { ...{ [key]: value } }),
  defineProperty: (target: object, key: string, value: unknown) => Object.defineProperty(target, key, { value }),
  defineProperties: (target: object, key: string, value: unknown) => Object.defineProperties(target, { [key]: { value } }),
  reflectDefine: (target: object, key: string, value: unknown) => Reflect.defineProperty(target, key, { value }),
  reflectSet: (target: object, key: string, value: unknown) => Reflect.set(target, key, value),
  reflectDelete: (target: object, key: string) => Reflect.deleteProperty(target, key),
  objectPrototype: (target: object) => Object.setPrototypeOf(target, null),
  reflectPrototype: (target: object) => Reflect.setPrototypeOf(target, null),
};

function attempt(write: () => unknown): void {
  try { write(); } catch (error) { expect(error).toBeInstanceOf(TypeError); }
}

describe('usage owner encapsulation', () => {
  let root: string;
  let store: RunStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-usage-owner-'));
    store = RunStore.open(join(root, '.ai/cezar'));
  });
  afterEach(() => { store.flush(); rmSync(root, { recursive: true, force: true }); });

  function fixture() {
    const run = store.createRun({ title: 'usage', task: 'usage', workflow: 'quick-task',
      steps: [{ id: 'work', name: 'Work', kind: STEP_KIND.agent }] });
    const state = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
    beginUsageInvocation(store, run.id, state, 'work');
    return { run, state };
  }

  it('keeps one live invocation and collection views while the owner records durable usage', () => {
    const { run, state } = fixture();
    const { usage } = state;
    const invocation = usage.usageInvocation!;
    const { startedTurns, recordedTurns } = invocation;
    const iterator = startedTurns.values();
    recordUsageUiEvent(store, run.id, state, { type: 'turn.started', turnId: 'one' });
    expect(iterator.next()).toEqual({ value: 'one', done: false });
    recordUsageUiEvent(store, run.id, state, { type: 'turn.completed', turnId: 'one', stopReason: 'end_turn',
      usage: { input: 10, output: 2, total: 12 } });
    expect(usage.usageInvocation).toBe(invocation);
    expect(invocation.startedTurns).toBe(startedTurns);
    expect(invocation.recordedTurns).toBe(recordedTurns);
    expect(invocation.observed).toBe(true);
    expect([...startedTurns]).toEqual(['one']);
    expect([...recordedTurns.entries()]).toEqual([['one', 'one']]);
    expect(store.getRun(run.id)!.steps[0]).toMatchObject({ inputTokens: 10, outputTokens: 2,
      usageInvocationsStarted: 1, usageInvocationsObserved: 1, usageTurnsStarted: 1, usageTurnsRecorded: 1 });
    beginUsageInvocation(store, run.id, state, 'work');
    expect(usage.usageInvocation).not.toBe(invocation);
    expect(invocation.epoch).toBe(1);
    expect(usage.usageInvocation!.epoch).toBe(2);
    expect([...startedTurns]).toEqual(['one']);
  });

  it('keeps cost views live, ordered and isolated from native Map and Set mutation', () => {
    const { run, state } = fixture();
    recordReportedCost(store, run.id, 'work', state, 'claude', 1);
    const costs = state.usage.cumulativeSessionCost!;
    const entries = costs.entries();
    recordReportedCost(store, run.id, 'work', state, 'claude', 3);
    expect(entries.next()).toEqual({ value: ['work', 3], done: false });
    expect(state.usage.cumulativeSessionCost).toBe(costs);
    expect([...costs.keys()]).toEqual(['work']);
    expect([...costs.values()]).toEqual([3]);
    expect([...costs]).toEqual([['work', 3]]);
    expect(() => Map.prototype.set.call(costs, 'work', 999)).toThrow(TypeError);
    const turns = state.usage.usageInvocation!.startedTurns;
    expect(() => Set.prototype.add.call(turns, 'forged')).toThrow(TypeError);
    expect(store.getRun(run.id)!.steps[0]!.costUsd).toBe(3);
    const receiver = {};
    costs.forEach(function (this: object, value, key, map) {
      expect(this).toBe(receiver);
      expect([value, key, map]).toEqual([3, 'work', costs]);
    }, receiver);
    recordUsageUiEvent(store, run.id, state, { type: 'turn.started', turnId: 'one' });
    turns.forEach((value, key, set) => {
      expect([value, key]).toEqual(['one', 'one']);
      expect(set).toBe(turns);
      expect(() => Set.prototype.clear.call(set)).toThrow(TypeError);
    });
  });

  it.each(Object.entries(mutations))('blocks %s through aliases, nested views and prototypes', (_name, write) => {
    const { run, state } = fixture();
    recordReportedCost(store, run.id, 'work', state, 'claude', 1);
    const { usage } = state;
    const invocation = usage.usageInvocation!;
    const cases: [object, string, unknown][] = [
      [usage, 'usageInvocation', undefined], [usage, 'cumulativeSessionCost', new Map()],
      [invocation, 'observed', true], [invocation, 'stepId', 'forged'],
      [invocation, 'startedTurns', new Set(['forged'])], [invocation, '#observed', true],
      [invocation.startedTurns, 'has', () => true], [invocation.recordedTurns, 'size', 999],
      [usage.cumulativeSessionCost!, 'get', () => 999],
    ];
    for (const [target, key, value] of cases) {
      expect(Object.isFrozen(target)).toBe(true);
      expect(Object.isFrozen(Object.getPrototypeOf(target))).toBe(true);
      attempt(() => write(target, key, value));
      attempt(() => write(Object.getPrototypeOf(target), key, value));
    }
    expect(usage.usageInvocation).toBe(invocation);
    expect(invocation.observed).toBe(false);
    expect(invocation.stepId).toBe('work');
    expect(invocation.startedTurns.size).toBe(0);
    expect(invocation.recordedTurns.size).toBe(0);
    expect(usage.cumulativeSessionCost!.get('work')).toBe(1);
    recordUsageUiEvent(store, run.id, state, { type: 'turn.started', turnId: 'real' });
    expect(invocation.observed).toBe(true);
    expect([...invocation.startedTurns]).toEqual(['real']);
  });

  it('blocks a computed-key Object.assign helper from replacing a migrated slot', () => {
    const { run, state } = fixture();
    const usage = state.usage;
    const other = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
    const replace = (target: object, key: string, value: object) => Object.assign(target, { [key]: value });
    expect(() => replace(state, ['us', 'age'].join(''), other.usage)).toThrow(TypeError);
    expect(mutations.reflectSet(state, 'usage', other.usage)).toBe(false);
    expect(mutations.reflectDefine(state, 'usage', other.usage)).toBe(false);
    expect(mutations.reflectDelete(state, 'usage')).toBe(false);
    expect(state.usage).toBe(usage);
    // Other groups still have legitimate writers until their migration.
    state.liveSession.cancel();
    expect(state.liveSession.cancelled).toBe(true);
    recordUsageUiEvent(store, run.id, state, { type: 'turn.started', turnId: 'real' });
    expect(usage.usageInvocation!.observed).toBe(true);
  });
});
