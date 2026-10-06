import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { vi } from 'vitest';
import { fixtureProcessEnumeration } from './process-enumeration.testkit.ts';

/** Enumerate the fixture's process tree, including observed children subsequently orphaned.
 * Host daemons and parallel test workers are outside this fixture. Tokens/cwd/permissions are
 * real. Tests of arbitrary enumeration/denial use the injectable reader or their own scope. */
export function scopeFixtureProcesses(platform: NodeJS.Platform = process.platform): () => void {
  if (platform === 'darwin') return scopeDarwinProcesses();
  if (platform !== 'linux') return () => {};
  const enumerate = fixtureProcessEnumeration();
  const scope = vi.spyOn(fs, 'readdirSync').mockImplementation(enumerate);
  syncBuiltinESMExports();
  return () => { scope.mockRestore(); syncBuiltinESMExports(); };
}

/** Scope only the two enumeration commands; individual PID/token reads stay real.
 * Remember observed incarnations so reparenting cannot hide a fixture's orphan. */
function scopeDarwinProcesses(): () => void {
  const spawn = childProcess.spawnSync;
  const seen = new Map<number, string>();
  const uncertain = new Set<number>();
  const snapshot = () => {
    const result = spawn('ps', ['-axo', 'pid=,ppid=,lstart='], {
      encoding: 'utf8', timeout: 2_000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    });
    if (result.status !== 0 || !result.stdout) return null;
    const identities = new Map<number, { parent: number; token: string }>();
    for (const line of result.stdout.trim().split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (!match) return null;
      identities.set(Number(match[1]), { parent: Number(match[2]), token: match[3]! });
    }
    return identities;
  };
  const enumeration = (command: unknown, commandArgs: unknown): 'ps' | 'lsof' | undefined => {
    const isPs = command === 'ps' && Array.isArray(commandArgs) &&
      commandArgs[0] === '-U' && commandArgs[1] === String(process.getuid?.()) && commandArgs[2] === '-o' &&
      commandArgs.length === 4 && ['pid=,lstart=', 'pid=,stat=,lstart='].includes(commandArgs[3]!);
    const isLsof = command === 'lsof' && Array.isArray(commandArgs) &&
      [ ['-a', '-d', 'cwd', '-Fpn'], ['-a', '-u', String(process.getuid?.()), '-d', 'cwd', '-Fpn'] ]
        .some(expected => JSON.stringify(commandArgs) === JSON.stringify(expected));
    return isPs ? 'ps' : isLsof ? 'lsof' : undefined;
  };
  const filter = (identities: ReturnType<typeof snapshot>, input: string, kind: 'ps' | 'lsof'): string => {
    // Failed enumeration must remain conservative, never masquerade as an empty host.
    if (!identities) return input;
    const owned = new Set([process.pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, identity] of identities) {
        if (!owned.has(pid) && (owned.has(identity.parent) || seen.get(pid) === identity.token || uncertain.has(pid))) {
          owned.add(pid); seen.set(pid, identity.token); uncertain.delete(pid); changed = true;
        }
      }
    }
    let refreshed: ReturnType<typeof snapshot> | undefined;
    const include = (pid: number): boolean => {
      if (!Number.isSafeInteger(pid) || pid <= 0) return false;
      if (owned.has(pid)) return true;
      if (identities.has(pid)) return false;
      if (refreshed === undefined) refreshed = snapshot();
      if (refreshed) {
        let parent = refreshed.get(pid)?.parent;
        const visited = new Set<number>();
        while (parent !== undefined && parent > 1 && !visited.has(parent)) {
          if (owned.has(parent)) break;
          // A newly born child of a known ambient process is outside the fixture.
          // A newly orphaned process (ppid 1) has no such proof and stays included.
          if (identities.has(parent)) return false;
          visited.add(parent); parent = refreshed.get(parent)?.parent;
        }
      }
      // A child can be born after the ancestry snapshot and orphaned before the
      // next one. Keep unknown membership, including across later scans, rather
      // than turn a real holder into a false "gone" result.
      const token = refreshed?.get(pid)?.token;
      if (token) seen.set(pid, token);
      else {
        // Enumeration tools and other short-lived children can already be gone.
        // Only ESRCH proves that; permission errors keep membership uncertain.
        try { process.kill(pid, 0); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        }
        uncertain.add(pid);
      }
      return true;
    };
    let keep = false;
    return input.split('\n').filter((line: string) => {
      if (kind === 'ps') return include(Number(/^\s*(\d+)/.exec(line)?.[1]));
      if (line.startsWith('p')) keep = include(Number(line.slice(1)));
      return keep;
    }).join('\n');
  };
  const scope = vi.spyOn(childProcess, 'spawnSync').mockImplementation(((...args: Parameters<typeof spawn>) => {
    const kind = enumeration(args[0], args[1]);
    if (!kind) return Reflect.apply(spawn, childProcess, args);
    const identities = snapshot();
    const result = Reflect.apply(spawn, childProcess, args);
    if (result.error || typeof result.stdout !== 'string') return result;
    const stdout = filter(identities, result.stdout, kind);
    return { ...result, stdout, output: [result.output[0], stdout, result.output[2]] };
  }) as typeof spawn);
  // Autosave uses the same enumeration asynchronously so it cannot block other
  // runners' kill timers. Scope its output too, preserving the real callback.
  const execute = childProcess.execFile;
  const asyncScope = vi.spyOn(childProcess, 'execFile').mockImplementation(((...args: unknown[]) => {
    const kind = enumeration(args[0], args[1]);
    const callback = args.at(-1);
    if (!kind || typeof callback !== 'function') return Reflect.apply(execute, childProcess, args);
    const identities = snapshot();
    args[args.length - 1] = (error: NodeJS.ErrnoException | null, stdout: string | Buffer, stderr: string | Buffer) => {
      const canFilter = !error || (kind === 'lsof' && Number(error.code) === 1);
      callback(error, canFilter && typeof stdout === 'string' ? filter(identities, stdout, kind) : stdout, stderr);
    };
    return Reflect.apply(execute, childProcess, args);
  }) as typeof execute);
  syncBuiltinESMExports();
  return () => { scope.mockRestore(); asyncScope.mockRestore(); syncBuiltinESMExports(); };
}
