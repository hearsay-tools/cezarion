import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { stageAttribution } from '../../test/e2e/capacity-attribution-stage.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
it('validates all inputs before returning staged output', () => {
  const source = 'budget.spend(1);';
  const spec = { sha256: hash(source), expectedSites: 1, edits: [{ marker: source, replacement: "budget.spend(1, 'filter');" }] };
  expect(stageAttribution({ a: source }, { a: spec })).toEqual({ a: "budget.spend(1, 'filter');" });
  expect(() => stageAttribution({ a: source, b: 'changed' }, { a: spec, b: { ...spec, sha256: hash('other') } })).toThrow('hash changed');
  expect(() => stageAttribution({ a: source }, { a: { ...spec, expectedSites: 2 } })).toThrow('inventory changed');
  expect(() => stageAttribution({ a: source }, { a: { ...spec, edits: [{ marker: 'missing', replacement: '' }] } })).toThrow('marker changed');
  const duplicate = source.repeat(2);
  expect(() => stageAttribution({ a: duplicate }, { a: { ...spec, sha256: hash(duplicate), expectedSites: 2 } })).toThrow('marker changed');
});
it('refuses reserve use and helper collisions before staging', () => {
  for (const source of ['budget.reserve(1);', 'cezCapacityAttribution']) {
    expect(() => stageAttribution({ a: source }, { a: { sha256: hash(source), expectedSites: 0, edits: [] } })).toThrow();
  }
});
