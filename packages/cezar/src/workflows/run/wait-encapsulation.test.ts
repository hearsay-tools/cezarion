import { expect, it } from 'vitest';
import { createActiveRun } from '../active-run.ts';
import { createWaitGroup } from './wait-registry.ts';

const replace = (target: object, key: string, value: unknown) => Object.assign(target, { [key]: value });
const define = (target: object, key: string, value: unknown) => Reflect.defineProperty(target, key, { value });
const set = (target: object, key: string, value: unknown) => Reflect.set(target, key, value);
const prototype = (target: object, value: object | null) => Reflect.setPrototypeOf(target, value);

it('locks the wait identity slot and keeps its getter live through owner commands', () => {
  const state = createActiveRun({ cwd: '/task', pendingHumanAsk: false, autonomous: false });
  const group = state.waitIdentity;
  expect(Object.getOwnPropertyDescriptor(state, 'waitIdentity')).toMatchObject({ writable: false, configurable: false });
  expect(Object.isFrozen(group)).toBe(true);
  expect(Object.isFrozen(Object.getPrototypeOf(group))).toBe(true);
  expect(() => replace(state, 'waitIdentity', createWaitGroup())).toThrow(TypeError);
  expect(() => replace(group, 'ciTurnId', 'forged')).toThrow(TypeError);
  expect(define(group, 'ciTurnId', 'forged')).toBe(false);
  expect(set(group, 'ciTurnId', 'forged')).toBe(false);
  expect(prototype(group, null)).toBe(false);
  expect(group.ciTurnId).toBeUndefined();
  const first = group.ensureCiTurn();
  expect(first).toMatch(/^[0-9a-f-]{36}$/);
  expect(group.ciTurnId).toBe(first);
  expect(group.ensureCiTurn()).toBe(first);
  group.rotateCiTurn('next-turn');
  expect(group.ciTurnId).toBe('next-turn');
  expect(group.ensureCiTurn()).toBe('next-turn');
  expect(state.waitIdentity).toBe(group);
  expect(createWaitGroup().ciTurnId).toBeUndefined();
});
