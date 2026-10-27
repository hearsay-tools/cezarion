import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { scopeFixtureProcesses } from './process-scope.testkit.ts';
import { reapDestroyHolders } from './destroy-holders.ts';

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
