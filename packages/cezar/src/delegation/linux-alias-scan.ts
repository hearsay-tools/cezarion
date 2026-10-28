import { closeSync, constants, lstatSync, openSync, readlinkSync, statSync } from 'node:fs';
import { AliasBudgetExceeded, AliasWorkBudget, locateOwnedRoot, mappedAliasCandidates, parseAliasMounts, type MappedAliasCandidate, type OwnedMountRoot } from './linux-alias-model.ts';
import { linuxDeviceNumber, pinnedAliasIdentity } from './linux-alias-identity.ts';
import { linkAliasCandidates, readAliasLinks, type ObservedLink } from './linux-alias-links.ts';
import { processStartToken } from '../detached-process.ts';
import { readProcEvidence } from './linux-proc-evidence.ts';

/** The owning side changed, so no candidate in the attempt can be trusted. */
export class AliasScanChanged extends Error {}
export class AliasPublicationError extends Error {}

function readBounded(path: string, budget: AliasWorkBudget): string {
  const decoded = readProcEvidence(path, budget).toString('utf8');
  if (decoded.includes('\ufffd')) throw new Error('proc evidence is not valid UTF-8');
  return decoded;
}

function rootIdentity(path: string): string {
  try {
    const info = statSync(path, { bigint: true });
    return info.dev + ':' + info.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
}

function ownedRootIdentity(path: string): string {
  try {
    const info = lstatSync(path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe owned root');
    return info.dev + ':' + info.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
}

export function evaluateAliasCandidates(candidates: readonly MappedAliasCandidate[], roots: readonly OwnedMountRoot[],
  inspect: typeof pinnedAliasIdentity, budget = new AliasWorkBudget(), onMatch?: (candidate: MappedAliasCandidate) => void): 'held' | 'clear' | 'unknown' {
  const matches = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    budget.spend(257 + roots.length);
    const root = roots.find(item => candidate.path === item.path || candidate.path.startsWith(item.path + '/'));
    if (!root) return 'unknown';
    let info: ReturnType<typeof pinnedAliasIdentity>;
    try { info = inspect(root.path, candidate.path); } catch { return 'unknown'; }
    if (linuxDeviceNumber(info.dev) !== candidate.dev || info.ino !== candidate.ino) return 'unknown';
    onMatch?.(candidate);
    const key = candidate.dev + ':' + candidate.ino;
    const paths = matches.get(key) ?? new Set<string>();
    paths.add(candidate.path); matches.set(key, paths);
  }
  return [...matches.values()].some(paths => paths.size > 1) ? 'unknown' : matches.size ? 'held' : 'clear';
}

/** Alias translation never grants authority: a candidate must match the
 * mapped inode and device through a pinned, no-follow owned path. */
export interface AliasScanResult {
  outcome: 'held' | 'clear' | 'unknown';
  scoped?: boolean;
  mappings: MappedAliasCandidate[];
  links: ObservedLink[];
  maps?: string;
  observedLinks?: ObservedLink[];
}

export interface AliasScanAttempt {
  roots: readonly string[];
  owned: OwnedMountRoot[];
  rootIdentities: string[];
  selfMounts: string;
  selfNamespace: string;
  budget: AliasWorkBudget;
}

export function prepareAliasScan(roots: readonly string[], budget: AliasWorkBudget): AliasScanAttempt {
  const selfMounts = readBounded('/proc/self/mountinfo', budget);
  const mounts = parseAliasMounts(selfMounts, budget);
  const rootIdentities = roots.map(ownedRootIdentity);
  const owned = roots.flatMap((root, index) => rootIdentities[index] === 'absent' ? [] : [locateOwnedRoot(root, mounts, budget)]);
  return { roots, owned, rootIdentities, selfMounts, selfNamespace: readlinkSync('/proc/self/ns/mnt'), budget };
}

/** Call after the complete PID sweep and before signalling or clearing it. */
export function verifyAliasScan(attempt: AliasScanAttempt, budget = attempt.budget): void {
  try {
    budget.spend(1 + attempt.roots.length);
    if (attempt.selfNamespace !== readlinkSync('/proc/self/ns/mnt') || attempt.selfMounts !== readBounded('/proc/self/mountinfo', budget) ||
        attempt.rootIdentities.some((identity, index) => identity !== ownedRootIdentity(attempt.roots[index]!))) throw new Error('changed');
  } catch (error) { budget.spend(0); if (error instanceof AliasBudgetExceeded) throw error; throw new AliasScanChanged('owned alias evidence changed or became unavailable'); }
}

function changedToken(pid: number, token: string | undefined): boolean {
  return !!token && processStartToken(pid) !== token;
}

export function scanAliases(pid: number, token: string | undefined, attempt: AliasScanAttempt,
  onConfirmed?: (candidate: MappedAliasCandidate) => void, onCandidate?: () => void): AliasScanResult {
  let scoped = false;
  const unknown = (): AliasScanResult => ({ outcome: 'unknown', scoped, mappings: [], links: [] });
  const { owned, budget } = attempt;
  let procFd: number | undefined;
  try {
    if (changedToken(pid, token)) return unknown();
    procFd = openSync('/proc/' + pid, 0x200000 | constants.O_DIRECTORY);
    const prefix = '/proc/self/fd/' + procFd;
    const namespace = readlinkSync(prefix + '/ns/mnt');
    const rootPath = readlinkSync(prefix + '/root');
    const targetRootIdentity = rootIdentity(prefix + '/root');
    const readerRootIdentity = rootIdentity(rootPath);
    if (targetRootIdentity === 'absent' || targetRootIdentity !== readerRootIdentity) return unknown();
    const targetMounts = readBounded(prefix + '/mountinfo', budget);
    const maps = readBounded(prefix + '/maps', budget);
    const mounts = parseAliasMounts(targetMounts, budget);
    const noteCandidate = () => {
      if (!scoped) {
        if (!token || processStartToken(pid) !== token) throw new AliasPublicationError('Alias incarnation unavailable');
        try { onCandidate?.(); } catch (error) { throw new AliasPublicationError('Cannot persist pending alias scan', { cause: error }); }
      }
      scoped = true;
    };
    const candidates = mappedAliasCandidates(maps, rootPath, mounts, owned, budget, noteCandidate);
    const observedLinks = readAliasLinks(procFd, budget);
    const links = linkAliasCandidates(observedLinks, rootPath, mounts, owned, budget, noteCandidate);
    const inspect: typeof pinnedAliasIdentity = (root, path) => {
      const expected = attempt.rootIdentities[attempt.roots.indexOf(root)];
      if (!expected || expected === 'absent') throw new Error('owned alias root unavailable');
      return pinnedAliasIdentity(root, path, expected);
    };
    const outcome = evaluateAliasCandidates([...candidates, ...links.map(item => item.candidate)], owned, inspect, budget, candidate => {
      if (!token || processStartToken(pid) !== token) throw new Error('alias process changed');
      try { onConfirmed?.(candidate); } catch (error) { throw new AliasPublicationError('Cannot persist alias evidence', { cause: error }); }
    });
    const secondLinks = readAliasLinks(procFd, budget);
    const sameLinks = observedLinks.length === secondLinks.length && observedLinks.every((link, index) => {
      const other = secondLinks[index];
      return other && link.handle === other.handle && link.path === other.path && link.dev === other.dev && link.ino === other.ino;
    });
    if (namespace !== readlinkSync(prefix + '/ns/mnt') || rootPath !== readlinkSync(prefix + '/root') ||
        targetRootIdentity !== rootIdentity(prefix + '/root') || readerRootIdentity !== rootIdentity(rootPath) || targetMounts !== readBounded(prefix + '/mountinfo', budget) ||
        maps !== readBounded(prefix + '/maps', budget) || !sameLinks || !token || processStartToken(pid) !== token) return unknown();
    return { outcome, scoped: candidates.length > 0 || links.length > 0, mappings: candidates, links: links.map(item => item.link), maps, observedLinks };
  } catch (error) {
    budget.spend(0);
    if (error instanceof AliasBudgetExceeded || error instanceof AliasScanChanged || error instanceof AliasPublicationError) throw error;
    // ENOENT for one proc entry can mean lost evidence, not process exit.
    return unknown();
  } finally {
    if (procFd !== undefined) closeSync(procFd);
  }
}
