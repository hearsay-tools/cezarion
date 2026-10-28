import { expect, it, vi } from 'vitest';
import { discoverAliasHolders } from './linux-alias-discovery-sweep.ts';
import { AliasBudgetExceeded, AliasWorkBudget } from './linux-alias-model.ts';
import { AliasMappingScope } from './linux-alias-scope.ts';

it('publishes early positive evidence but returns no holders on an incomplete discovery', async () => {
  const scope = new AliasMappingScope();
  const saved: unknown[] = [];
  const found = discoverAliasHolders([1, 2, 3], scope, new AliasWorkBudget(5), () => 'boot:100', (pid, budgetToken) => {
    expect(budgetToken).toBe('boot:100');
    return pid === 1 ? { outcome: 'held', mappings: [{ path: '/owned/file', dev: '8:1', ino: 42n }], links: [] }
      : { outcome: 'unknown', mappings: [], links: [] };
  }, () => false, () => {}, () => {}, entries => { saved.push(entries); });
  // A smaller budget fails later even if a prior holder was positively published.
  await expect(found).resolves.toHaveLength(1);
  expect(saved.length).toBeGreaterThan(0);
  expect(saved.every(value => Array.isArray(value) && value.length === 1)).toBe(true);
  const short = discoverAliasHolders([1, 2, 3], new AliasMappingScope(), new AliasWorkBudget(2), () => 'boot:100', pid =>
    pid === 1 ? { outcome: 'held', mappings: [{ path: '/owned/file', dev: '8:1', ino: 42n }], links: [] }
      : { outcome: 'unknown', mappings: [], links: [] }, () => false, () => {}, () => {}, () => {});
  await expect(short).rejects.toBeInstanceOf(AliasBudgetExceeded);
});

it('publishes a confirmed positive before a later evidence loss refuses cleanup', async () => {
  const scope = new AliasMappingScope();
  let unavailable = false;
  const saved: unknown[] = [];
  await expect(discoverAliasHolders([101], scope, new AliasWorkBudget(), () => 'boot:100', () => unavailable
    ? { outcome: 'unknown', mappings: [], links: [] }
    : { outcome: 'held', mappings: [{ path: '/owned/file', dev: '8:1', ino: 42n }], links: [] },
  () => false, () => { unavailable = true; }, () => {}, entries => { saved.push(entries); })).rejects.toThrow('Cannot verify');
  expect(scope.has(101)).toBe(true);
  expect(saved).toHaveLength(1);
});

it('refreshes scoped release evidence after the asynchronous authorization', async () => {
  const scope = new AliasMappingScope();
  scope.remember(101, 'boot:100', [{ dev: '8:1', ino: 42n }]);
  let reacquired = false;
  const published: unknown[] = [];
  const holders = await discoverAliasHolders([101], scope, new AliasWorkBudget(), () => 'boot:100', () => reacquired
    ? { outcome: 'held', mappings: [{ path: '/owned/file', dev: '8:1', ino: 42n }], links: [] }
    : { outcome: 'clear', mappings: [], links: [], maps: '', observedLinks: [] },
  () => false, () => { reacquired = true; }, () => {}, entries => { published.push(entries); });
  expect(holders).toEqual([{ pid: 101, token: 'boot:100' }]);
  expect(scope.has(101)).toBe(true);
  expect(published).not.toContainEqual([]);
});

it('refuses when provisionally scoped evidence becomes unscoped unknown', async () => {
  let scans = 0;
  await expect(discoverAliasHolders([101], new AliasMappingScope(), new AliasWorkBudget(), () => 'boot:100', () => ({
    outcome: 'unknown', scoped: ++scans === 1, mappings: [], links: [],
  }), () => false, () => {}, () => {}, () => {})).rejects.toThrow('Cannot verify alias evidence');
});

it('refuses when provisionally scoped uncertainty becomes an unscoped clear', async () => {
  let scans = 0;
  const publish = vi.fn();
  await expect(discoverAliasHolders([101], new AliasMappingScope(), new AliasWorkBudget(), () => 'boot:100', () =>
    ++scans === 1 ? { outcome: 'unknown', scoped: true, mappings: [], links: [] }
      : { outcome: 'clear', scoped: false, mappings: [], links: [], maps: '', observedLinks: [] },
  () => false, () => {}, () => {}, publish)).rejects.toThrow('Cannot verify alias evidence');
  expect(publish).not.toHaveBeenCalled();
});
