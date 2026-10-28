import { expect, it } from 'vitest';
import { assessAliasEvidence } from './linux-alias-discovery.ts';
import { AliasWorkBudget } from './linux-alias-model.ts';
import { AliasMappingScope } from './linux-alias-scope.ts';
import type { AliasScanResult } from './linux-alias-scan.ts';

it('retains a positively scoped descriptor after translation disappears', () => {
  const budget = new AliasWorkBudget();
  const scope = new AliasMappingScope();
  const publish = () => {};
  const link = { handle: 'fd/3', path: '/alias/file', dev: '8:1', ino: 42n };
  const held: AliasScanResult = { outcome: 'held', mappings: [], links: [link] };
  expect(assessAliasEvidence(100, 'old', held, scope, budget, publish)).toBe(true);
  const clear: AliasScanResult = { outcome: 'clear', mappings: [], links: [], maps: '', observedLinks: [link] };
  expect(() => assessAliasEvidence(100, 'old', clear, scope, budget, publish)).toThrow('released');
  expect(() => assessAliasEvidence(100, 'old', { outcome: 'unknown', mappings: [], links: [] }, scope, budget, publish)).toThrow('verify');
  expect(assessAliasEvidence(100, 'old', { ...clear, observedLinks: [] }, scope, budget, publish)).toBe(false);
  expect(assessAliasEvidence(100, 'old', { outcome: 'unknown', mappings: [], links: [] }, scope, budget, publish)).toBe(false);
});

it('does not transfer old scope to a verified new process incarnation', () => {
  const budget = new AliasWorkBudget();
  const scope = new AliasMappingScope();
  scope.remember(100, 'old', [{ dev: '8:1', ino: 42n }]);
  expect(assessAliasEvidence(100, 'new', { outcome: 'unknown', mappings: [], links: [] }, scope, budget, () => {})).toBe(false);
});

it('does not accept a positive match when durable publication fails', () => {
  const scope = new AliasMappingScope();
  const held: AliasScanResult = { outcome: 'held', mappings: [{ path: '/owned/file', dev: '8:1', ino: 42n }], links: [] };
  expect(() => assessAliasEvidence(100, 'boot:123', held, scope, new AliasWorkBudget(), () => { throw new Error('disk'); })).toThrow('disk');
  expect(scope.has(100)).toBe(true);
});
