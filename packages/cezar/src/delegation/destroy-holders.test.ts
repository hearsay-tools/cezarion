import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { scopeFixtureProcesses } from './process-scope.testkit.ts';
import { reapDestroyHolders } from './destroy-holders.ts';

const readFault = vi.hoisted(() => ({ pids: [] as number[], enabled: false, maps: false, tokenPid: 0, tokenFlip: false, count: 0 }));
vi.mock('../detached-process.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../detached-process.ts')>();
  return { ...actual, processStartToken: (pid: number) =>
    readFault.tokenFlip && readFault.tokenPid === pid ? 'replacement-incarnation' : actual.processStartToken(pid) };
});
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (readFault.enabled && readFault.maps && readFault.pids.some(pid => String(path) === `/proc/${pid}/maps`)) {
      readFault.count++; throw Object.assign(new Error('denied'), { code: 'EACCES' });
    }
    return Reflect.apply(actual.readFileSync, actual, [path, ...args]);
  }) as typeof fs.readFileSync, readdirSync: ((...args: unknown[]) => Reflect.apply(fs.readdirSync, fs, args)) as typeof fs.readdirSync, readlinkSync: ((path: fs.PathLike, ...args: unknown[]) => {
    if (readFault.enabled && readFault.pids.some(pid => String(path) === `/proc/${pid}/cwd`)) {
      readFault.count++; throw Object.assign(new Error('denied'), { code: 'EACCES' });
    }
    return Reflect.apply(actual.readlinkSync, actual, [path, ...args]);
  }) as typeof fs.readlinkSync };
});

it.runIf(process.platform === 'linux' || process.platform === 'darwin')('stops scoped cwd and open-file holders without touching an unrelated process', async () => {
  const unscope = scopeFixtureProcesses();
  const root = await mkdtemp(join(tmpdir(), 'cez-destroy-holders-'));
  const file = join(root, 'file'); await writeFile(file, 'owned');
  const script = 'if(process.argv[1]) require("fs").openSync(process.argv[1],"r"); console.log("ready"); setInterval(()=>{},1000)';
  const cwd = spawn(process.execPath, ['-e', script], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
  const fd = spawn(process.execPath, ['-e', script, file], { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'ignore'] });
  const other = spawn(process.execPath, ['-e', script], { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await Promise.all([cwd, fd, other].map(child => once(child.stdout!, 'data')));
    const exited = [once(cwd, 'exit'), once(fd, 'exit')];
    await reapDestroyHolders([root], () => {});
    expect((await Promise.all(exited)).map(([, signal]) => signal)).toEqual(['SIGTERM', 'SIGTERM']);
    expect(other.exitCode).toBeNull(); expect(other.signalCode).toBeNull();
  } finally {
    for (const child of [cwd, fd, other]) child.kill('SIGKILL');
    unscope(); await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it.runIf(process.platform === 'linux' && spawnSync('python3', ['-I', '-c', 'import ctypes'], { stdio: 'ignore' }).status === 0)('finds a live thread after its leader exits', async () => {
  const unscope = scopeFixtureProcesses();
  const root = await mkdtemp(join(tmpdir(), 'cez-destroy-thread-'));
  const script = [
    'import ctypes, signal, threading, time',
    'signal.signal(signal.SIGTERM, signal.SIG_IGN)',
    'threading.Thread(target=lambda: time.sleep(60)).start()',
    'print("ready", flush=True)',
    'ctypes.CDLL(None).pthread_exit(None)',
  ].join('\n');
  const child = spawn('python3', ['-I', '-c', script], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    await once(child.stdout!, 'data');
    await vi.waitFor(async () => {
      const stat = await readFile(`/proc/${child.pid}/stat`, 'utf8');
      expect(stat.slice(stat.lastIndexOf(')') + 1).trim().startsWith('Z')).toBe(true);
    }, { timeout: 10_000 });
    await reapDestroyHolders([root], () => {});
    expect((await exited)[1]).toBe('SIGKILL');
  } finally {
    child.kill('SIGKILL'); await exited;
    unscope(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it.runIf(process.platform === 'linux' || process.platform === 'darwin')('checks ownership again before signalling a discovered holder', async () => {
  const unscope = scopeFixtureProcesses();
  const root = await mkdtemp(join(tmpdir(), 'cez-destroy-identity-'));
  const child = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(()=>{},1000)'],
    { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await once(child.stdout!, 'data');
    let calls = 0;
    await expect(reapDestroyHolders([root], async () => {
      if (++calls === 2) throw new Error('ownership changed');
    })).rejects.toThrow('ownership changed');
    expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
  } finally {
    child.kill('SIGKILL'); await once(child, 'exit');
    unscope(); await rm(root, { recursive: true, force: true });
  }
}, 60_000);


it.runIf(process.platform === 'linux')('keeps cleanup incomplete when a known holder becomes unreadable after a stop attempt', async () => {
  const unscope = scopeFixtureProcesses();
  const root = await mkdtemp(join(tmpdir(), 'cez-holder-denied-'));
  const child = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(()=>{},1000)'],
    { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = once(child, 'exit');
  let denied = false;
  readFault.count = 0;
  const kill = process.kill;
  const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
    if (readFault.pids.includes(pid) && signal === 'SIGTERM') { denied = true; readFault.enabled = true; return true; }
    return kill(pid, signal);
  }) as typeof process.kill);
  syncBuiltinESMExports();
  try {
    await once(child.stdout!, 'data');
    readFault.pids = fs.readdirSync(`/proc/${child.pid}/task`).map(Number);
    const outcome = await reapDestroyHolders([root], () => {}).then(() => undefined, error => error);
    expect(denied).toBe(true);
    expect(readFault.count).toBeGreaterThan(0);
    expect(outcome?.message).toContain(`Cannot read evidence for destroy holder ${child.pid}`);
    expect(child.exitCode).toBeNull();
  } finally {
    killSpy.mockRestore(); readFault.enabled = false; syncBuiltinESMExports();
    child.kill('SIGKILL'); await exited;
    unscope(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it.runIf(process.platform === 'linux' && spawnSync('cc', ['--version'], { stdio: 'ignore' }).status === 0)(
  'stops a closed-descriptor mapped holder and leaves an unrelated mapping alive', async () => {
    const unscope = scopeFixtureProcesses();
    const root = await mkdtemp(join(tmpdir(), 'cez-mapped-holder-'));
    const owned = join(root, 'owned'); const other = join(root, 'other');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(owned); await mkdir(other);
    const binary = join(root, 'holder');
    const fixture = new URL('./fixtures/mmap-holder.c', import.meta.url).pathname;
    expect(spawnSync('cc', [fixture, '-o', binary]).status).toBe(0);
    const children = [];
    try {
      for (const dir of [owned, other]) {
        const file = join(dir, 'mapped file'); const ready = join(dir, 'ready');
        await writeFile(file, Buffer.alloc(4096));
        children.push(spawn(binary, [file, ready], { cwd: tmpdir(), stdio: 'ignore' }));
        await vi.waitFor(async () => expect(Number(await readFile(ready, 'utf8'))).toBeGreaterThan(1), { timeout: 10_000 });
      }
      const [holder, unrelated] = children;
      const exited = once(holder!, 'exit');
      await reapDestroyHolders([owned], () => {});
      expect((await exited)[1]).toBe('SIGTERM');
      expect(unrelated!.exitCode).toBeNull(); expect(unrelated!.signalCode).toBeNull();
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      unscope(); await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

it.runIf(process.platform === 'linux' && spawnSync('cc', ['--version'], { stdio: 'ignore' }).status === 0).each(['released', 'unreadable', 'replaced'] as const)(
  'rechecks a mapped holder that becomes %s before signalling', async change => {
    const unscope = scopeFixtureProcesses();
    const root = await mkdtemp(join(tmpdir(), 'cez-mapped-race-'));
    const owned = join(root, 'owned'); const binary = join(root, 'holder'); const ready = join(root, 'ready');
    const { mkdir } = await import('node:fs/promises'); await mkdir(owned);
    const file = join(owned, 'mapped'); await writeFile(file, Buffer.alloc(4096));
    expect(spawnSync('cc', [new URL('./fixtures/mmap-holder.c', import.meta.url).pathname, '-o', binary]).status).toBe(0);
    const child = spawn(binary, [file, ready], { cwd: tmpdir(), stdio: 'ignore' });
    const exited = once(child, 'exit');
    try {
      await vi.waitFor(async () => expect(Number(await readFile(ready, 'utf8'))).toBe(child.pid), { timeout: 10_000 });
      let calls = 0;
      const outcome = reapDestroyHolders([owned], async () => {
        calls++;
        if (change === 'replaced' && calls === 3) throw new Error('stop after replacement');
        if (calls !== 2) return;
        if (change === 'unreadable') { readFault.pids = [child.pid!]; readFault.maps = true; readFault.enabled = true; }
        else if (change === 'replaced') { readFault.tokenPid = child.pid!; readFault.tokenFlip = true; }
        else {
          child.kill('SIGUSR1');
          await vi.waitFor(async () => expect(await readFile(`/proc/${child.pid}/maps`, 'utf8')).not.toContain(file), { timeout: 10_000 });
        }
      });
      if (change === 'unreadable') await expect(outcome).rejects.toThrow('Cannot read evidence');
      else if (change === 'replaced') await expect(outcome).rejects.toThrow('stop after replacement');
      else await expect(outcome).resolves.toBeUndefined();
      expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
    } finally {
      readFault.enabled = false; readFault.maps = false; readFault.tokenFlip = false; child.kill('SIGKILL'); await exited;
      unscope(); await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
