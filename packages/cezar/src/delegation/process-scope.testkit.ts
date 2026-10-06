import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
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

/** Scope enumeration commands; individual PID/token reads stay real.
 * Remember observed incarnations so reparenting cannot hide a fixture's orphan. */
function scopeDarwinProcesses(): () => void {
  const spawn = childProcess.spawnSync;
  const seen = new Map<number, string>();
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
  const capture = (command: string, commandArgs: unknown) => {
    const isPs = command === 'ps' && Array.isArray(commandArgs) &&
      commandArgs[0] === '-U' && commandArgs[1] === String(process.getuid?.()) && commandArgs[2] === '-o' &&
      commandArgs.length === 4 && ['pid=,lstart=', 'pid=,stat=,lstart='].includes(commandArgs[3]!);
    const isLsof = command === 'lsof' && Array.isArray(commandArgs) && (
      JSON.stringify(commandArgs) === JSON.stringify(['-a', '-d', 'cwd', '-Fpn']) ||
      JSON.stringify(commandArgs) === JSON.stringify(['-a', '-u', String(process.getuid?.()), '-d', 'cwd', '-Fpn']));
    if (!isPs && !isLsof) return undefined;
    const identities = snapshot();
    // Failed enumeration must remain conservative, never masquerade as an empty host.
    if (!identities) return undefined;
    return (stdout: string) => {
      const owned = new Set([process.pid]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [pid, identity] of identities) {
          if (!owned.has(pid) && (owned.has(identity.parent) || seen.get(pid) === identity.token)) {
            owned.add(pid); seen.set(pid, identity.token); changed = true;
          }
        }
      }
      let refreshed: ReturnType<typeof snapshot> | undefined;
      const include = (pid: number): boolean => {
        if (!Number.isSafeInteger(pid) || pid <= 0) return false;
        if (owned.has(pid)) return true;
        if (identities.has(pid)) return false;
        if (refreshed === undefined) refreshed = snapshot();
        if (!refreshed) return true; // no ancestry proof: leave this candidate visible
        let ancestor: number | undefined = pid;
        const visited = new Set<number>();
        while (ancestor !== undefined && ancestor > 1 && !visited.has(ancestor)) {
          const identity = refreshed.get(ancestor);
          if (owned.has(ancestor) || (identity && seen.get(ancestor) === identity.token)) {
            for (const member of visited) {
              const token = refreshed.get(member)?.token;
              if (token) { owned.add(member); seen.set(member, token); }
            }
            return true;
          }
          visited.add(ancestor); ancestor = identity?.parent;
        }
        // Match the Linux fixture: ancestry must have been observed before an
        // orphan belongs to us. A new launchd child is not a fixture descendant.
        return false;
      };
      let keep = false;
      return stdout.split('\n').filter((line: string) => {
        if (isPs) return include(Number(/^\s*(\d+)/.exec(line)?.[1]));
        if (line.startsWith('p')) keep = include(Number(line.slice(1)));
        return keep;
      }).join('\n');
    };
  };
  const scope = vi.spyOn(childProcess, 'spawnSync').mockImplementation(((...args: Parameters<typeof spawn>) => {
    const filter = capture(args[0], args[1]);
    const result = Reflect.apply(spawn, childProcess, args);
    if (!filter || result.error || typeof result.stdout !== 'string') return result;
    const stdout = filter(result.stdout);
    return { ...result, stdout, output: [result.output[0], stdout, result.output[2]] };
  }) as typeof spawn);
  // Autosave uses async enumeration so its holder scan cannot stall kill timers.
  // Keep the real ChildProcess, scheduling, errors and individual PID queries.
  const exec = childProcess.execFile;
  const asyncScope = vi.spyOn(childProcess, 'execFile').mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1);
    const filter = capture(String(args[0]), args[1]);
    if (!filter || typeof callback !== 'function') return Reflect.apply(exec, childProcess, args);
    const wrapped = (error: childProcess.ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
      const ordinaryLsofExit = args[0] === 'lsof' && error?.code === 1 && !error.killed;
      callback(error, typeof stdout === 'string' && (!error || ordinaryLsofExit) ? filter(stdout) : stdout, stderr);
    };
    return Reflect.apply(exec, childProcess, [...args.slice(0, -1), wrapped]);
  }) as typeof exec);
  const custom = Object.getOwnPropertyDescriptor(exec, promisify.custom);
  if (custom) Object.defineProperty(asyncScope, promisify.custom, custom);
  syncBuiltinESMExports();
  return () => { asyncScope.mockRestore(); scope.mockRestore(); syncBuiltinESMExports(); };
}
