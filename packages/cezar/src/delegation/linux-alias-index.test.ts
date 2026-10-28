import { expect, it } from 'vitest';
import { AliasWorkBudget, aliasCandidates, indexAliasMounts, mappedAliasCandidates, linkedAliasCandidates } from './linux-alias-model.ts';
import { linkAliasCandidates } from './linux-alias-links.ts';

it('publishes during gathering before lookup or sort exhaustion', () => {
  const roots = [{ path: '/owned', dev: '8:1', fsPath: '/owned' }];
  const mounts = Array.from({ length: 100 }, (_, i) => ({ dev: '8:1', root: '/owned', point: i % 2 ? '/' : '/alias' }));
  const index = indexAliasMounts(mounts, new AliasWorkBudget(), '/', roots);
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
    new AliasWorkBudget(1), indexAliasMounts(mounts.map(m => ({ ...m, root: '/elsewhere' })), new AliasWorkBudget(), '/', roots), () => unrelated++)).toThrow('work exceeds');
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
    const index = indexAliasMounts(mounts, new AliasWorkBudget(), root, owned);
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
  const index = indexAliasMounts(mounts, new AliasWorkBudget(), '/', [owned[0]!, owned[0]!]);
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

it('matches exhaustive mount and root order across intersections and chroots', () => {
  const mounts = [
    { dev: '8:1', root: '/', point: '/' },
    { dev: '8:1', root: '/fs/owned/deep', point: '/alias' },
    { dev: '8:1', root: '/fs', point: '/alias' },
    { dev: '8:1', root: '/fs', point: '/alias' },
    { dev: '8:2', root: '/fs', point: '/alias' },
    { dev: '8:1', root: '/other', point: '/nested' },
  ];
  const roots = [{ path: '/one', dev: '8:1', fsPath: '/fs/owned' },
    { path: '/two', dev: '8:1', fsPath: '/fs' }, { path: '/three', dev: '8:2', fsPath: '/fs' }];
  for (const target of ['/', '/chroot']) {
    const index = indexAliasMounts(mounts, new AliasWorkBudget(), target, roots);
    for (const tail of ['/fs/owned/x', '/alias/owned/x', '/alias/x', '/alias-sibling/x', '/nested/x']) {
      const path = target === '/' ? tail : target + tail;
      for (const device of ['08:01', '08:02']) {
        const oldEvents: string[] = [], newEvents: string[] = [];
        const old = aliasCandidates(path, target, device, mounts, roots, new AliasWorkBudget(), undefined, () => oldEvents.push('candidate'));
        const next = aliasCandidates(path, target, device, mounts, roots, new AliasWorkBudget(), index, () => newEvents.push('candidate'));
        expect(next, `${target} ${path} ${device}`).toEqual(old); expect(newEvents).toEqual(oldEvents);
      }
    }
  }
});

it('does not reject an unreachable oversized derived prefix', () => {
  const mounts = [{ dev: '8:1', root: '/', point: '/' + 'p'.repeat(2000) }];
  const roots = [{ path: '/owned', dev: '8:1', fsPath: '/' + 'f'.repeat(3000) }];
  const index = indexAliasMounts(mounts, new AliasWorkBudget(), '/', roots);
  expect(aliasCandidates('/other', '/', '08:01', mounts, roots, new AliasWorkBudget(), index))
    .toEqual(aliasCandidates('/other', '/', '08:01', mounts, roots));
});

it('refuses preprocessing exhaustion and propagates publication failures', () => {
  const mounts = Array.from({ length: 20 }, () => ({ dev: '8:1', root: '/owned', point: '/alias' }));
  const roots = [{ path: '/owned', dev: '8:1', fsPath: '/owned' }];
  expect(() => indexAliasMounts(mounts, new AliasWorkBudget(2), '/', roots)).toThrow('work exceeds');
  const index = indexAliasMounts(mounts, new AliasWorkBudget(), '/', roots);
  const failure = new Error('publication failed');
  expect(() => aliasCandidates('/alias/file', '/', '08:01', mounts, roots, new AliasWorkBudget(), index, () => { throw failure; })).toThrow(failure);
});

it('keeps repeated fresh unrelated scans under the shared cap', () => {
  const mounts = [{ dev: '8:1', root: '/', point: '/' }];
  const owned = [{ path: '/owned', dev: '8:1', fsPath: '/owned' }];
  const maps = Array.from({ length: 250 }, (_, i) => `1000-2000 r--p 0 08:01 ${i + 1} /usr/lib/file${i}`).join('\n');
  const budget = new AliasWorkBudget();
  for (let scan = 0; scan < 110; scan++) {
    expect(mappedAliasCandidates(maps, '/', mounts, owned, budget)).toEqual([]);
  }
});

it('keeps invalid input and candidate limits in both translators', () => {
  const mounts = [{ dev: '8:1', root: '/fs', point: '/alias' }];
  const roots = Array.from({ length: 1025 }, (_, i) => ({ path: `/owned/${i}`, dev: '8:1', fsPath: '/fs' }));
  const index = indexAliasMounts(mounts, new AliasWorkBudget(), '/', roots);
  for (const [path, device] of [['/alias/../file', '08:01'], ['/alias/file', 'invalid'], ['/alias/file', '08:01']]) {
    expect(() => aliasCandidates(path!, '/', device!, mounts, roots, new AliasWorkBudget(), index)).toThrow();
    expect(() => aliasCandidates(path!, '/', device!, mounts, roots, new AliasWorkBudget())).toThrow();
  }
  const longRoot = [{ path: '/' + 'a'.repeat(4095), dev: '8:1', fsPath: '/fs' }];
  const longIndex = indexAliasMounts(mounts, new AliasWorkBudget(), '/', longRoot);
  let published = false;
  expect(() => aliasCandidates('/alias/x', '/', '08:01', mounts, longRoot, new AliasWorkBudget(), longIndex, () => { published = true; })).toThrow('invalid candidate');
  expect(published).toBe(true);
  expect(() => aliasCandidates('/alias/x', '/', '08:01', mounts, longRoot)).toThrow('invalid candidate');
});
