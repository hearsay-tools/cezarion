import { afterEach, expect, it, vi } from 'vitest';
import type { AgentSession } from '../../core/agent-runner.ts';
import { createActiveRun, writeInput } from '../active-run.ts';
import { createInputGroup, InputFlight } from './input-delivery.ts';

const unused = (): never => { throw new Error('unused input capability'); };
function session(): AgentSession {
  return { open: true, result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
    sendMessage: unused, sendAgentMessage: unused, discardQueuedMessages: unused,
    holdsHumanInput: unused, end: unused, interrupt: unused };
}
const define = (target: object, key: string, value: unknown) => Reflect.defineProperty(target, key, { value });
const setPrototype = (target: object) => Reflect.setPrototypeOf(target, null);
const replace = (target: object, key: string, value: unknown) => Object.assign(target, { [key]: value });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('locks the input slot and frozen group without freezing runner capabilities', () => {
  const state = createActiveRun({ cwd: '.', pendingHumanAsk: false, autonomous: false });
  const group = state.inputState;
  expect(Object.getOwnPropertyDescriptor(state, 'inputState')).toMatchObject({ writable: false, configurable: false });
  expect(Object.isFrozen(group)).toBe(true);
  expect(Object.isFrozen(Object.getPrototypeOf(group))).toBe(true);
  expect(() => replace(state, 'inputState', createInputGroup())).toThrow(TypeError);
  expect(() => replace(group, 'agentInputError', 'forged')).toThrow(TypeError);
  expect(define(group, 'writingInput', true)).toBe(false);
  expect(setPrototype(group)).toBe(false);
  group.recordInputError('transport failed');
  group.answerOpeningAsk(7);
  group.selectOpeningInput('opening');
  expect(group.agentInputError).toBe('transport failed');
  expect(group.openingAnswerAskSeq).toBe(7);
  expect(group.openingAgentInputId).toBe('opening');
  group.clearOpeningAnswer(); group.selectOpeningInput(undefined);
  expect(group.openingAnswerAskSeq).toBeUndefined();
  expect(group.openingAgentInputId).toBeUndefined();
  const wire = session();
  const flight = new InputFlight(wire, ['message'], true);
  group.attachFlight(flight);
  expect(group.agentInputFlight).toBe(flight);
  expect(flight.session).toBe(wire);
  expect(Object.isFrozen(wire)).toBe(false);
  group.clearFlight();
  expect(group.agentInputFlight).toBeUndefined();
});

it('owns immutable flight IDs, bundled IDs and delivery policy without freezing shared inputs', () => {
  const ids = ['one'];
  const flight = new InputFlight(session(), ids, true);
  expect(Object.isFrozen(flight)).toBe(true);
  expect(Object.isFrozen(Object.getPrototypeOf(flight))).toBe(true);
  expect(Object.isFrozen(flight.inputIds)).toBe(true);
  const view = flight.inputIds;
  ids.push('external');
  expect(view).toEqual(['one']);
  expect(flight.inputIds).toBe(view);
  expect(flight.admittedWake).toBe(true);
  expect(flight.wakeReserved).toBeUndefined();
  expect(flight.settled).toBeUndefined();
  expect(() => replace(flight, 'wakeReserved', true)).toThrow(TypeError);
  expect(define(flight, 'settled', Promise.resolve())).toBe(false);
  const group = createInputGroup();
  group.bundleInputs(ids);
  const bundled = group.bundledInputIds!;
  ids.push('later');
  expect(bundled).toEqual(['one', 'external']);
  expect(Object.isFrozen(bundled)).toBe(true);
  group.bundleInputs(['next']);
  expect(group.bundledInputIds).toEqual(['one', 'external', 'next']);
  expect(bundled).toEqual(['one', 'external']);
  group.clearBundledInputs();
  expect(group.bundledInputIds).toBeUndefined();
  const policy = { mode: 'steer' as const, consumption: 'observable' as const, via: 'test' };
  group.declareDelivery(policy);
  expect(group.inputDelivery).toEqual(policy);
  expect(Object.isFrozen(policy)).toBe(false);
  expect(Object.isFrozen(group.inputDelivery)).toBe(true);
  policy.via = 'changed';
  expect(group.inputDelivery?.via).toBe('test');
});

it('keeps live readonly set identity and insertion order across owner changes', () => {
  const group = createInputGroup();
  group.resetUnreadInputs(); group.resetEarlyConsumption();
  group.prepareUnreadRetry(); group.retireInFlight('one');
  const unread = group.unreadInputIds!;
  const early = group.consumedBeforeAck!;
  const retired = group.retiredInFlight!;
  const retried = group.unreadRetried!;
  const iterator = unread.values();
  group.recordUnreadInput('one'); group.recordUnreadInput('two');
  group.recordEarlyConsumption('one'); group.recordUnreadRetry('one');
  expect(iterator.next()).toEqual({ value: 'one', done: false });
  expect([...unread]).toEqual(['one', 'two']);
  expect(group.unreadInputIds).toBe(unread);
  expect(group.consumedBeforeAck).toBe(early);
  expect(group.retiredInFlight).toBe(retired);
  expect(group.unreadRetried).toBe(retried);
  for (const view of [unread, early, retired, retried]) {
    expect([...view]).toContain('one');
    expect(Object.isFrozen(view)).toBe(true);
    view.forEach((_value, _key, received) => { expect(received).toBe(view); });
    expect(() => Set.prototype.add.call(view, 'forged')).toThrow(TypeError);
    expect(() => replace(view, 'size', 99)).toThrow(TypeError);
  }
  group.forgetEarlyConsumption('one'); group.forgetRetiredInput('one');
  group.forgetUnreadInput('one');
  expect(early.size).toBe(0); expect(retired.size).toBe(0);
  expect([...unread]).toEqual(['two']);
  group.resetUnreadInputs(); group.resetEarlyConsumption();
  expect([...unread]).toEqual(['two']);
  expect(group.unreadInputIds).not.toBe(unread);
  expect(group.consumedBeforeAck).not.toBe(early);
  expect(group.unreadInputIds?.size).toBe(0);
  group.recordUnreadInput('new'); group.clearUnreadInputs();
  expect(group.unreadInputIds?.size).toBe(0);
});

it('restores writingInput synchronously after nested writes, throws and promise returns', async () => {
  const state = createActiveRun({ cwd: '.', pendingHumanAsk: false, autonomous: false });
  const marker = new Error('sync failure');
  expect(state.inputState.writingInput).toBeUndefined();
  expect(() => writeInput(state, () => {
    expect(state.inputState.writingInput).toBe(true);
    expect(writeInput(state, () => state.inputState.writingInput)).toBe(true);
    expect(state.inputState.writingInput).toBe(true);
    throw marker;
  })).toThrow(marker);
  expect(state.inputState.writingInput).toBeUndefined();
  let resolve!: (value: string) => void;
  const promise = new Promise<string>(done => { resolve = done; });
  const returned = writeInput(state, () => promise);
  expect(returned).toBe(promise);
  expect(state.inputState.writingInput).toBeUndefined();
  resolve('done');
  await expect(returned).resolves.toBe('done');
});

it('clears retained timers synchronously and preserves the held clock only when requested', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const group = createInputGroup();
  group.beginHeldClock(); group.expireHeldInput();
  const since = group.heldHumanInputSince;
  const held = setTimeout(unused, 250);
  const unread = setTimeout(unused, 1000);
  group.retainHeldTimer(held); group.retainUnreadTimer(unread);
  expect(vi.getTimerCount()).toBe(2);
  group.clearHeldTimer(false);
  expect(vi.getTimerCount()).toBe(1);
  expect(group.heldHumanInputTimer).toBeUndefined();
  expect(group.heldHumanInputSince).toBe(since);
  expect(group.heldHumanInputExpired).toBe(true);
  group.clearUnreadTimer();
  expect(vi.getTimerCount()).toBe(0);
  group.clearHeldTimer();
  expect(group.heldHumanInputSince).toBeUndefined();
  expect(group.heldHumanInputExpired).toBeUndefined();
});
