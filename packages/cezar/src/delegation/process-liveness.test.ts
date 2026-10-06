import childProcess, { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nonDumpableHolder } from './non-dumpable.testkit.ts';
import { inspectExecutionGeneration, inspectGeneration, parseProcStat, probeGeneration, processesWithCwdUnder, processStartToken, recordedProcessLive, type WorkerProcessRecord } from './process-liveness.ts';

// Scope only enumeration to the processes this fixture owns. A full-host scan may
// conservatively include an unrelated same-user process whose cwd is unreadable.
// Keep cwd/stat/token reads real, including ENOENT after our child has exited;
// the injected-reader cases below cover unreadable holders separately.
const procScope = vi.hoisted(() => ({
  entries: undefined as string[] | undefined, boot: undefined as string | null | undefined,
  unknownOwnerPid: undefined as number | undefined, unknownStartPid: undefined as number | undefined,
  cwdErrorPid: undefined as number | undefined, unreadableEnumeration: false,
}));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      if (procScope.unknownOwnerPid !== undefined && args[0] === `/proc/${procScope.unknownOwnerPid}`) {
        throw Object.assign(Error('unreadable process owner'), { code: 'EACCES' });
      }
      return actual.statSync(...args);
    },
    readlinkSync: (...args: Parameters<typeof actual.readlinkSync>) => {
      if (procScope.cwdErrorPid !== undefined && args[0] === `/proc/${procScope.cwdErrorPid}/cwd`) {
        throw Object.assign(Error('unexpected cwd error'), { code: 'EIO' });
      }
      return actual.readlinkSync(...args);
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (procScope.unknownStartPid !== undefined && args[0] === `/proc/${procScope.unknownStartPid}/stat`) {
        throw Object.assign(Error('unreadable process start time'), { code: 'EACCES' });
      }
      if (args[0] === '/proc/sys/kernel/random/boot_id' && procScope.boot !== undefined) {
        if (procScope.boot === null) throw Object.assign(Error('unreadable boot ID'), { code: 'EACCES' });
        return procScope.boot;
      }
      return actual.readFileSync(...args);
    },
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      if (args[0] === '/proc' && procScope.unreadableEnumeration) throw Object.assign(Error('unreadable proc'), { code: 'EACCES' });
      return args[0] === '/proc' && procScope.entries ? procScope.entries : actual.readdirSync(...args);
    },
  };
});

const linux = process.platform === 'linux';
const dirs: string[] = [];
afterEach(() => {
  procScope.entries = undefined; procScope.boot = undefined;
  procScope.unknownOwnerPid = undefined; procScope.unknownStartPid = undefined;
  procScope.cwdErrorPid = undefined; procScope.unreadableEnumeration = false;
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
    expect(parseProcStat(`42 (evil ) (x) y) S ${tail}`)).toEqual({ state: 'S', ppid: 4, startToken: '22' });
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

  it('skips a later unreadable process another user launched: its parent chain reaches a foreign process before init (hearsay-tools/cezarion#874)', () => {
    const denied = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
    const uid = process.getuid?.() ?? 1000;
    const since = Date.now();
    const tree = (parents: Record<string, number>, owners: Record<string, number>) => ({
      readdir: () => ['7'], readlink: denied, ownerUid: (pid: string) => owners[pid], startedAtMs: () => since + 5_000,
      parentPid: (pid: string) => parents[pid],
    });
    // `sshd: user@notty` (7) under root's privilege-separated sshd (5): a login, not a descendant.
    expect(processesWithCwdUnder(tmpdir(), 'linux', tree({ 7: 5, 5: 1 }, { 7: uid, 5: 0 }), since)).toEqual([]);
    // `sftp-server` (7) under that login sshd (6) under root's monitor (5): two hops up.
    expect(processesWithCwdUnder(tmpdir(), 'linux', tree({ 7: 6, 6: 5, 5: 1 }, { 7: uid, 6: uid, 5: 0 }), since)).toEqual([]);
    // Any other user counts, not only root.
    expect(processesWithCwdUnder(tmpdir(), 'linux', tree({ 7: 5, 5: 1 }, { 7: uid, 5: uid + 1 }), since)).toEqual([]);
    // The rule needs no age cutoff: reuse and reclaim scans (no `since`) skip the login too.
    expect(processesWithCwdUnder(tmpdir(), 'linux', tree({ 7: 5, 5: 1 }, { 7: uid, 5: 0 }))).toEqual([]);
    // An orphan adopted by `systemd --user` (6) reaches init with no foreign ancestor: still a holder.
    expect(processesWithCwdUnder(tmpdir(), 'linux', tree({ 7: 6, 6: 1 }, { 7: uid, 6: uid }), since)).toEqual([7]);
    expect(processesWithCwdUnder(tmpdir(), 'linux', tree({ 7: 1 }, { 7: uid }), since)).toEqual([7]);
    // An unknown parent, or a parent of unknown ownership, is no evidence.
    expect(processesWithCwdUnder(tmpdir(), 'linux', tree({}, { 7: uid }), since)).toEqual([7]);
    expect(processesWithCwdUnder(tmpdir(), 'linux', tree({ 7: 5 }, { 7: uid }), since)).toEqual([7]);
    // A reader without parent information keeps the previous rule.
    const { parentPid: _unused, ...flat } = tree({ 7: 5, 5: 1 }, { 7: uid, 5: 0 });
    expect(processesWithCwdUnder(tmpdir(), 'linux', flat, since)).toEqual([7]);
  });

  it('a later unreadable descendant of this cezar process holds, whatever its name and whoever launched cezar', () => {
    const denied = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
    const uid = process.getuid?.() ?? 1000;
    const since = Date.now();
    // cezar itself runs inside an SSH login whose monitor (3) is root's. The walk stops at cezar: 7 is ours.
    const parents: Record<string, number> = { 7: process.pid, [process.pid]: 3, 3: 1 };
    const proc = { readdir: () => ['7'], readlink: denied, ownerUid: (pid: string) => (pid === '3' ? 0 : uid),
      startedAtMs: () => since + 5_000, parentPid: (pid: string) => parents[pid] };
    expect(processesWithCwdUnder(tmpdir(), 'linux', proc, since)).toEqual([7]);
  });

  it('a parent that changes between reads is PID reuse, never evidence of a foreign launcher', () => {
    const denied = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
    const uid = process.getuid?.() ?? 1000;
    const since = Date.now();
    let reads = 0;
    const proc = { readdir: () => ['7'], readlink: denied, ownerUid: (pid: string) => (pid === '7' ? uid : 0),
      startedAtMs: () => since + 5_000, parentPid: (pid: string) => (pid === '7' ? (reads++ === 0 ? 5 : 9) : 1) };
    expect(processesWithCwdUnder(tmpdir(), 'linux', proc, since)).toEqual([7]);
  });

  it('ancestry excuses only a permission-denied cwd: a readable holder and an unexpected error still block', () => {
    const uid = process.getuid?.() ?? 1000;
    const since = Date.now();
    const foreign = { readdir: () => ['7'], ownerUid: (pid: string) => (pid === '7' ? uid : 0), startedAtMs: () => since + 5_000,
      parentPid: (pid: string) => (pid === '7' ? 5 : 1) };
    expect(processesWithCwdUnder('/worker', 'linux', { ...foreign, readlink: () => '/worker' }, since)).toEqual([7]);
    expect(processesWithCwdUnder('/worker', 'linux', { ...foreign, readlink: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } }, since)).toEqual([7]);
  });

  it('darwin: an own-user process lsof could not read counts like an unreadable Linux one', () => {
    const since = Date.now();
    const linuxUnused = { readdir: () => [], readlink: () => '', ownerUid: () => undefined, startedAtMs: () => undefined };
    const dir = tmpdir();
    const darwin = (stdout: string, table: { pid: number; ppid?: number; uid?: number; startedAtMs?: number }[] | undefined, ok = true) => ({ lsof: () => ({ ok, stdout }), processes: () => table });
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

  it('darwin: skips a later lsof-omitted process whose parent chain reaches another user before launchd (hearsay-tools/cezarion#874)', () => {
    const since = Date.now();
    const uid = process.getuid?.() ?? 1000;
    const linuxUnused = { readdir: () => [], readlink: () => '', ownerUid: () => undefined, startedAtMs: () => undefined };
    const dir = tmpdir();
    const lsof = `p10\nn/\np11\nn${dir}\n`;
    const scan = (table: { pid: number; ppid?: number; uid?: number; startedAtMs?: number }[]) =>
      processesWithCwdUnder(dir, 'darwin', linuxUnused, since, { lsof: () => ({ ok: true, stdout: lsof }), processes: () => table });
    const seen = [{ pid: 10, ppid: 1, uid }, { pid: 11, ppid: 1, uid }];
    const monitor = { pid: 50, ppid: 1, uid: 0 }; // root's privilege-separated sshd
    const later = since + 5_000;
    // 12: `sshd: user@ttys000` under the root monitor; 13: `sftp-server` under 12.
    expect(scan([...seen, monitor, { pid: 12, ppid: 50, uid, startedAtMs: later }])).toEqual([11]);
    expect(scan([...seen, monitor, { pid: 12, ppid: 50, uid, startedAtMs: later }, { pid: 13, ppid: 12, uid, startedAtMs: later }])).toEqual([11]);
    // 14 reaches launchd through our own processes only: still a candidate.
    expect(scan([...seen, { pid: 14, ppid: 11, uid, startedAtMs: later }])).toEqual([11, 14]);
    // The table lists every user now: another user's process is never a candidate; an unknown parent is no evidence.
    expect(scan([...seen, { pid: 15, ppid: 1, uid: uid + 1, startedAtMs: later }, { pid: 16, ppid: 99, uid, startedAtMs: later }])).toEqual([11, 16]);
  });

  it('darwin: exited zombies cannot hold a cwd, while unreadable live processes remain candidates', () => {
    const start = 'Mon Oct  5 23:29:05 2026';
    let failed = false;
    const spy = vi.spyOn(childProcess, 'spawnSync').mockImplementation(((command: string, args: string[]) => {
      const table = args.at(-1)?.includes('stat=');
      const stdout = command === 'lsof' ? 'p10\nn/\n' :
        [[11, 'Z'], [12, 'Z+'], [13, 'S'], [14, 'R'], [15, '?']].map(([pid, state]) =>
          table ? `${pid} 1 ${process.getuid?.() ?? 0} ${state} ${start}` : start).join('\n');
      return { pid: 14, status: failed ? 1 : 0, signal: null, stdout, stderr: '', output: [null, stdout, ''] };
    }) as typeof childProcess.spawnSync);
    syncBuiltinESMExports();
    try {
      expect(processesWithCwdUnder('/worker', 'darwin')).toEqual([13, 15]);
      failed = true;
      expect(processesWithCwdUnder('/worker', 'darwin')).toBe('unknown');
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
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

  it.runIf(linux)('deletion proof skips an unreadable process older than the worker, never a later or readable one (hearsay-tools/cezarion#858)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-deletion-holder-')); dirs.push(dir);
    const ambient = await nonDumpableHolder(tmpdir());
    const readable = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(()=>{},1000)"], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
    const exited = new Promise(resolve => readable.once('exit', resolve));
    await new Promise(resolve => readable.stdout!.once('data', resolve));
    procScope.entries = [String(ambient.pid)];
    try {
      const later = Date.now() + 60_000;
      expect(inspectGeneration({ paths: [dir], holdersSince: later })).toMatchObject({ liveness: 'gone', pids: [] });
      expect(inspectGeneration({ paths: [dir], holdersSince: 0 })).toMatchObject({ liveness: 'alive', pids: [ambient.pid] });
      expect(inspectGeneration({ paths: [dir], since: later })).toMatchObject({ liveness: 'alive', pids: [ambient.pid] }); // reuse proof
      procScope.entries = [String(ambient.pid), String(readable.pid)];
      expect(inspectGeneration({ paths: [dir], holdersSince: later })).toMatchObject({ liveness: 'alive', pids: [readable.pid] });
      await ambient.write();
    } finally { readable.kill('SIGKILL'); await exited; await ambient.close(); }
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

  it.runIf(linux).each([
    'absent ledger', 'missing controller token', 'legacy controller token', 'malformed controller boot', 'malformed controller start',
    'missing process token', 'legacy process token', 'malformed process boot', 'malformed process start', 'foreign process boot',
    'unknown boot', 'malformed boot', 'unknown ownership', 'unknown start time', 'unexpected cwd error', 'unreadable enumeration',
  ] as const)('rejects otherwise-qualifying abandonment with %s (hearsay-tools/cezarion#839)', async shape => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-abandonment-guard-')); dirs.push(dir);
    const ambient = await nonDumpableHolder(dir); procScope.entries = [String(ambient.pid)];
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    let record: WorkerProcessRecord | undefined = {
      generation: 'g', controller: { pid: 2147483001, startToken: `${boot}:100` },
      processes: [{ pid: 2147483002, startToken: `${boot}:101` }],
    };
    const locations = { paths: [dir], pathsComplete: true, since: 0 };
    try {
      // Control: the same real unreadable process and complete locations qualify before
      // exactly one input is damaged. Omitting pathsComplete would bypass the ledger gate.
      vi.resetModules();
      const { inspectExecutionGeneration: qualifyingProbe } = await import('./process-liveness.ts');
      expect(qualifyingProbe({ ...locations, record })).toMatchObject({ liveness: 'unknown', pids: [], abandonable: true });
      switch (shape) {
        case 'absent ledger': record = undefined; break;
        case 'missing controller token': record.controller = { pid: 2147483001 }; break;
        case 'legacy controller token': record.controller.startToken = '100'; break;
        case 'malformed controller boot': record.controller.startToken = 'invalid:100'; break;
        case 'malformed controller start': record.controller.startToken = `${boot}:invalid`; break;
        case 'missing process token': record.processes = [{ pid: 2147483002 }]; break;
        case 'legacy process token': record.processes[0]!.startToken = '101'; break;
        case 'malformed process boot': record.processes[0]!.startToken = 'invalid:101'; break;
        case 'malformed process start': record.processes[0]!.startToken = `${boot}:invalid`; break;
        case 'foreign process boot': record.processes[0]!.startToken = `${oldBoot}:101`; break;
        case 'unknown boot': procScope.boot = null; break;
        case 'malformed boot': procScope.boot = 'invalid'; break;
        case 'unknown ownership': procScope.unknownOwnerPid = ambient.pid; break;
        case 'unknown start time': procScope.unknownStartPid = ambient.pid; break;
        case 'unexpected cwd error': procScope.cwdErrorPid = ambient.pid; break;
        case 'unreadable enumeration': procScope.unreadableEnumeration = true; break;
      }
      // Re-import to exercise boot discovery rather than a previous probe's cached boot ID.
      vi.resetModules();
      const { inspectExecutionGeneration: guardedProbe, probeGeneration: resourceProbe } = await import('./process-liveness.ts');
      const input = { ...locations, ...(record ? { record } : {}) };
      expect(guardedProbe(input)).toMatchObject({ liveness: shape === 'unreadable enumeration' ? 'unknown' : 'alive' });
      expect(guardedProbe(input)).not.toHaveProperty('abandonable', true);
      expect(resourceProbe(input)).not.toBe('gone');
      await ambient.write(); // rejected evidence never changes or terminates the candidate
    } finally { await ambient.close(); }
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
