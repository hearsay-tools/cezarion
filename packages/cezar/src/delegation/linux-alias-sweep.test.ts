import { expect, it } from 'vitest';
import { AliasBudgetExceeded, AliasWorkBudget } from './linux-alias-model.ts';
import { collectAliasHolders } from './linux-alias-sweep.ts';
import type { AliasScanResult } from './linux-alias-scan.ts';

const result = (outcome: AliasScanResult['outcome']): AliasScanResult => ({ outcome, links: [], mappings: [] });

it('refuses an incomplete sweep before a later holder can be skipped or signalled', () => {
  const candidates = [1, 2, 3, 4];
  const signalled: number[] = [];
  expect(() => {
    const holders = collectAliasHolders(candidates, new AliasWorkBudget(4), (pid, budget) => {
      budget.spend(1);
      return result(pid === 4 ? 'held' : 'clear');
    }, () => false);
    signalled.push(...holders.map(holder => holder.candidate));
  }).toThrow(AliasBudgetExceeded);
  expect(signalled).toEqual([]);
});

it('skips unrelated unreadable processes but retains a scoped one', () => {
  const candidates = Array.from({ length: 1000 }, (_, index) => index);
  expect(collectAliasHolders(candidates, new AliasWorkBudget(), (_pid, budget) => {
    budget.spend(100);
    return result('unknown');
  }, () => false)).toEqual([]);
  expect(() => collectAliasHolders(candidates, new AliasWorkBudget(), () => result('unknown'), pid => pid === 999))
    .toThrow('scoped alias evidence unavailable');
  expect(() => collectAliasHolders([1], new AliasWorkBudget(), () => ({ ...result('unknown'), scoped: true }), () => false))
    .toThrow('scoped alias evidence unavailable');
});
