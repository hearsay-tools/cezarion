import { expect, it } from 'vitest';
import { AliasWorkBudget, aliasCandidates, indexAliasMounts, mappedAliasCandidates, linkedAliasCandidates } from './linux-alias-model.ts';
import { linkAliasCandidates } from './linux-alias-links.ts';

it('publishes during gathering before lookup or sort exhaustion', () => {
  const roots = [{ path: '/owned', dev: '8:1', fsPath: '/owned' }];
  const mounts = Array.from({ length: 100 }, (_, i) => ({ dev: '8:1', root: '/owned', point: i % 2 ? '/' : '/alias' }));
  const index = indexAliasMounts(mounts, new AliasWorkBudget());
  for (const units of [50, 230]) {
    let published = 0;
    expect(() => aliasCandidates('/alias/file', '/', '08:01', mounts, roots, new AliasWorkBudget(units), index, () => published++)).toThrow('work exceeds');
    expect(published).toBeGreaterThan(0);
  }
  class SortBudget extends AliasWorkBudget {
    override spend(amount = 1): void {
      if (new Error().stack?.includes('Array.sort')) return super.spend(200_001);
      super.spend(amount);
    }
  }
  let beforeSort = false;
  expect(() => aliasCandidates('/alias/file', '/', '08:01', mounts, roots, new SortBudget(), index, () => { beforeSort = true; }))
    .toThrow('work exceeds');
  expect(beforeSort).toBe(true);
  let unrelated = 0;
  expect(() => aliasCandidates('/other/file', '/', '08:01', mounts.map(m => ({ ...m, root: '/elsewhere' })), roots,
    new AliasWorkBudget(50), indexAliasMounts(mounts.map(m => ({ ...m, root: '/elsewhere' })), new AliasWorkBudget()), () => unrelated++)).toThrow('work exceeds');
  expect(unrelated).toBe(0);
});

it('matches exhaustive translation and notification order for roots, stacks and sibling paths', () => {
  const mounts = [
    { dev: '8:1', root: '/owned/nested', point: '/alias/deep' },
    { dev: '8:1', root: '/owned', point: '/alias' },
    { dev: '8:1', root: '/owned/stack', point: '/alias' },
    { dev: '8:1', root: '/owned', point: '/' },
    { dev: '8:2', root: '/owned', point: '/alias' },
  ];
  const owned = [{ path: '/owned', dev: '8:1', fsPath: '/owned' }];
  for (const root of ['/', '/container']) for (const path of [root === '/' ? '/' : root, `${root === '/' ? '' : root}/alias`, `${root === '/' ? '' : root}/alias/deep/file`, `${root === '/' ? '' : root}/alias-sibling/file`]) {
    const plain: string[] = [], indexed: string[] = [];
    const index = indexAliasMounts(mounts, new AliasWorkBudget(), root);
    const a = aliasCandidates(path, root, '08:01', mounts, owned, new AliasWorkBudget(), undefined, () => plain.push('candidate'));
    const b = aliasCandidates(path, root, '08:01', mounts, owned, new AliasWorkBudget(), index, () => indexed.push('candidate'));
    expect(b).toEqual(a); expect(indexed).toEqual(plain);
  }
});

it('preserves ambiguous forms and publication before later exhaustion', () => {
  const mounts = [{ dev: '8:1', root: '/owned', point: '/alias' }];
  const owned = [{ path: '/owned', dev: '8:1', fsPath: '/owned' }];
  for (const path of ['/alias/file (deleted)', '/alias/file\\012name']) {
    let published = 0;
    expect(() => mappedAliasCandidates(`1-2 r--p 0 08:01 12 ${path}\n`, '/', mounts, owned, new AliasWorkBudget(), () => published++)).toThrow('ambiguous');
    expect(published).toBeGreaterThan(0);
  }
  const index = indexAliasMounts(mounts, new AliasWorkBudget());
  const events: string[] = [];
  expect(() => linkedAliasCandidates('/alias/file', '/', '08:01', 12n, mounts, [owned[0]!, owned[0]!], new AliasWorkBudget(6), () => events.push('candidate'), index)).toThrow('work exceeds');
  expect(events).toEqual(['candidate']);
});

it('completes repeated multi-process translation under the unchanged shared cap', () => {
  const mounts = Array.from({ length: 200 }, (_, i) => ({ dev: '8:1', root: '/', point: i ? `/mnt/${i}` : '/' }));
  const owned = [{ path: '/owned', dev: '8:1', fsPath: '/owned' }];
  const maps = Array.from({ length: 200 }, (_, i) => `1000-2000 r--p 0 08:01 ${i + 1} /unrelated/file${i}`).join('\n');
  const links = Array.from({ length: 20 }, (_, i) => ({ handle: `fd/${i}`, path: `/unrelated/fd${i}`, dev: '8:1', ino: BigInt(i + 1) }));
  const budget = new AliasWorkBudget();
  for (let scan = 0; scan < 8; scan++) {
    expect(mappedAliasCandidates(maps, '/', mounts, owned, budget)).toEqual([]);
    expect(linkAliasCandidates(links, '/', mounts, owned, budget)).toEqual([]);
  }
});
