import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseProcStat, probeGeneration, processesWithCwdUnder, processStartToken, recordedProcessLive } from './process-liveness.ts';

const linux = process.platform === 'linux';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function child(cwd: string) {
  const proc = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(()=>{},1000)"], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>(resolve => proc.stdout!.once('data', () => resolve()));
  return { proc, exited: new Promise<void>(resolve => proc.once('exit', () => resolve())) };
}

describe('process liveness (#469)', () => {
  it('parses the start token after the last paren of a comm holding spaces and parens', () => {
    const tail = Array.from({ length: 30 }, (_, index) => String(index + 4)).join(' ');
    expect(parseProcStat(`42 (evil ) (x) y) S ${tail}`)).toEqual({ state: 'S', startToken: '22' });
    expect(parseProcStat('42 (short) S 1 2')).toBeUndefined();
    expect(parseProcStat('garbage')).toBeUndefined();
  });

  it('an unsupported platform cannot scan and has no start token', () => {
    expect(processesWithCwdUnder(tmpdir(), 'aix')).toBe('unknown');
    expect(processStartToken(process.pid, 'win32')).toBeUndefined();
  });

  it('an unreadable working directory of our own process started after the worker is a holder; older or foreign ones are skipped', () => {
    const denied = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
    const uid = process.getuid?.() ?? 1000;
    const since = Date.now();
    const proc = (owner: number, startedAt: number | undefined) => ({ readdir: () => ['7'], readlink: denied, ownerUid: () => owner, startedAtMs: () => startedAt });
    // A non-dumpable same-user process (ssh-agent, gpg-agent) spawned during the worker may hold the worktree.
    expect(processesWithCwdUnder(tmpdir(), 'linux', proc(uid, since + 5_000), since)).toEqual([7]);
    expect(processesWithCwdUnder(tmpdir(), 'linux', proc(uid, undefined), since)).toEqual([7]);
    // One that predates the worker (systemd --user, the login sshd) cannot be its descendant.
    expect(processesWithCwdUnder(tmpdir(), 'linux', proc(uid, since - 60_000), since)).toEqual([]);
    // Root and system processes are always unreadable; they cannot block every proof.
    expect(processesWithCwdUnder(tmpdir(), 'linux', proc(uid + 1, since + 5_000), since)).toEqual([]);
    const vanished = { ...proc(uid, since + 5_000), readlink: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } };
    expect(processesWithCwdUnder(tmpdir(), 'linux', vanished, since)).toEqual([]);
  });

  it.runIf(linux)('finds a real child by its working directory and loses it after exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-liveness-')); dirs.push(dir);
    const nested = join(dir, 'nested'); mkdirSync(nested);
    const since = Date.now() - 1_000;
    const { proc, exited } = await child(nested);
    try {
      expect(processesWithCwdUnder(dir)).toContain(proc.pid);
      expect(processesWithCwdUnder(`${dir}-sibling`)).not.toContain(proc.pid);
      expect(processesWithCwdUnder(dir)).not.toContain(process.pid);
      expect(probeGeneration({ paths: [dir], since })).toBe('alive');
      // One scan pass over several roots (#469: worktree plus scratch).
      expect(processesWithCwdUnder([`${dir}-sibling`, nested])).toContain(proc.pid);
    } finally { proc.kill('SIGKILL'); await exited; }
    expect(processesWithCwdUnder(dir)).not.toContain(proc.pid);
    expect(probeGeneration({ paths: [dir], since })).toBe('gone');
  });

  it.runIf(linux)('a reused PID (token mismatch) counts as gone; a matching or token-less live PID is alive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-liveness-')); dirs.push(dir);
    const since = Date.now() - 1_000;
    const { proc, exited } = await child(tmpdir());
    try {
      const token = processStartToken(proc.pid!);
      // #469: `<boot_id>:<starttime>`, so a reboot cannot replay an old incarnation's token.
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      expect(token).toBe(`${boot}:${parseProcStat(readFileSync(`/proc/${proc.pid}/stat`, 'utf8'))!.startToken}`);
      expect(recordedProcessLive({ pid: proc.pid!, startToken: token })).toBe(true);
      expect(recordedProcessLive({ pid: proc.pid! })).toBe(true);
      expect(recordedProcessLive({ pid: proc.pid!, startToken: `${token}0` })).toBe(false);
      // Liveness only: a side without the boot id compares by starttime; two boot ids must agree.
      const start = token!.split(':')[1]!;
      expect(recordedProcessLive({ pid: proc.pid!, startToken: start })).toBe(true);
      expect(recordedProcessLive({ pid: proc.pid!, startToken: `${start}0` })).toBe(false);
      expect(recordedProcessLive({ pid: proc.pid!, startToken: `00000000-0000-0000-0000-000000000000:${start}` })).toBe(false);
      const record = (processes: { pid: number; startToken?: string }[]) => ({ generation: 'g', controller: { pid: process.pid }, processes });
      expect(probeGeneration({ record: record([{ pid: proc.pid!, startToken: `${token}0` }]), paths: [dir], since })).toBe('gone');
      expect(probeGeneration({ record: record([{ pid: proc.pid!, startToken: token }]), paths: [dir], since })).toBe('alive');
      // This process as controller is never "alive": the in-memory execution map owns it.
      expect(probeGeneration({ record: record([]), paths: [dir], since })).toBe('gone');
      expect(probeGeneration({ record: { generation: 'g', controller: { pid: proc.pid!, startToken: token }, processes: [] }, paths: [dir], since })).toBe('alive');
    } finally { proc.kill('SIGKILL'); await exited; }
    expect(recordedProcessLive({ pid: proc.pid! })).toBe(false);
  });
});
