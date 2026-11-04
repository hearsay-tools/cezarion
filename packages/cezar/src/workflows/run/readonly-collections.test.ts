import { expect, it } from 'vitest';
import { ReadonlyMapView, ReadonlySetView } from './readonly-collections.ts';

it('keeps map iteration live and passes the facade to forEach', () => {
  const backing = new Map([['a', 1]]);
  const view = new ReadonlyMapView(backing);
  const iterator = view.entries();
  backing.set('a', 2);
  backing.set('b', 3);
  expect([...iterator]).toEqual([['a', 2], ['b', 3]]);
  expect(view.size).toBe(2);
  expect(view.get('a')).toBe(2);
  expect(view.has('b')).toBe(true);
  expect([...view.keys()]).toEqual(['a', 'b']);
  expect([...view.values()]).toEqual([2, 3]);
  const receiver = {};
  view.forEach(function (this: object, value, key, map) {
    expect(this).toBe(receiver);
    expect(map).toBe(view);
    expect(backing.get(key)).toBe(value);
    expect(() => Map.prototype.clear.call(map)).toThrow(TypeError);
  }, receiver);
  expect(Object.isFrozen(view)).toBe(true);
  expect(Object.isFrozen(Object.getPrototypeOf(view))).toBe(true);
  const write = (target: object) => Reflect.set(target, 'size', 99);
  expect(write(view)).toBe(false);
  expect([...view]).toEqual([['a', 2], ['b', 3]]);
});

it('keeps set iteration live and passes the facade to forEach', () => {
  const backing = new Set(['a']);
  const view = new ReadonlySetView(backing);
  const iterator = view.values();
  backing.add('b');
  expect([...iterator]).toEqual(['a', 'b']);
  expect([...view.keys()]).toEqual(['a', 'b']);
  expect([...view.entries()]).toEqual([['a', 'a'], ['b', 'b']]);
  expect(view.has('b')).toBe(true);
  expect(view.size).toBe(2);
  const receiver = {};
  view.forEach(function (this: object, value, key, set) {
    expect(this).toBe(receiver);
    expect(set).toBe(view);
    expect(key).toBe(value);
    expect(() => Set.prototype.add.call(set, 'forged')).toThrow(TypeError);
  }, receiver);
  expect(Object.isFrozen(view)).toBe(true);
  expect(Object.isFrozen(Object.getPrototypeOf(view))).toBe(true);
  const write = (target: object) => Reflect.defineProperty(target, 'has', { value: () => true });
  expect(write(view)).toBe(false);
  expect([...view]).toEqual(['a', 'b']);
});
