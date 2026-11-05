import { afterEach, expect, it, vi } from 'vitest';
import { createActiveRun } from '../active-run.ts';
import { clearAutosaveTimer } from './input-timers.ts';
import { AUTOSAVE_INTERVAL_MS, createAutosaveGroup } from './worktree-autosave.ts';

const replace = (target: object, key: string, value: unknown) => Object.assign(target, { [key]: value });
const define = (target: object, key: string, value: unknown) => Reflect.defineProperty(target, key, { value });
const set = (target: object, key: string, value: unknown) => Reflect.set(target, key, value);
const prototype = (target: object, value: object | null) => Reflect.setPrototypeOf(target, value);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('locks the autosave slot and prevents replacement of the live timer getter', () => {
  const state = createActiveRun({ cwd: '/task', pendingHumanAsk: false, autonomous: false });
  const group = state.autosave;
  expect(Object.getOwnPropertyDescriptor(state, 'autosave')).toMatchObject({ writable: false, configurable: false });
  expect(Object.isFrozen(group)).toBe(true);
  expect(Object.isFrozen(Object.getPrototypeOf(group))).toBe(true);
  expect(() => replace(state, 'autosave', createAutosaveGroup())).toThrow(TypeError);
  expect(() => replace(group, 'autosaveTimer', undefined)).toThrow(TypeError);
  expect(define(group, 'autosaveTimer', undefined)).toBe(false);
  expect(set(group, 'autosaveTimer', undefined)).toBe(false);
  expect(prototype(group, null)).toBe(false);
  expect(group.autosaveTimer).toBeUndefined();
  group.clearAutosave();
  expect(group.autosaveTimer).toBeUndefined();
});

it('arms the same interval and clears it synchronously without clearing idle or reply bounds', () => {
  vi.useFakeTimers();
  const state = createActiveRun({ cwd: '/task', pendingHumanAsk: false, autonomous: false });
  const group = state.autosave;
  const saved = vi.fn();
  const idle = vi.fn();
  const reply = vi.fn();
  state.idleTimer = setTimeout(idle, AUTOSAVE_INTERVAL_MS * 2);
  state.noWaitNudgeReplyTimer = setTimeout(reply, AUTOSAVE_INTERVAL_MS * 2);
  group.armAutosave(saved);
  const handle = group.autosaveTimer!;
  expect(handle.hasRef()).toBe(false);
  expect(group.autosaveTimer).toBe(handle);
  vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS - 1);
  expect(saved).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(saved).toHaveBeenCalledOnce();
  const originalClear = globalThis.clearInterval;
  const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(timer => {
    expect(group.autosaveTimer).toBe(handle);
    expect(timer).toBe(handle);
    originalClear(timer);
  });
  clearAutosaveTimer(state);
  expect(clear).toHaveBeenCalledOnce();
  clear.mockRestore();
  expect(group.autosaveTimer).toBeUndefined();
  expect(state.autosave).toBe(group);
  vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS);
  expect(saved).toHaveBeenCalledOnce();
  expect(idle).toHaveBeenCalledOnce();
  expect(reply).toHaveBeenCalledOnce();
  group.armAutosave(saved);
  expect(group.autosaveTimer).not.toBe(handle);
  clearAutosaveTimer(state);
});
