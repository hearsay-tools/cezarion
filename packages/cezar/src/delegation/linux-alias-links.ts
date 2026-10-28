import { closeSync, fstatSync, openSync, opendirSync, readlinkSync } from 'node:fs';
import { AliasWorkBudget, indexAliasMounts, linkedAliasCandidates, type AliasMount, type MappedAliasCandidate, type OwnedMountRoot } from './linux-alias-model.ts';
import { linuxDeviceNumber } from './linux-alias-identity.ts';
import type { ScopedLink } from './linux-alias-scope.ts';

const O_PATH = 0x200000;
const MAX_LINKS = 1024;

function descriptorNames(path: string, budget: AliasWorkBudget): string[] {
  const directory = opendirSync(path);
  const names: string[] = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      budget.spend();
      if (!/^\d+$/.test(entry.name) || names.length >= MAX_LINKS) throw new Error('descriptor evidence exceeds bounds');
      names.push(entry.name);
    }
  } finally { directory.closeSync(); }
  return names.sort((a, b) => Number(a) - Number(b));
}

export interface ObservedLink extends ScopedLink { path: string }

export function linkAliasCandidates(links: readonly ObservedLink[], targetRoot: string, mounts: readonly AliasMount[],
  roots: readonly OwnedMountRoot[], budget: AliasWorkBudget, onCandidate?: () => void): { link: ObservedLink; candidate: MappedAliasCandidate }[] {
  const result: { link: ObservedLink; candidate: MappedAliasCandidate }[] = [];
  if (links.length > MAX_LINKS) throw new Error('descriptor evidence exceeds bounds');
  const index = indexAliasMounts(mounts, budget);
  for (const link of links) {
    budget.spend();
    if (!link.path.startsWith('/')) continue;
    const device = link.dev.split(':').map(value => BigInt(value).toString(16)).join(':');
    for (const candidate of linkedAliasCandidates(link.path, targetRoot, device, link.ino, mounts, roots, budget, onCandidate, index)) {
      result.push({ link, candidate });
      if (result.length > MAX_LINKS) throw new Error('link candidates exceed bounds');
    }
  }
  return result;
}

/** procDir is an already opened /proc/<pid> directory. O_PATH pins each
 * referent while its link and identity are compared. Any race is unknown. */
export function readAliasLinks(procDir: number, budget: AliasWorkBudget): ObservedLink[] {
  const prefix = '/proc/self/fd/' + procDir;
  const names = descriptorNames(prefix + '/fd', budget);
  const handles = ['cwd', ...names.map(name => 'fd/' + name)];
  const result: ObservedLink[] = [];
  for (const handle of handles) {
    budget.spend();
    const path = prefix + '/' + handle;
    const before = readlinkSync(path);
    if (before.includes('\ufffd') || Buffer.byteLength(before) > 4096) throw new Error('invalid link evidence');
    const fd = openSync(path, O_PATH);
    try {
      const identity = fstatSync(fd, { bigint: true });
      const after = readlinkSync(path);
      const checkFd = openSync(path, O_PATH);
      try {
        const check = fstatSync(checkFd, { bigint: true });
        if (before !== after || identity.dev !== check.dev || identity.ino !== check.ino || identity.mode !== check.mode) throw new Error('link evidence changed');
      } finally { closeSync(checkFd); }
      result.push({ handle, path: before, dev: linuxDeviceNumber(identity.dev), ino: identity.ino });
    } finally { closeSync(fd); }
  }
  const afterNames = descriptorNames(prefix + '/fd', budget);
  if (names.join(',') !== afterNames.join(',')) throw new Error('descriptor set changed');
  return result;
}
