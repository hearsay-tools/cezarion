import { lstatSync, opendirSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { exitedStat, linuxBootId, parseProcStat, processStartToken } from '../detached-process.ts';
import type { WorkerAliasRetention, WorkerExecution } from '../runs/worker-execution.ts';
import { windowsDestroyHolders, windowsStopDestroyHolder } from './windows-workspace-identity.ts';
import { canonicalResourceRoot } from './mount-boundary.ts';
import { mappedHolder } from './linux-mapped-holders.ts';
import { AliasBudgetExceeded, AliasWorkBudget } from './linux-alias-model.ts';
import { prepareAliasScan, scanAliases, verifyAliasScan, type AliasScanAttempt } from './linux-alias-scan.ts';
import { aliasRetentionAdapter } from './linux-alias-retention.ts';
import { assessAliasEvidence } from './linux-alias-discovery.ts';
import { discoverAliasHolders } from './linux-alias-discovery-sweep.ts';
import type { AliasMappingScope } from './linux-alias-scope.ts';

export interface DestroyAliasRetention {
  resourceId: string;
  read(): WorkerExecution | undefined;
  write(value: WorkerAliasRetention | undefined): void;
}

type AliasContext = { attempt: AliasScanAttempt; scope: AliasMappingScope;
  publish: (entries: ReturnType<AliasMappingScope['snapshot']>) => void };

/** Destroy-only evidence. Admission and retention keep their existing liveness policy. */
function holds(pid: number, paths: readonly string[], budget?: AliasWorkBudget): boolean {
  if (process.platform === 'darwin') return findDarwinHolders(paths, pid).includes(pid);
  const under = (value: string) => {
    const path = value.replace(/ \(deleted\)$/, '');
    return paths.some(root => path === root || path.startsWith(root + sep));
  };
  const mapped = process.platform === 'linux' ? mappedHolder(pid, paths, budget) : 'clear';
  budget?.spend();
  try { if (under(readlinkSync(`/proc/${pid}/cwd`))) return true; } catch { /* not cwd evidence */ }
  try {
    for (const fd of processEntries(`/proc/${pid}/fd`, budget)) {
      budget?.spend();
      try { if (under(readlinkSync(`/proc/${pid}/fd/${fd}`))) return true; } catch { /* closed while scanning */ }
    }
  } catch { budget?.spend(0); /* no readable fd evidence */ }
  return mapped === 'held';
}

/** Do not turn loss of access to a previously scoped Linux process into proof
 * that it released the resource. Unrelated unreadable processes do not block. */
function unreadableHolderEvidence(pid: number, budget?: AliasWorkBudget): boolean {
  for (const path of [`/proc/${pid}/cwd`, `/proc/${pid}/fd`]) {
    budget?.spend();
    try { if (path.endsWith('/fd')) processEntries(path, budget); else readlinkSync(path); }
    catch (error) { budget?.spend(0); if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return true; }
  }
  return false;
}

/** A vanished mapping belongs to an exited process; denied evidence must retain it. */
function readableMapping(pid: number, roots: readonly string[], budget?: AliasWorkBudget): boolean {
  if (process.platform !== 'linux') return true;
  const mapped = mappedHolder(pid, roots, budget);
  if (mapped === 'unreadable') throw new Error(`Cannot read evidence for destroy holder ${pid}`);
  return mapped !== 'gone';
}

/** Signal only a live incarnation that still holds an authenticated resource. */
export async function reapDestroyHolders(paths: readonly string[], assertCurrent: () => void | Promise<void>, timeoutMs = 3_000,
  retention?: DestroyAliasRetention): Promise<void> {
  const roots = paths.map(canonicalResourceRoot);
  if (process.platform === 'win32') return reapWindowsHolders(roots, assertCurrent, Math.max(timeoutMs, 30_000));
  if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error(`Destroy holder scan is unavailable on ${process.platform}`);
  const deadline = Date.now() + timeoutMs;
  const sent = new Map<number, { token: string; at: number }>();
  const scoped = new Map<number, string>();
  const budget = process.platform === 'linux' && retention ? new AliasWorkBudget() : undefined;
  for (;;) {
    await assertCurrent();
    let aliases: AliasContext | undefined;
    let candidates: number[] | undefined;
    if (process.platform === 'linux' && retention) {
      const attempt = prepareAliasScan(roots, budget!);
      const adapter = aliasRetentionAdapter(retention.read(), retention.resourceId, linuxBootId(), attempt,
        value => retention.write(value), () => verifyAliasScan(attempt));
      aliases = { attempt, ...adapter };
      candidates = linuxCandidates(budget);
    }
    const live = findHolders(roots, candidates, aliases?.attempt.budget);
    if (aliases && candidates) {
      const { attempt, scope, publish } = aliases;
      const found = await discoverAliasHolders(candidates, scope, attempt.budget, processStartToken,
        (pid, token) => scanAliases(pid, token, attempt), processGone, assertCurrent, () => verifyAliasScan(attempt), publish);
      for (const holder of found) if (!live.some(existing => existing.pid === holder.pid)) live.push(holder);
    }
    if (process.platform === 'linux') for (const [pid, token] of scoped) {
      if (live.some(holder => holder.pid === pid)) continue;
      if (processStartToken(pid) !== token) { scoped.delete(pid); continue; }
      const mapped = mappedHolder(pid, roots, aliases?.attempt.budget);
      if (mapped === 'unreadable' || unreadableHolderEvidence(pid, aliases?.attempt.budget)) {
        throw new Error(`Cannot read evidence for destroy holder ${pid}`);
      }
      scoped.delete(pid);
    }
    if (!live.length) return;
    for (const { pid, token } of live) {
      scoped.set(pid, token);
      await signalHolder(pid, token, roots, sent, assertCurrent, aliases);
    }
    if (Date.now() >= deadline) throw new Error(`Destroy holders remain: ${live.map(holder => holder.pid).join(', ')}`);
    await delay(50);
  }
}

/** The helper checks creation time and scoped handle evidence on the same
 * process handle it terminates. A failed scan is never treated as empty. */
async function reapWindowsHolders(paths: readonly string[], assertCurrent: () => void | Promise<void>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const known = new Set<number>();
  for (;;) {
    await assertCurrent();
    const holders = windowsDestroyHolders(paths).filter(holder => holder.pid !== process.pid);
    for (const pid of known) if (!holders.some(holder => holder.pid === pid)) {
      holders.push(...windowsDestroyHolders(paths, pid).filter(holder => holder.pid !== process.pid));
    }
    if (!holders.length) return;
    for (const holder of holders) {
      known.add(holder.pid);
      await assertCurrent();
      windowsStopDestroyHolder(paths, holder.pid, holder.token);
    }
    if (Date.now() >= deadline) throw new Error(`Destroy holders remain: ${holders.map(holder => holder.pid).join(', ')}`);
    await delay(50);
  }
}

function processEntries(path: string, budget?: AliasWorkBudget): string[] {
  if (!budget) return readdirSync(path);
  const directory = opendirSync(path), entries: string[] = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      budget.spend(); entries.push(entry.name);
    }
  } finally { directory.closeSync(); }
  return entries;
}

function linuxCandidates(budget?: AliasWorkBudget): number[] {
  const own = new Set(processEntries(`/proc/${process.pid}/task`, budget).map(Number));
  const candidates = new Set<number>();
  for (const entry of processEntries('/proc', budget).filter(value => /^\d+$/.test(value))) {
    const pid = Number(entry);
    candidates.add(pid);
    try { for (const tid of processEntries(`/proc/${pid}/task`, budget)) candidates.add(Number(tid)); }
    catch (error) { budget?.spend(0); if (error instanceof AliasBudgetExceeded) throw error; /* exited or unreadable */ }
  }
  return [...candidates].filter(pid => pid > 1 && !own.has(pid));
}

function processGone(pid: number): boolean {
  try {
    lstatSync(`/proc/${pid}`);
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    if (!parseProcStat(stat)) return false;
    return exitedStat(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/));
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
}

function findHolders(roots: readonly string[], preselected?: readonly number[], budget?: AliasWorkBudget): { pid: number; token: string }[] {
  if (process.platform === 'darwin') return findDarwinHolders(roots).flatMap(pid => {
    const token = processStartToken(pid);
    if (!token) { if (holds(pid, roots)) throw new Error(`Cannot verify destroy holder ${pid}`); return []; }
    return [{ pid, token }];
  });
  try {
    return (preselected ?? linuxCandidates()).flatMap(pid => {
      budget?.spend();
      const token = processStartToken(pid);
      if (!token) { if (holds(pid, roots, budget)) throw new Error(`Cannot verify destroy holder ${pid}`); return []; }
      if (!holds(pid, roots, budget) || processStartToken(pid) !== token) return [];
      return [{ pid, token }];
    });
  }
  catch (error) { throw new Error(`Cannot scan destroy holders: ${String(error)}`); }
}

/** lsof emits process and open-file names as NUL-delimited fields. Failure to
 * execute or complete the scan is an error, not an empty holder list. */
function findDarwinHolders(roots: readonly string[], pid?: number): number[] {
  const args = ['-nP', '-F0pn', ...(pid === undefined ? [] : ['-p', String(pid)])];
  const result = spawnSync('lsof', args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || (result.status !== 0 && result.status !== 1) || (pid === undefined && !result.stdout)) {
    throw new Error(`Cannot scan destroy holders: ${result.error ?? result.stderr}`);
  }
  const holders = new Set<number>();
  let current = 0;
  for (const field of result.stdout.split('\0')) {
    const value = field.replace(/^\n+/, '');
    if (value.startsWith('p')) current = Number(value.slice(1));
    if (value.startsWith('n') && current > 1 && current !== process.pid) {
      const path = value.slice(1).replace(/ \(deleted\)$/, '');
      if (roots.some(root => path === root || path.startsWith(root + sep))) holders.add(current);
    }
  }
  return [...holders];
}

async function signalHolder(pid: number, initialToken: string, roots: readonly string[], sent: Map<number, { token: string; at: number }>,
  assertCurrent: () => void | Promise<void>, aliases?: AliasContext): Promise<void> {
  await assertCurrent();
  const token = processStartToken(pid);
  if (token && token !== initialToken) return;
  if (token && !readableMapping(pid, roots, aliases?.attempt.budget)) return;
  // A process can exit between the scan and this read. Only a holder that
  // still has scoped evidence needs a readable incarnation before signalling.
  if (!token) {
    if (!holds(pid, roots, aliases?.attempt.budget)) return;
    throw new Error(`Cannot verify destroy holder ${pid}`);
  }
  const previous = sent.get(pid);
  const signal = previous?.token === token && Date.now() - previous.at >= 500 ? 'SIGKILL' : previous?.token === token ? undefined : 'SIGTERM';
  if (!signal || processStartToken(pid) !== token) return;
  let held = holds(pid, roots, aliases?.attempt.budget);
  if (aliases) {
    await assertCurrent(); verifyAliasScan(aliases.attempt);
    // Legacy path text is not enough to signal through an alias: always
    // authenticate target identity after the final asynchronous authorization.
    const evidence = scanAliases(pid, token, aliases.attempt);
    held = assessAliasEvidence(pid, token, evidence, aliases.scope, aliases.attempt.budget, aliases.publish);
    verifyAliasScan(aliases.attempt);
  }
  if (!held || processStartToken(pid) !== token) return;
  try { process.kill(pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error(`Cannot stop destroy holder ${pid}: ${String(error)}`); }
  sent.set(pid, { token, at: previous?.token === token ? previous.at : Date.now() });
}
