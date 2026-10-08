import childProcess, { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nonDumpableHolder, readableHolder } from './non-dumpable.testkit.ts';
import { inspectExecutionGeneration, inspectGeneration, parseProcStat, probeGeneration, processesWithCwdUnder, processStartToken, recordedGroupSignalable, recordedProcessLive, scanProcessCwds, sharedCwdScan, processCwdUnder } from './process-liveness.ts';

// Scope only enumeration to the processes this fixture owns, so host processes never enter a scan.
// Keep cwd/stat/token reads real, including ENOENT after our child has exited;
// the injected-reader cases below cover unreadable cwds separately.
const procScope = vi.hoisted(() => ({
  entries: undefined as string[] | undefined, boot: undefined as string | null | undefined,
  /** How many times `/proc` was listed: one listing is one full scan (hearsay-tools/cezarion#879). */
  listings: 0,
}));
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
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      if (args[0] === '/proc') procScope.listings++;
      return args[0] === '/proc' && procScope.entries ? procScope.entries : actual.readdirSync(...args);
    },
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

  it('win32 has no cwd scan and answers no holders: recorded processes and the checked removal decide (hearsay-tools/cezarion#889)', () => {
    const unused = () => { throw Error('win32 never reads /proc'); };
    expect(processesWithCwdUnder(tmpdir(), 'win32', { readdir: unused, readlink: unused }, { lsof: unused })).toEqual([]);
  });

  it.each(['EACCES', 'EPERM', 'ENOENT', 'EIO'])('an unreadable working directory (%s) is no evidence, whoever owns the process (hearsay-tools/cezarion#889)', code => {
    const denied = () => { throw Object.assign(new Error(code), { code }); };
    expect(processesWithCwdUnder('/worker', 'linux', { readdir: () => ['7'], readlink: denied })).toEqual([]);
    // A readable holder beside it still blocks, under every protected path.
    const mixed = { readdir: () => ['7', '8', '9', '10'], readlink: (pid: string) =>
      pid === '7' ? denied() : pid === '8' ? '/worker/nested' : pid === '9' ? '/scratch' : '/elsewhere' };
    expect(processesWithCwdUnder(['/worker', '/scratch'], 'linux', mixed)).toEqual([8, 9]);
  });

  it('only a /proc that cannot be listed is unknown', () => {
    const proc = { readdir: () => { throw Error('unreadable /proc'); }, readlink: () => '/worker' };
    expect(processesWithCwdUnder('/worker', 'linux', proc)).toBe('unknown');
  });

  it('darwin: lsof alone names holders; a process it could not read is no evidence (hearsay-tools/cezarion#889)', () => {
    const linuxUnused = { readdir: () => [], readlink: () => '' };
    const dir = tmpdir();
    const darwin = (stdout: string, ok = true) => ({ lsof: () => ({ ok, stdout }) });
    // lsof saw 10 and 11; any other process of ours is absent from its output and holds nothing.
    expect(processesWithCwdUnder(dir, 'darwin', linuxUnused, darwin(`p10\nn/\np11\nn${dir}\n`))).toEqual([11]);
    // A failed lsof proves nothing.
    expect(processesWithCwdUnder(dir, 'darwin', linuxUnused, darwin('', false))).toBe('unknown');
  });

  it('darwin: the scan runs lsof and never reads a process table', () => {
    let failed = false;
    const spy = vi.spyOn(childProcess, 'spawnSync').mockImplementation(((command: string) => {
      if (command !== 'lsof') throw Error(`unexpected ${command}`);
      // Status 1 is ordinary: lsof could not read some process.
      const stdout = 'p10\nn/\np13\nn/worker/nested\n';
      return { pid: 14, status: failed ? 2 : 1, signal: null, stdout, stderr: '', output: [null, stdout, ''] };
    }) as typeof childProcess.spawnSync);
    syncBuiltinESMExports();
    try {
      expect(processesWithCwdUnder('/worker', 'darwin')).toEqual([13]);
      failed = true;
      expect(processesWithCwdUnder('/worker', 'darwin')).toBe('unknown');
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  });

  const oldBoot = '11111111-1111-4111-8111-111111111111';

  it.runIf(linux)('a real non-dumpable process is no evidence for either proof, while it keeps running (hearsay-tools/cezarion#889)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-hidden-holder-')); dirs.push(dir);
    const holder = await nonDumpableHolder(dir);
    procScope.entries = [String(holder.pid)];
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    try {
      expect(processesWithCwdUnder(dir)).toEqual([]);
      expect(inspectGeneration({ paths: [dir] })).toEqual({ liveness: 'gone', pids: [] });
      for (const controller of [`${oldBoot}:100`, `${boot}:100`]) {
        const input = { paths: [dir], pathsComplete: true, record: { generation: 'g', controller: { pid: 2147483001, startToken: controller }, processes: [] } };
        expect(probeGeneration(input)).toBe('gone');
        // A same-boot crash settles as gone: nothing is abandoned any more.
        expect(inspectExecutionGeneration(input)).toEqual({ liveness: 'gone', pids: [] });
      }
      // Unknown scratch locations still keep a clear legacy scan from proving termination.
      expect(inspectExecutionGeneration({ paths: [dir], pathsComplete: false }).liveness).toBe('unknown');
      await holder.write();
      expect(readFileSync(join(dir, 'holder-writes'), 'utf8')).toContain('still writable');
    } finally { await holder.close(); }
  });

  it.runIf(linux).each(['absent record', 'missing token', 'legacy token', 'malformed token', 'same boot', 'unknown boot', 'malformed boot'])('keeps the readable-holder execution scan with %s', async shape => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-legacy-holder-')); dirs.push(dir);
    const holder = await readableHolder(dir); procScope.entries = [String(holder.pid)];
    const currentBoot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (shape === 'unknown boot') procScope.boot = null;
    if (shape === 'malformed boot') procScope.boot = 'invalid';
    const token = shape === 'legacy token' ? '100' : shape === 'malformed token' ? 'malformed:100'
      : shape === 'same boot' ? `${currentBoot}:100` : shape === 'missing token' ? undefined : `${oldBoot}:100`;
    vi.resetModules();
    const { inspectExecutionGeneration: executionProbe } = await import('./process-liveness.ts');
    const input = { paths: [dir], ...(shape === 'absent record' ? {} : { record: {
      generation: 'g', controller: { pid: 2147483001, startToken: token }, processes: [],
    } }) };
    try {
      expect(executionProbe(input)).toEqual({ liveness: 'alive', pids: [holder.pid] });
      expect(executionProbe({ ...input, pathsComplete: false }).liveness).toBe('alive');
    } finally { await holder.close(); }
    expect(executionProbe({ ...input, pathsComplete: false }).liveness).toBe('unknown');
    expect(executionProbe(input).liveness).toBe('gone');
  });

  it.runIf(linux)('a live recorded process blocks even when its cwd is unreadable; a reused PID does not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-same-boot-')); dirs.push(dir);
    const recorded = await nonDumpableHolder(tmpdir()); procScope.entries = [String(recorded.pid)];
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const input = (startToken: string | undefined) => ({ paths: [dir], pathsComplete: true, record: {
      generation: 'g', controller: { pid: 2147483001, startToken: `${boot}:100` },
      processes: [{ pid: recorded.pid, ...(startToken ? { startToken } : {}) }],
    } });
    try {
      // The old incarnation of a reused PID, not this process.
      expect(inspectExecutionGeneration(input(`${boot}:1`))).toEqual({ liveness: 'gone', pids: [] });
      expect(probeGeneration(input(`${boot}:1`))).toBe('gone');
      for (const live of [processStartToken(recorded.pid), undefined]) {
        expect(inspectExecutionGeneration(input(live))).toEqual({ liveness: 'alive', pids: [recorded.pid] });
        expect(inspectGeneration(input(live))).toEqual({ liveness: 'alive', pids: [recorded.pid] });
      }
      await recorded.write();
    } finally { await recorded.close(); }
    expect(inspectGeneration(input(undefined)).liveness).toBe('gone');
  });

  it.runIf(linux)('finds a real child by its working directory and loses it after exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-liveness-')); dirs.push(dir);
    const nested = join(dir, 'nested'); mkdirSync(nested);
    const { proc, exited } = await child(nested);
    try {
      expect(processesWithCwdUnder(dir)).toContain(proc.pid);
      expect(processesWithCwdUnder(`${dir}-sibling`)).not.toContain(proc.pid);
      expect(processesWithCwdUnder(dir)).not.toContain(process.pid);
      expect(probeGeneration({ paths: [dir] })).toBe('alive');
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      expect(inspectExecutionGeneration({ paths: [dir], pathsComplete: true,
        record: { generation: 'g', controller: { pid: 2147483001, startToken: `${boot}:100` }, processes: [] } }))
        .toMatchObject({ liveness: 'alive', pids: [proc.pid] });
      // Reboot proof settles execution only; the resource proof still sees an actual cwd holder.
      expect(probeGeneration({ paths: [dir],
        record: { generation: 'g', controller: { pid: 2147483001, startToken: `${oldBoot}:100` }, processes: [] } })).toBe('alive');
      // One scan pass over several roots (#469: worktree plus scratch).
      expect(processesWithCwdUnder([`${dir}-sibling`, nested])).toContain(proc.pid);
    } finally { proc.kill('SIGKILL'); await exited; }
    expect(processesWithCwdUnder(dir)).not.toContain(proc.pid);
    expect(probeGeneration({ paths: [dir] })).toBe('gone');
  });

  it.runIf(linux)('a reused PID (token mismatch) counts as gone; a matching or token-less live PID is alive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-liveness-')); dirs.push(dir);
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
      expect(probeGeneration({ record: record([{ pid: proc.pid!, startToken: `${token}0` }]), paths: [dir] })).toBe('gone');
      expect(probeGeneration({ record: record([{ pid: proc.pid!, startToken: token }]), paths: [dir] })).toBe('alive');
      // Even with a previous-boot controller, a verified live record blocks independently of cwd.
      for (const inspect of [probeGeneration, (input: Parameters<typeof inspectExecutionGeneration>[0]) => inspectExecutionGeneration(input).liveness]) {
        expect(inspect({ paths: [dir], record: { generation: 'g',
          controller: { pid: 2147483001, startToken: `${oldBoot}:100` }, processes: [{ pid: proc.pid!, startToken: token }] } })).toBe('alive');
        expect(inspect({ paths: [dir], record: { generation: 'g', controller: { pid: proc.pid!, startToken: token }, processes: [] } })).toBe('alive');
      }
      // This process as controller is never "alive": the in-memory execution map owns it.
      expect(probeGeneration({ record: record([]), paths: [dir] })).toBe('gone');
      expect(probeGeneration({ record: { generation: 'g', controller: { pid: proc.pid!, startToken: token }, processes: [] }, paths: [dir] })).toBe('alive');
    } finally { proc.kill('SIGKILL'); await exited; }
    expect(recordedProcessLive({ pid: proc.pid! })).toBe(false);
  });
});

describe('shared cwd snapshot (hearsay-tools/cezarion#879)', () => {
  it.runIf(linux)('answers exactly as a fresh scan', async () => {
    const held = mkdtempSync(join(tmpdir(), 'cez-snapshot-held-')); dirs.push(held);
    const free = mkdtempSync(join(tmpdir(), 'cez-snapshot-free-')); dirs.push(free);
    const { proc, exited } = await child(held);
    try {
      const snapshot = scanProcessCwds();
      expect(processesWithCwdUnder([held], 'linux', undefined, undefined, snapshot)).toEqual([proc.pid]);
      expect(processesWithCwdUnder([held], 'linux', undefined, undefined, snapshot)).toEqual(processesWithCwdUnder([held]));
      expect(inspectGeneration({ paths: [held], cwds: () => snapshot })).toEqual(inspectGeneration({ paths: [held] }));
      expect(inspectGeneration({ paths: [free], cwds: () => snapshot })).toEqual({ liveness: 'gone', pids: [] });
    } finally { proc.kill(); await exited; }
  });

  it.runIf(linux)('many questions in one tick cost one /proc listing, taken only when asked', async () => {
    const [a, b, c] = ['a', 'b', 'c'].map(name => { const dir = mkdtempSync(join(tmpdir(), `cez-snapshot-${name}-`)); dirs.push(dir); return dir; });
    const { proc, exited } = await child(a!);
    try {
      expect(() => sharedCwdScan(() => { throw Error('scanned before anyone asked'); })).not.toThrow();
      const before = procScope.listings;
      const cwds = sharedCwdScan();
      expect(procScope.listings).toBe(before);
      expect(inspectGeneration({ paths: [a!], cwds }).pids).toEqual([proc.pid]);
      expect(inspectGeneration({ paths: [b!], cwds }).liveness).toBe('gone');
      expect(inspectExecutionGeneration({ paths: [c!], pathsComplete: true, cwds }).liveness).toBe('gone');
      expect(procScope.listings - before).toBe(1);
    } finally { proc.kill(); await exited; }
  });

  it('an unlistable /proc is unknown everywhere', () => {
    const proc = { readdir: () => { throw Error('unreadable /proc'); }, readlink: () => '/worker' };
    expect(scanProcessCwds('linux', proc)).toBe('unknown');
    expect(processesWithCwdUnder('/worker', 'linux', undefined, undefined, 'unknown')).toBe('unknown');
    expect(inspectGeneration({ paths: ['/worker'], cwds: () => 'unknown' }).liveness).toBe('unknown');
  });

  it('win32 has an empty snapshot, darwin builds one from a single lsof, and this process is never in it', () => {
    const unused = () => { throw Error('never read'); };
    expect(scanProcessCwds('win32', { readdir: unused, readlink: unused }, { lsof: unused })).toEqual(new Map());
    const darwin = { lsof: () => ({ ok: true, stdout: `p42\nn/tmp/x\np${process.pid}\nn/tmp/x\n` }) };
    expect(scanProcessCwds('darwin', { readdir: unused, readlink: unused }, darwin)).toEqual(new Map([[42, '/tmp/x']]));
    const linux = { readdir: () => ['7', String(process.pid), 'self'], readlink: () => '/worker' };
    expect(scanProcessCwds('linux', linux)).toEqual(new Map([[7, '/worker']]));
    expect(scanProcessCwds('aix')).toBe('unknown');
  });
});

describe('one holder\'s working directory (hearsay-tools/cezarion#879)', () => {
  it('darwin rechecks a named holder with a targeted lsof; a failed or empty answer is no evidence of holding', () => {
    const linuxUnused = { readdir: () => { throw Error('no /proc on darwin'); }, readlink: () => { throw Error('no /proc on darwin'); } };
    const darwin = (stdout: string, ok = true) => ({
      lsof: () => { throw Error('a recheck never runs the full scan'); },
      lsofPid: (pid: number) => ({ ok, stdout: stdout.replaceAll('PID', String(pid)) }),
    });
    expect(processCwdUnder(42, ['/worker'], 'darwin', linuxUnused, darwin('pPID\nn/worker/nested\n'))).toBe(true);
    expect(processCwdUnder(42, ['/worker'], 'darwin', linuxUnused, darwin('pPID\nn/\n'))).toBe(false);
    expect(processCwdUnder(42, ['/worker'], 'darwin', linuxUnused, darwin('', false))).toBe(false);
    expect(processCwdUnder(42, ['/worker'], 'darwin', linuxUnused, darwin('pPID\n'))).toBe(false);
  });

  it('linux reads one link; win32, whose scan never names a holder, cannot say', () => {
    const proc = { readdir: () => { throw Error('no listing for one process'); }, readlink: (pid: string) => pid === '7' ? '/worker' : '/elsewhere' };
    expect(processCwdUnder(7, ['/worker'], 'linux', proc)).toBe(true);
    expect(processCwdUnder(8, ['/worker'], 'linux', proc)).toBe(false);
    expect(processCwdUnder(7, ['/worker'], 'win32')).toBeUndefined();
  });
});

describe('recordedGroupSignalable (hearsay-tools/cezarion#890)', () => {
  it('signals a group only when its live leader is the recorded incarnation, or a holder is in it', async () => {
    const dead = spawn(process.execPath, ['-e', '']);
    await new Promise(resolve => dead.once('exit', resolve));
    const live = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    try {
      const token = processStartToken(live.pid!);
      expect(recordedGroupSignalable({ pid: live.pid! })).toBe(false);
      // A dead leader's number may have been reused (a double-fork daemon leaves exactly that
      // shape): only a holder of the worker's paths inside the group proves it is still ours.
      expect(recordedGroupSignalable({ pid: dead.pid!, pgid: dead.pid! })).toBe(false);
      expect(recordedGroupSignalable({ pid: dead.pid!, pgid: dead.pid! }, [dead.pid! + 7])).toBe(false);
      expect(recordedGroupSignalable({ pid: dead.pid!, pgid: dead.pid! }, [dead.pid!])).toBe(true);
      if (token) expect(recordedGroupSignalable({ pid: live.pid!, startToken: token, pgid: live.pid! })).toBe(true);
      // A live pid of another incarnation means our group emptied and its number was reused.
      expect(recordedGroupSignalable({ pid: live.pid!, startToken: 'another-incarnation', pgid: live.pid! })).toBe(false);
      expect(recordedGroupSignalable({ pid: live.pid!, pgid: live.pid! })).toBe(false);
      // A session leader's group is its own pid; anything else is not ours to signal.
      expect(recordedGroupSignalable({ pid: dead.pid!, pgid: dead.pid! + 1 }, [dead.pid! + 1])).toBe(false);
    } finally { live.kill('SIGKILL'); }
  });
});
