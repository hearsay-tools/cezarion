import { expect, it } from 'vitest';
import { mergeLegacyJson } from './legacy-merge.ts';

it('applies top-level additions, deletions, and whole-array changes while preserving live-only values', () => {
  expect(mergeLegacyJson('ui-state.json', { removed: 1, stable: 'base', array: [1], nested: { base: true } },
    { stable: 'base', added: true, array: [2], nested: { legacy: true } },
    { removed: 2, stable: 'live', array: [3], nested: { live: true }, liveOnly: true })).toEqual({
      stable: 'live', added: true, array: [2], nested: { legacy: true }, liveOnly: true,
    });
});

it('merges account entries by ID and keeps a live-only edit to a legacy-unchanged entry', () => {
  const stable = { id: 'stable', label: 'Base' };
  expect(mergeLegacyJson('agent-accounts.json', { accounts: [stable, { id: 'removed' }] },
    { accounts: [stable, { id: 'new' }] }, { accounts: [{ ...stable, label: 'Live' }, { id: 'removed' }, { id: 'live' }] }))
    .toEqual({ accounts: [{ ...stable, label: 'Live' }, { id: 'live' }, { id: 'new' }] });
});

it('keeps arbitrary own JSON keys literal without mutating an object prototype', () => {
  const legacy = JSON.parse('{"__proto__":{"unsafe":true},"constructor":"literal"}') as unknown;
  const result = mergeLegacyJson('ui-state.json', {}, legacy, {});
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(JSON.stringify(result)).toBe('{"__proto__":{"unsafe":true},"constructor":"literal"}');
});

it.each([null, [], 1, 'invalid'])('refuses non-object JSON input %s', invalid => {
  expect(() => mergeLegacyJson('config.json', {}, invalid, {})).toThrow(/JSON object/);
});

it.each([[{ id: 'same' }, { id: 'same' }], [{}], [null], 'not-an-array'].map(accounts => ({ accounts })))('refuses a malformed ID registry $accounts', ({ accounts }) => {
  expect(() => mergeLegacyJson('agent-accounts.json', {}, { accounts }, {})).toThrow();
});
