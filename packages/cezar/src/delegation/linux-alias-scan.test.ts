import { expect, it } from 'vitest';
import { evaluateAliasCandidates } from './linux-alias-scan.ts';
import { AliasBudgetExceeded, AliasWorkBudget } from './linux-alias-model.ts';

it('requires independently matched identity, and refuses conflicting or unreadable candidates', () => {
  const roots = [{ path: '/owned', dev: '8:1', fsPath: '/owned' }];
  const mapping = { path: '/owned/file', dev: '8:1', ino: 123n };
  const inspect = () => ({ dev: 0x801n, ino: 123n });
  expect(evaluateAliasCandidates([mapping], roots, inspect)).toBe('held');
  expect(evaluateAliasCandidates([], roots, inspect)).toBe('clear');
  expect(evaluateAliasCandidates([mapping], roots, () => ({ dev: 0x801n, ino: 124n }))).toBe('unknown');
  expect(evaluateAliasCandidates([mapping], roots, () => { throw new Error('denied'); })).toBe('unknown');
  expect(evaluateAliasCandidates([mapping, { ...mapping, path: '/owned/other' }], roots, inspect)).toBe('unknown');
  expect(evaluateAliasCandidates([{ ...mapping, path: '/other/file' }], roots, inspect)).toBe('unknown');
});

it('propagates exhausted work instead of classifying the candidate as unrelated', () => {
  const roots = [{ path: '/owned', dev: '8:1', fsPath: '/owned' }];
  const mapping = { path: '/owned/file', dev: '8:1', ino: 123n };
  expect(() => evaluateAliasCandidates([mapping], roots, () => ({ dev: 0x801n, ino: 123n }), new AliasWorkBudget(1)))
    .toThrow(AliasBudgetExceeded);
});
