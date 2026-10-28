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
    new AliasWorkBudget(0), indexAliasMounts(mounts.map(m => ({ ...m, root: '/elsewhere' })), new AliasWorkBudget(), '/', roots), () => unrelated++)).toThrow('work exceeds');
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
  expect(() => linkedAliasCandidates('/alias/file', '/', '08:01', 12n, mounts, [owned[0]!, owned[0]!], new AliasWorkBudget(20), () => events.push('candidate'), index)).toThrow('work exceeds');
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

it('keeps exact trailing reader points without accepting descendants', () => {
  const mounts = [{ dev: '8:1', root: '/fs', point: '/' }, { dev: '8:1', root: '/fs', point: '/nested/' }];
  const roots = [{ path: '/owned', dev: '8:1', fsPath: '/fs' }];
  const index = indexAliasMounts(mounts, new AliasWorkBudget(), '/chroot', roots);
  for (const path of ['/chroot/', '/chroot/child', '/chroot/nested/', '/chroot/nested/child']) {
    const before: string[] = [], after: string[] = [];
    const expected = aliasCandidates(path, '/chroot', '08:01', mounts, roots, new AliasWorkBudget(), undefined, () => before.push('candidate'));
    const actual = aliasCandidates(path, '/chroot', '08:01', mounts, roots, new AliasWorkBudget(), index, () => after.push('candidate'));
    expect(actual, path).toEqual(expected); expect(after, path).toEqual(before);
  }
});

it('charges more for deep paths during index construction', () => {
  class Meter extends AliasWorkBudget { used = 0; override spend(amount = 1) { this.used += amount; super.spend(amount); } }
  const measure = (path: string) => {
    const meter = new Meter();
    indexAliasMounts([{ dev: '8:1', root: '/', point: path }], meter, '/', [{ path: '/owned', dev: '8:1', fsPath: '/fs' }]);
    return meter.used;
  };
  expect(measure('/a/b/c/d/e/f/g/h/i/j')).toBeGreaterThan(measure('/a'));
});

it('bounds dense long-prefix preprocessing before accepting a partial index', () => {
  const deep = '/' + Array.from({ length: 100 }, () => 'part').join('/');
  const mounts = Array.from({ length: 50 }, () => ({ dev: '8:1', root: '/', point: deep }));
  const roots = Array.from({ length: 30 }, (_, i) => ({ path: `/owned${i}`, dev: '8:1', fsPath: `/fs${i}` }));
  expect(() => indexAliasMounts(mounts, new AliasWorkBudget(1000), '/', roots)).toThrow('work exceeds');
});

it('filters only proven first-component misses and preserves root fallback', () => {
  const roots = [{ path: '/owned', dev: '8:1', fsPath: '/fs' }];
  const mounts = [{ dev: '8:1', root: '/fs', point: '/alias' }, { dev: '8:1', root: '/fs', point: '/' }];
  for (const selected of [mounts.slice(0, 1), mounts]) {
    const index = indexAliasMounts(selected, new AliasWorkBudget(), '/', roots);
    for (const path of ['/', '/alias', '/alias/file', '/alias-other/file', '/other/file', '/é\nlong', '/long' + 'x'.repeat(300)]) {
      for (const device of ['08:01', '08:02']) {
        const old: string[] = [], next: string[] = [];
        expect(aliasCandidates(path, '/', device, selected, roots, new AliasWorkBudget(), index, () => next.push('candidate')))
          .toEqual(aliasCandidates(path, '/', device, selected, roots, new AliasWorkBudget(), undefined, () => old.push('candidate')));
        expect(next).toEqual(old);
      }
    }
  }
  const index = indexAliasMounts(mounts, new AliasWorkBudget(), '/', roots);
  expect(() => aliasCandidates('/bad/../path', '/', '08:01', mounts, roots, new AliasWorkBudget(), index)).toThrow();
  expect(() => aliasCandidates('/unrelated', '/', 'bad-device', mounts, roots, new AliasWorkBudget(), index)).toThrow();
  expect(() => indexAliasMounts(mounts, new AliasWorkBudget(), '/', undefined as never)).toThrow('owned roots required');
});

it('refuses exhausted filter extraction, bucket access, and index insertion', () => {
  const roots = [{ path: '/owned', dev: '8:1', fsPath: '/fs' }];
  const mounts = [{ dev: '8:1', root: '/fs', point: '/alias' }];
  class Meter extends AliasWorkBudget { used = 0; override spend(n = 1) { this.used += n; super.spend(n); } }
  const building = new Meter();
  const index = indexAliasMounts(mounts, building, '/', roots);
  expect(() => indexAliasMounts(mounts, new AliasWorkBudget(building.used - 1), '/', roots)).toThrow('work exceeds');
  const reading = new Meter();
  expect(aliasCandidates('/unrelated', '/', '08:01', mounts, roots, reading, index)).toEqual([]);
  expect(() => aliasCandidates('/unrelated', '/', '08:01', mounts, roots, new AliasWorkBudget(0), index)).toThrow('work exceeds');
  expect(() => aliasCandidates('/unrelated', '/', '08:01', mounts, roots, new AliasWorkBudget(reading.used - 1), index)).toThrow('work exceeds');
});

it('still visits a later interpretation after a first-component miss', () => {
  const roots = [{ path: '/owned', dev: '8:1', fsPath: '/fs' }];
  const mounts = [{ dev: '8:1', root: '/fs', point: '/alias' }];
  let calls = 0;
  expect(() => mappedAliasCandidates('1-2 r--p 0 08:01 42 /alias (deleted)\n', '/', mounts, roots,
    new AliasWorkBudget(), () => { calls++; })).toThrow('ambiguous mapped path');
  expect(calls).toBe(1);
});

it('charges only the device lookup for an absent indexed device', () => {
  const roots = [{ path: '/owned', dev: '8:1', fsPath: '/owned' }];
  const mounts = [{ dev: '8:1', root: '/owned', point: '/alias' }];
  const index = indexAliasMounts(mounts, new AliasWorkBudget(), '/', roots);
  const path = '/unrelated/' + 'long'.repeat(40);
  const shared = new AliasWorkBudget(2);
  let calls = 0;
  for (let i = 0; i < 2; i++) expect(aliasCandidates(path, '/', '08:02', mounts, roots, shared, index, () => calls++)).toEqual([]);
  expect(calls).toBe(0);
  expect(() => aliasCandidates(path, '/', '08:02', mounts, roots, shared, index)).toThrow('work exceeds');
  expect(() => aliasCandidates('/invalid/../path', '/', '08:02', mounts, roots, new AliasWorkBudget(1), index)).toThrow('ambiguous');
  expect(() => aliasCandidates(path, '/', 'invalid', mounts, roots, new AliasWorkBudget(1), index)).toThrow('invalid device');
});

it('retains both path charges when the device bucket exists', () => {
  const roots = [{ path: '/owned', dev: '8:1', fsPath: '/owned' }];
  const mounts = [{ dev: '8:1', root: '/owned', point: '/alias' }];
  const index = indexAliasMounts(mounts, new AliasWorkBudget(), '/', roots);
  for (const units of [0, 1, 2, 3, 4]) {
    expect(() => aliasCandidates('/other/x', '/', '08:01', mounts, roots, new AliasWorkBudget(units), index)).toThrow('work exceeds');
  }
  expect(aliasCandidates('/other/x', '/', '08:01', mounts, roots, new AliasWorkBudget(5), index)).toEqual([]);
  expect(aliasCandidates('/alias/x', '/', '08:01', mounts, roots, new AliasWorkBudget(), index)).toEqual(['/owned/x']);
});
