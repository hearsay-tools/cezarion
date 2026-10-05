import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nonDumpableHolder } from './non-dumpable.testkit.ts';
import { inspectExecutionGeneration, parseProcStat, probeGeneration, processesWithCwdUnder, processStartToken, recordedProcessLive } from './process-liveness.ts';

// Scope only enumeration to the processes this fixture owns. A full-host scan may
// conservatively include an unrelated same-user process whose cwd is unreadable.
// Keep cwd/stat/token reads real, including ENOENT after our child has exited;
// the injected-reader cases below cover unreadable holders separately.
const procScope = vi.hoisted(() => ({ entries: undefined as string[] | undefined, boot: undefined as string | null | undefined }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (args[0] === '/proc/sys/kernel/random/boot_id' && procScope.boot !== undefined) {
        if (procScope.boot === null) throw Object.assign(Error('unreadable boot ID'), { code: 'EACCES' });
        return procScope.boot;
      }
      return actual.readFileSync(...args);
    },
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) =>
      args[0] === '/proc' && procScope.entries ? procScope.entries : actual.readdirSync(...args),
  };
});

const linux = process.platform === 'linux';
const dirs: string[] = [];
afterEach(() => {
  procScope.entries = undefined; procScope.boot = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function child(cwd: string) {
  const proc = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(()=>{},1000)"], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>(resolve => proc.stdout!.once('data', () => resolve()));
  procScope.entries = [String(process.pid), String(proc.pid!)];
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

  it('darwin: an own-user process lsof could not read counts like an unreadable Linux one', () => {
    const since = Date.now();
    const linuxUnused = { readdir: () => [], readlink: () => '', ownerUid: () => undefined, startedAtMs: () => undefined };
    const dir = tmpdir();
    const darwin = (stdout: string, own: { pid: number; startedAtMs?: number }[] | undefined, ok = true) => ({ lsof: () => ({ ok, stdout }), ownProcesses: () => own });
    const lsof = `p10\nn/\np11\nn${dir}\n`;
    // lsof saw 10 and 11; 12 is ours but absent from its output, so its cwd is unknown.
    expect(processesWithCwdUnder(dir, 'darwin', linuxUnused, since, darwin(lsof, [{ pid: 10 }, { pid: 11 }, { pid: 12, startedAtMs: since + 5_000 }]))).toEqual([11, 12]);
    expect(processesWithCwdUnder(dir, 'darwin', linuxUnused, since, darwin(lsof, [{ pid: 12 }]))).toEqual([11, 12]);
    // Older than the worker: cannot be its descendant.
    expect(processesWithCwdUnder(dir, 'darwin', linuxUnused, since, darwin(lsof, [{ pid: 12, startedAtMs: since - 60_000 }]))).toEqual([11]);
    // Completeness cannot be judged without our own process list, and a failed lsof proves nothing.
    expect(processesWithCwdUnder(dir, 'darwin', linuxUnused, since, darwin(lsof, undefined))).toBe('unknown');
    expect(processesWithCwdUnder(dir, 'darwin', linuxUnused, since, darwin('', [], false))).toBe('unknown');
  });

  const oldBoot = '11111111-1111-4111-8111-111111111111';
  const deniedProc = (code = 'EACCES') => ({
    readdir: () => ['7'], readlink: () => { throw Object.assign(new Error(code), { code }); },
    ownerUid: () => process.getuid?.(), startedAtMs: () => 30_000,
  });

  it.each(['EACCES', 'EPERM'])('retains %s resource candidates alongside readable holders (#738)', code => {
    const proc = { ...deniedProc(code), readdir: () => ['7', '8', '9'], readlink: (pid: string) => {
      if (pid === '7') return deniedProc(code).readlink();
      return pid === '8' ? '/worker/nested' : '/scratch';
    } };
    expect(processesWithCwdUnder(['/worker', '/scratch'], 'linux', proc, 10_000)).toEqual([7, 8, 9]);
  });

  it('unknown cwd ownership never removes an unresolved resource candidate', () => {
    expect(processesWithCwdUnder(['/worker', '/scratch'], 'linux', { ...deniedProc(), ownerUid: () => undefined }, undefined)).toEqual([7]);
  });

  it('retains conservative fallback on unexpected cwd errors or unreadable proc', () => {
    expect(processesWithCwdUnder('/worker', 'linux', deniedProc('EIO'), 10_000)).toEqual([7]);
    const proc = { ...deniedProc(), readdir: () => { throw Error('unreadable /proc'); } };
    expect(processesWithCwdUnder('/worker', 'linux', proc, 10_000)).toBe('unknown');
  });

  it.runIf(linux)('retains a real non-dumpable holder despite prior-boot execution evidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-hidden-holder-')); dirs.push(dir);
    const holder = await nonDumpableHolder(dir);
    procScope.entries = [String(holder.pid)];
    const input = { paths: [dir], record: { generation: 'g', controller: { pid: 2147483001, startToken: `${oldBoot}:100` }, processes: [] } };
    try {
      expect(probeGeneration({ ...input, since: Date.now() + 60_000 })).toBe('alive');
      expect(inspectExecutionGeneration(input).liveness).toBe('gone');
      expect(inspectExecutionGeneration({ ...input, pathsComplete: false }).liveness).toBe('gone');
      await holder.write();
      expect(readFileSync(join(dir, 'holder-writes'), 'utf8')).toContain('still writable');
    } finally { await holder.close(); }
    expect(probeGeneration(input)).toBe('gone');
  });

  it.runIf(linux).each(['absent record', 'missing token', 'legacy token', 'malformed token', 'same boot', 'unknown boot', 'malformed boot'])('keeps conservative execution proof with %s', async shape => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-legacy-holder-')); dirs.push(dir);
    const holder = await nonDumpableHolder(dir); procScope.entries = [String(holder.pid)];
    const currentBoot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (shape === 'unknown boot') procScope.boot = null;
    if (shape === 'malformed boot') procScope.boot = 'invalid';
    const token = shape === 'legacy token' ? '100' : shape === 'malformed token' ? 'malformed:100'
      : shape === 'same boot' ? `${currentBoot}:100` : shape === 'missing token' ? undefined : `${oldBoot}:100`;
    vi.resetModules();
    const { inspectExecutionGeneration: executionProbe } = await import('./process-liveness.ts');
    const input = { paths: [dir], since: 0, ...(shape === 'absent record' ? {} : { record: {
      generation: 'g', controller: { pid: 2147483001, startToken: token }, processes: [],
    } }) };
    try {
      expect(executionProbe(input).liveness).toBe('alive');
      expect(executionProbe({ ...input, pathsComplete: false }).liveness).toBe('alive');
    } finally { await holder.close(); }
    expect(executionProbe({ ...input, pathsComplete: false }).liveness).toBe('unknown');
    expect(executionProbe(input).liveness).toBe('gone');
  });

  it.runIf(linux)('separates unknown same-boot candidates from live execution evidence (hearsay-tools/cezarion#839)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-same-boot-')); dirs.push(dir);
    const ambient = await nonDumpableHolder(tmpdir()); procScope.entries = [String(ambient.pid)];
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const input = { paths: [dir], pathsComplete: true, since: 0, record: {
      generation: 'g', controller: { pid: 2147483001, startToken: `${boot}:100` },
      processes: [{ pid: ambient.pid, startToken: `${boot}:1` }], // reused old PID, not this daemon
    } };
    try {
      expect(inspectExecutionGeneration(input)).toMatchObject({ liveness: 'unknown', pids: [], abandonable: true });
      expect(probeGeneration(input)).toBe('alive'); // no deletion authority
      expect(inspectExecutionGeneration({ ...input, pathsComplete: false })).not.toHaveProperty('abandonable', true);
      expect(inspectExecutionGeneration({ ...input, record: { ...input.record, processes: [{ pid: ambient.pid, startToken: processStartToken(ambient.pid) }] } })).toMatchObject({ liveness: 'alive', pids: [ambient.pid] });
      await ambient.write();
    } finally { await ambient.close(); }
    expect(inspectExecutionGeneration(input).liveness).toBe('gone');
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
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      expect(inspectExecutionGeneration({ paths: [dir], pathsComplete: true, since,
        record: { generation: 'g', controller: { pid: 2147483001, startToken: `${boot}:100` }, processes: [] } }))
        .toMatchObject({ liveness: 'alive', pids: [proc.pid] }); // verified readable holder, never abandonment
      // Reboot proof only excludes unreadable possible descendants, never an actual cwd holder.
      expect(probeGeneration({ paths: [dir], since: 0,
        record: { generation: 'g', controller: { pid: 2147483001, startToken: `${oldBoot}:100` }, processes: [] } })).toBe('alive');
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
      // Even with a previous-boot controller, a verified live record blocks independently of cwd.
      for (const inspect of [probeGeneration, (input: Parameters<typeof inspectExecutionGeneration>[0]) => inspectExecutionGeneration(input).liveness]) {
        expect(inspect({ paths: [dir], since: 0, record: { generation: 'g',
          controller: { pid: 2147483001, startToken: `${oldBoot}:100` }, processes: [{ pid: proc.pid!, startToken: token }] } })).toBe('alive');
        expect(inspect({ paths: [dir], record: { generation: 'g', controller: { pid: proc.pid!, startToken: token }, processes: [] } })).toBe('alive');
      }
      // This process as controller is never "alive": the in-memory execution map owns it.
      expect(probeGeneration({ record: record([]), paths: [dir], since })).toBe('gone');
      expect(probeGeneration({ record: { generation: 'g', controller: { pid: proc.pid!, startToken: token }, processes: [] }, paths: [dir], since })).toBe('alive');
    } finally { proc.kill('SIGKILL'); await exited; }
    expect(recordedProcessLive({ pid: proc.pid! })).toBe(false);
  });
});
