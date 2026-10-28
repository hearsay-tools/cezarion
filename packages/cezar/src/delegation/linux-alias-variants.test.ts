import { expect, it } from 'vitest';
import { AliasWorkBudget, aliasCandidates, linkedAliasCandidates, mappedAliasCandidates, type AliasMount, type OwnedMountRoot } from './linux-alias-model.ts';

// Independent variant expansion delegates only the old exhaustive mount/root loop to production.
function exhaustive(raw: string, mounts: AliasMount[], roots: OwnedMountRoot[], newline: boolean) {
  const events: string[] = [];
  const forms = raw.endsWith(' (deleted)') ? [raw, raw.slice(0, -10)] : [raw];
  const variants = forms.flatMap(form => {
    if (!newline) return [form];
    return form.split('\\012').reduce((paths, piece, i) => i ? paths.flatMap(path => [path + '\\012' + piece, path + '\n' + piece]) : [piece], ['']);
  });
  const values = variants.map(path => aliasCandidates(path, '/', '08:01', mounts, roots, new AliasWorkBudget(), undefined, () => events.push('candidate')));
  return { events, values, ambiguous: values.some(value => JSON.stringify(value) !== JSON.stringify(values[0])) };
}

const owned = [{ path: '/owned', dev: '8:1', fsPath: '/fs' }];
const base = [{ dev: '8:1', root: '/fs', point: '/alias' }];
const cases = [
  { name: 'deleted match', raw: '/alias/file (deleted)', mounts: base },
  { name: 'deleted unrelated', raw: '/elsewhere/file (deleted)', mounts: base },
  { name: 'newline match', raw: '/alias/file\\012name', mounts: base },
  { name: 'newline unrelated', raw: '/elsewhere/file\\012name', mounts: base },
  { name: 'both ambiguities', raw: '/alias/file\\012name (deleted)', mounts: base },
  { name: 'only one deleted form matches', raw: '/alias/file (deleted)', mounts: [{ dev: '8:1', root: '/fs', point: '/alias/file (deleted)' }] },
  { name: 'duplicate stacked matches', raw: '/alias/file (deleted)', mounts: [...base, ...base] },
];
it.each(cases)('preserves mapped variants and callbacks: $name', ({ raw, mounts }) => {
  const old = exhaustive(raw, mounts, owned, true);
  const events: string[] = [];
  const run = () => mappedAliasCandidates(`1-2 r--p 0 08:01 42 ${raw}\n`, '/', mounts, owned, new AliasWorkBudget(), () => events.push('candidate'));
  if (old.ambiguous) expect(run).toThrow('ambiguous mapped path');
  else expect(run()).toEqual((old.values[0] ?? []).map(path => ({ path, dev: '8:1', ino: 42n })));
  expect(events).toEqual(old.events);
});
it.each(cases.filter(row => !row.raw.includes('\\012')))('preserves link variants and callbacks: $name', ({ raw, mounts }) => {
  const old = exhaustive(raw, mounts, owned, false);
  const events: string[] = [];
  const run = () => linkedAliasCandidates(raw, '/', '08:01', 42n, mounts, owned, new AliasWorkBudget(), () => events.push('candidate'));
  if (old.ambiguous) expect(run).toThrow('ambiguous link path');
  else expect(run()).toEqual((old.values[0] ?? []).map(path => ({ path, dev: '8:1', ino: 42n })));
  expect(events).toEqual(old.events);
});
