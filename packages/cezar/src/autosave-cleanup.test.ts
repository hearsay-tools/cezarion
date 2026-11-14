import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { autosaveCleanupBlocker, autosaveCleanupIds, clearAutosaveCleanup, retainAutosaveCleanup } from './autosave-cleanup.ts';
import { processStartToken } from './delegation/process-liveness.ts';
import * as liveness from './delegation/process-liveness.ts';

const fixtures: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cez-autosave-proof-')); fixtures.push(dataDir);
  mkdirSync(join(dataDir, 'runs'));
  const id = randomUUID(), path = join(dataDir, 'runs', `${id}.autosave-cleanup.json`);
  const deadOwner = () => {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    record.controller.startToken = 'different incarnation';
    writeFileSync(path, JSON.stringify(record));
  };
  return { dataDir, id, path, deadOwner };
}

describe('durable autosave cleanup', () => {
  it('a live controller holds an empty proof until strict cleanup clears it', () => {
    const { dataDir, id } = fixture();
    retainAutosaveCleanup(dataDir, id, dataDir, 'still observing', { processes: [], groups: [], uncertain: false });
    expect(autosaveCleanupBlocker(dataDir, id)).toBe('still observing');
    clearAutosaveCleanup(dataDir, id);
    expect(autosaveCleanupBlocker(dataDir, id)).toBeUndefined();
  });

  it('retains an observed holder outside the worktree after controller death, then self-heals at exit', async () => {
    const { dataDir, id, path, deadOwner } = fixture();
    // This holder's cwd is already outside the recorded tree; only its identity protects it.
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: tmpdir(), stdio: 'ignore' });
    const exited = new Promise(resolve => holder.once('exit', resolve));
    try {
      retainAutosaveCleanup(dataDir, id, dataDir, 'holder pending', {
        processes: [{ pid: holder.pid!, startToken: processStartToken(holder.pid!) }], groups: [], uncertain: false,
      });
      deadOwner();
      expect(autosaveCleanupBlocker(dataDir, id)).toContain(String(holder.pid));
      expect(existsSync(path)).toBe(true);
    } finally { holder.kill('SIGKILL'); await exited; }
    expect(autosaveCleanupBlocker(dataDir, id)).toBeUndefined();
    expect(existsSync(path)).toBe(true); // Admission proofs are read-only.
  });

  it('an unproven process group blocks after controller death until the kernel confirms ESRCH', () => {
    const { dataDir, id, deadOwner } = fixture();
    const group = 2_000_000_000;
    retainAutosaveCleanup(dataDir, id, dataDir, 'group pending', { processes: [], groups: [group], uncertain: false });
    deadOwner();
    const kill = process.kill.bind(process);
    let code = 'EPERM';
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid !== -group) return kill(pid, signal);
      expect(signal).toBe(0); // Durable recovery observes; it never signals an unproven group.
      throw Object.assign(new Error(code), { code });
    });
    expect(autosaveCleanupBlocker(dataDir, id)).toContain(String(group));
    code = 'ESRCH';
    expect(autosaveCleanupBlocker(dataDir, id)).toBeUndefined();
  });

  it('a zombie-only group does not keep a dead controller guard forever', () => {
    const { dataDir, id, deadOwner } = fixture();
    const group = 2_000_000_000;
    retainAutosaveCleanup(dataDir, id, dataDir, 'group pending', { processes: [], groups: [group], uncertain: false });
    deadOwner();
    const kill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => pid === -group ? true : kill(pid, signal));
    const read = fs.readFileSync, list = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((...args: unknown[]) => String(args[0]) === '/proc' ? ['123456'] : Reflect.apply(list, fs, args)) as typeof fs.readdirSync);
    vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: unknown[]) => String(args[0]) === '/proc/123456/stat'
      ? `123456 (defunct) Z 1 ${group} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 10`
      : Reflect.apply(read, fs, args)) as typeof fs.readFileSync);
    vi.spyOn(liveness, 'processesWithCwdUnder').mockReturnValue([]);
    expect(autosaveCleanupBlocker(dataDir, id)).toBeUndefined();
  });

  it('a different recorded boot retires old group numbers while still checking fresh cwd holders', () => {
    const { dataDir, id, path } = fixture();
    const group = 2_000_000_000;
    retainAutosaveCleanup(dataDir, id, dataDir, 'old boot', { processes: [], groups: [group], uncertain: false });
    const record = JSON.parse(readFileSync(path, 'utf8'));
    record.controller.startToken = '00000000-0000-0000-0000-000000000000:1';
    writeFileSync(path, JSON.stringify(record));
    const kill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid !== -group) return kill(pid, signal);
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    const scan = vi.spyOn(liveness, 'processesWithCwdUnder').mockReturnValue([123]);
    expect(autosaveCleanupBlocker(dataDir, id)).toContain('123');
    scan.mockReturnValue([]);
    expect(autosaveCleanupBlocker(dataDir, id)).toBeUndefined();
  });

  it.runIf(process.platform === 'linux')('after controller death, a holder that started before the save does not block; a later one does, named by command (hearsay-tools/squawk#963)', async () => {
    const { dataDir, id, deadOwner } = fixture();
    const exits = new Map<ReturnType<typeof spawn>, Promise<unknown>>();
    const start = () => {
      // A clean environment carries no autosave marker: after a crash that proves nothing.
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dataDir, stdio: 'ignore', env: { PATH: process.env.PATH } });
      exits.set(child, new Promise(resolve => child.once('exit', resolve)));
      return child;
    };
    const stop = (child: ReturnType<typeof spawn>) => { child.kill('SIGKILL'); return exits.get(child); };
    const ticks = (pid: number) => Number(processStartToken(pid)!.split(':').at(-1));
    try {
      const before = start();
      // The save's first Git leader: a process at least one clock tick younger than `before`.
      let leader = start();
      while (ticks(leader.pid!) <= ticks(before.pid!)) { await stop(leader); leader = start(); }
      retainAutosaveCleanup(dataDir, id, dataDir, 'held', { processes: [], groups: [], uncertain: false, since: processStartToken(leader.pid!) });
      await stop(leader);
      deadOwner();
      expect(autosaveCleanupBlocker(dataDir, id)).toBeUndefined();
      const after = start();
      const blocker = autosaveCleanupBlocker(dataDir, id);
      expect(blocker).toContain(`${after.pid} (${basename(process.execPath)})`);
      expect(blocker).not.toContain(String(before.pid));
    } finally {
      await Promise.all([...exits.keys()].map(stop));
    }
  });

  it('an unreadable cwd scan cannot retire a dead controller proof', () => {
    const { dataDir, id, deadOwner } = fixture();
    retainAutosaveCleanup(dataDir, id, dataDir, 'inspection pending', { processes: [], groups: [], uncertain: false });
    deadOwner();
    vi.spyOn(liveness, 'processesWithCwdUnder').mockReturnValue('unknown');
    expect(autosaveCleanupBlocker(dataDir, id)).toContain('inspection uncertain');
  });

  it('a stale dead-owner probe never removes a newer cleanup guard published during its scan', () => {
    const { dataDir, id, deadOwner } = fixture();
    retainAutosaveCleanup(dataDir, id, dataDir, 'old', { processes: [], groups: [], uncertain: false });
    deadOwner();
    vi.spyOn(liveness, 'processesWithCwdUnder').mockImplementationOnce(() => {
      retainAutosaveCleanup(dataDir, id, dataDir, 'replacement writer', { processes: [], groups: [], uncertain: false });
      return [];
    });
    autosaveCleanupBlocker(dataDir, id);
    expect(autosaveCleanupBlocker(dataDir, id)).toBe('replacement writer');
  });

  it('expired evidence stops reserving orphan scratch without deleting the evidence during a read', () => {
    const { dataDir, id, path, deadOwner } = fixture();
    retainAutosaveCleanup(dataDir, id, dataDir, 'held', { processes: [], groups: [], uncertain: false });
    expect(autosaveCleanupIds(dataDir)).toEqual([id]);
    deadOwner();
    expect(autosaveCleanupIds(dataDir)).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  it('malformed evidence blocks rather than disappearing', () => {
    const { dataDir, id, path } = fixture();
    writeFileSync(path, '{');
    expect(autosaveCleanupBlocker(dataDir, id)).toContain('unreadable');
    expect(existsSync(path)).toBe(true);
  });
});
