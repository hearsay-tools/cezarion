import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AliasWorkBudget, aliasCandidates, linkedAliasCandidates, locateOwnedRoot, mappedAliasCandidates, parseAliasMounts, scopedMappingStillPresent } from './linux-alias-model.ts';

// Sanitized observations from run 40740154700, job 122999251768. This is
// a model replay; it does not test kernel behavior or authorize a signal.
const records = JSON.parse(readFileSync(new URL('./fixtures/linux-alias-records.json', import.meta.url), 'utf8')) as {
  case: string; maps: string[]; root: string; mountinfo: string[];
}[];
const own = locateOwnedRoot('/fixture/owned', parseAliasMounts('1 0 8:1 / / rw - ext4 /dev/root rw\n'));

describe('mount alias candidates', () => {
  it('notifies before a later candidate exhausts translation work', () => {
    const mount = { dev: '8:1', root: '/fixture/owned', point: '/alias' };
    const notifications: string[] = [];
    expect(() => aliasCandidates('/alias/file', '/', '08:01', [mount], [own, own], new AliasWorkBudget(2), undefined,
      () => { notifications.push('candidate'); })).toThrow();
    expect(notifications).toEqual(['candidate']);
  });
  it.each(records)('replays the $case observation without discarding older ancestor mounts', record => {
    const mounts = parseAliasMounts(record.mountinfo.join('\n'));
    const mapped = mappedAliasCandidates(record.maps.join('\n'), record.root, mounts, [own]);
    expect(mapped.length).toBe(record.maps.length);
    for (const line of record.maps) {
      const parts = line.trim().split(/\s+/);
      const path = parts.slice(5).join(' ');
      const expected = path.endsWith('mapped-nested') ? '/fixture/owned/nested/mapped-nested' : '/fixture/owned/mapped';
      expect(aliasCandidates(path, record.root, parts[3]!, mounts, [own])).toContain(expected);
      expect(mapped).toContainEqual({ path: expected, dev: '8:1', ino: BigInt(parts[4]!) });
    }
  });

  it('refuses sibling paths and different devices', () => {
    const mounts = parseAliasMounts('2 1 8:1 /fixture/owned /alias rw - ext4 /dev/root rw\n');
    expect(aliasCandidates('/alias-sibling/file', '/', '08:01', mounts, [own])).toEqual([]);
    expect(aliasCandidates('/alias/file', '/', '08:02', mounts, [own])).toEqual([]);
  });

  it('decodes mount escapes and retains full-width device identities', () => {
    const mounts = parseAliasMounts('2 1 9007199254740993:1 /fixture/owned /alias\\040name rw - ext4 /dev/root rw\n');
    const huge = { ...own, dev: '9007199254740993:1' };
    expect(aliasCandidates('/alias name/file', '/', '20000000000001:01', mounts, [huge])).toEqual(['/fixture/owned/file']);
  });

  it('keeps full inode width and refuses ambiguous deleted or escaped map names', () => {
    const mounts = parseAliasMounts('2 1 8:1 /fixture/owned /alias rw - ext4 /dev/root rw\n');
    const candidates = mappedAliasCandidates('1-2 r--p 0 08:01 9007199254740993123 /alias/file\n', '/', mounts, [own]);
    expect(candidates[0]!.ino).toBe(9007199254740993123n);
    expect(() => mappedAliasCandidates('1-2 r--p 0 08:01 12 /alias/file (deleted)\n', '/', mounts, [own])).toThrow('ambiguous');
    expect(() => mappedAliasCandidates('1-2 r--p 0 08:01 12 /alias/file\\012name\n', '/', mounts, [own])).toThrow('ambiguous');
  });

  it('marks translated scope before reporting ambiguous mapped evidence', () => {
    const mounts = parseAliasMounts('2 1 8:1 /fixture/owned /alias rw - ext4 /dev/root rw\n');
    let scoped = false;
    expect(() => mappedAliasCandidates('1-2 r--p 0 08:01 12 /alias/file (deleted)\n', '/', mounts, [own],
      new AliasWorkBudget(), () => { scoped = true; })).toThrow('ambiguous');
    expect(scoped).toBe(true);
  });

  it('rejects malformed mounts, ambiguous roots and traversal paths', () => {
    expect(() => parseAliasMounts('broken')).toThrow();
    expect(() => parseAliasMounts('2 1 8:1 /foo /bad\\777 rw - ext4 /dev/root rw')).toThrow();
    const stacked = parseAliasMounts('1 0 8:1 / / rw - ext4 /dev/root rw\n2 0 8:1 / / rw - ext4 /dev/root rw');
    expect(() => locateOwnedRoot('/fixture/owned', stacked)).toThrow();
    expect(() => aliasCandidates('/alias/../file', '/', '08:01', [], [own])).toThrow();
    expect(() => parseAliasMounts('x'.repeat(4 * 1024 * 1024 + 1))).toThrow();
  });

  it('retains an authenticated mapping after its alias mount is detached', () => {
    const identity = [{ dev: '8:1', ino: 9007199254740993123n }];
    const maps = '1-2 r--p 0 08:01 9007199254740993123 /detached/file (deleted)\n';
    expect(scopedMappingStillPresent(maps, identity)).toBe(true);
    expect(scopedMappingStillPresent(maps.replace('9007199254740993123', '9007199254740993124'), identity)).toBe(false);
    expect(scopedMappingStillPresent(maps.replace('08:01', '08:02'), identity)).toBe(false);
    expect(() => scopedMappingStillPresent(maps + 'bad\n', identity)).toThrow('malformed');
  });

  it('translates cwd and descriptor links only as candidates for independent identity checks', () => {
    const mounts = parseAliasMounts('2 1 8:1 /fixture/owned /alias rw - ext4 /dev/root rw\n');
    expect(linkedAliasCandidates('/alias/dir', '/', '08:01', 42n, mounts, [own]))
      .toEqual([{ path: '/fixture/owned/dir', dev: '8:1', ino: 42n }]);
    expect(linkedAliasCandidates('/alias-sibling/file', '/', '08:01', 42n, mounts, [own])).toEqual([]);
    expect(() => linkedAliasCandidates('/alias/file (deleted)', '/', '08:01', 42n, mounts, [own])).toThrow('ambiguous');
  });

  it('shares the work limit across mapping and link translations', () => {
    const mounts = parseAliasMounts('2 1 8:1 /fixture/owned /alias rw - ext4 /dev/root rw\n');
    const budget = new AliasWorkBudget(12);
    mappedAliasCandidates('1-2 r--p 0 08:01 42 /alias/file\n', '/', mounts, [own], budget);
    expect(() => linkedAliasCandidates('/alias/file', '/', '08:01', 42n, mounts, [own], budget)).toThrow('work exceeds');
  });

  it('reserves verification work and refunds only its unused portion once', () => {
    const budget = new AliasWorkBudget(10);
    const reserved = budget.reserve(6);
    reserved.budget.spend(2);
    expect(() => budget.spend(5)).toThrow('work exceeds');
    reserved.close(); reserved.close();
    budget.spend(2);
    expect(() => budget.spend(2)).toThrow('work exceeds');
  });

  it('refuses a scan before work when its verification reservation does not fit', () => {
    expect(() => new AliasWorkBudget(5).reserve(6)).toThrow('work exceeds');
  });

  it('returns only unused reserved work after verification throws', () => {
    const budget = new AliasWorkBudget(10);
    const reserved = budget.reserve(6);
    try { reserved.budget.spend(2); throw new Error('changed'); }
    catch { /* verification failed */ }
    finally { reserved.close(); reserved.close(); }
    budget.spend(8);
    expect(() => budget.spend()).toThrow('work exceeds');
  });

  it('handles many unrelated mappings with a shared bounded budget', () => {
    const mounts = parseAliasMounts(['1 0 8:1 / / rw - ext4 /dev/root rw',
      ...Array.from({ length: 149 }, (_, i) => `${i + 2} 1 0:${i + 1} / /pseudo${i} rw - tmpfs tmpfs rw`)].join('\n'));
    const maps = Array.from({ length: 200 }, (_, i) => `${i.toString(16)}-${(i + 1).toString(16)} r--p 0 08:01 ${i + 1} /usr/lib/file${i}`).join('\n');
    const budget = new AliasWorkBudget();
    for (let i = 0; i < 50; i++) expect(mappedAliasCandidates(maps, '/', mounts, [own], budget)).toEqual([]);
  });
});
