import childProcess, { spawn, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { once } from 'node:events';
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readableHolder } from './non-dumpable.testkit.ts';
import { inspectGeneration, processesWithCwdUnder, processStartToken, recordedProcessLive } from './process-liveness.ts';
import { scopeFixtureProcesses } from './process-scope.testkit.ts';

describe.runIf(process.platform === 'linux')('fixture process enumeration safety', () => {
  it('retains real unrecorded holders and independently reads recorded PIDs outside the scope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-scope-holder-'));
    const original = fs.readdirSync;
    const restore = scopeFixtureProcesses();
    const holder = await readableHolder(root);
    let closed = false;
    try {
      expect(inspectGeneration({ paths: [root] })).toMatchObject({ liveness: 'alive', pids: [holder.pid] });
      await holder.write();
      expect(readFileSync(join(root, 'holder-writes'), 'utf8')).toBe('still writable\n');
      await holder.close(); closed = true;
      expect(inspectGeneration({ paths: [root] }).liveness).toBe('gone');
      // The test runner's parent is deliberately absent from enumeration. Its recorded
      // identity still blocks the real probe; scoping must never filter recorded reads.
      expect(fs.readdirSync('/proc')).not.toContain(String(process.ppid));
      expect(inspectGeneration({ paths: [root], record: { generation: 'fixture',
        controller: { pid: process.pid, startToken: processStartToken(process.pid) },
        processes: [{ pid: process.ppid, startToken: processStartToken(process.ppid) }],
      } })).toMatchObject({ liveness: 'alive', pids: [process.ppid] });
    } finally {
      if (!closed) await holder.close();
      restore(); rmSync(root, { recursive: true, force: true });
    }
    expect(fs.readdirSync).toBe(original);
  });

  it('keeps an observed descendant after its launcher exits until the real holder exits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-scope-orphan-'));
    const restore = scopeFixtureProcesses();
    const launcher = spawn('python3', ['-u', '-c', `
import os, sys, time
pid = os.fork()
if pid:
    print(pid, flush=True)
    sys.stdin.readline()
else:
    while not os.path.exists('stop'):
        time.sleep(0.01)
`], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(launcher, 'exit');
    let holder: { pid: number; startToken?: string } | undefined;
    try {
      const [data] = await once(launcher.stdout, 'data');
      const pid = Number(String(data).trim());
      expect(Number.isSafeInteger(pid)).toBe(true);
      holder = { pid, startToken: processStartToken(pid) };
      expect(processesWithCwdUnder(root)).toContain(pid); // observe while ancestry is intact
      launcher.stdin.end(); await exited;
      expect(processesWithCwdUnder(root)).toContain(pid); // now reparented, still the same token
      writeFileSync(join(root, 'stop'), '');
      await vi.waitFor(() => expect(recordedProcessLive(holder!)).toBe(false));
      expect(inspectGeneration({ paths: [root] }).liveness).toBe('gone');
    } finally {
      writeFileSync(join(root, 'stop'), ''); launcher.stdin.end(); await exited;
      if (holder) await vi.waitFor(() => expect(recordedProcessLive(holder!)).toBe(false));
      restore(); rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('macOS fixture enumeration boundaries', () => {
  it('preserves promisified execFile results and failures', async () => {
    const restore = scopeFixtureProcesses('darwin');
    try {
      const exec = promisify(childProcess.execFile);
      await expect(exec(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err")']))
        .resolves.toMatchObject({ stdout: 'out', stderr: 'err' });
      await expect(exec(process.execPath, ['-e', 'process.stderr.write("failed"); process.exit(7)']))
        .rejects.toMatchObject({ code: 7, stderr: 'failed' });
    } finally { restore(); }
  });

  it('retains a late owned child after orphaning but excludes a later reuse of its PID', () => {
    const original = childProcess.spawnSync;
    const ambient = process.pid + 100_000, orphan = ambient + 1;
    let snapshot = `${process.pid} 1 OWN\n${ambient} 1 AMBIENT\n`;
    let calls = 0;
    const output = `p${ambient}\nn/ambient\np${orphan}\nn/fixture\n`;
    childProcess.spawnSync = ((command: string, args: string[]) => {
      const stdout = command === 'lsof' ? output : args[0] === '-axo'
        ? snapshot + (calls++ === 1 ? `${orphan} ${process.pid} ORPHAN\n` : '') : 'ORPHAN\n';
      return { pid: 1, status: 0, signal: null, stdout, stderr: '', output: [null, stdout, ''] };
    }) as typeof original;
    const restore = scopeFixtureProcesses('darwin');
    try {
      const scan = () => spawnSync('lsof', ['-a', '-d', 'cwd', '-Fpn'], { encoding: 'utf8' }).stdout;
      expect(scan()).toBe(`p${orphan}\nn/fixture\n`);
      snapshot += `${orphan} 1 ORPHAN\n`;
      expect(scan()).toBe(`p${orphan}\nn/fixture\n`);
      snapshot = snapshot.replace('1 ORPHAN', '1 REUSED');
      expect(scan()).not.toContain(`p${orphan}\n`);
    } finally { restore(); childProcess.spawnSync = original; syncBuiltinESMExports(); }
  });

  it.each(['ambient', 'owned', 'orphan'])('classifies a late process with %s ancestry using a refreshed snapshot', kind => {
    const original = childProcess.spawnSync;
    const ambient = process.pid + 100_000, child = ambient + 1;
    let calls = 0;
    childProcess.spawnSync = ((command: string) => {
      const stdout = command === 'lsof' ? `p${child}\nn/fixture\n`
        : `${process.pid} 1 OWN\n${ambient} 1 AMBIENT\n` +
          (calls++ ? `${child} ${kind === 'owned' ? process.pid : kind === 'ambient' ? ambient : 1} CHILD\n` : '');
      return { pid: 1, status: 0, signal: null, stdout, stderr: '', output: [null, stdout, ''] };
    }) as typeof original;
    const restore = scopeFixtureProcesses('darwin');
    try {
      const result = spawnSync('lsof', ['-a', '-d', 'cwd', '-Fpn'], { encoding: 'utf8' }).stdout;
      expect(result).toBe(kind === 'owned' ? `p${child}\nn/fixture\n` : '');
    } finally { restore(); childProcess.spawnSync = original; syncBuiltinESMExports(); }
  });

  it('remembers owned ancestors found during refresh even when lsof omitted them', () => {
    const original = childProcess.spawnSync;
    const parent = process.pid + 100_000, child = parent + 1;
    let calls = 0, orphaned = false;
    childProcess.spawnSync = ((command: string) => {
      const stdout = command === 'lsof' ? `p${orphaned ? parent : child}\nn/fixture\n`
        : `${process.pid} 1 OWN\n` + (calls++
          ? `${parent} ${orphaned ? 1 : process.pid} PARENT\n${child} ${parent} CHILD\n` : '');
      return { pid: 1, status: 0, signal: null, stdout, stderr: '', output: [null, stdout, ''] };
    }) as typeof original;
    const restore = scopeFixtureProcesses('darwin');
    try {
      const scan = () => spawnSync('lsof', ['-a', '-d', 'cwd', '-Fpn'], { encoding: 'utf8' }).stdout;
      expect(scan()).toBe(`p${child}\nn/fixture\n`);
      orphaned = true;
      expect(scan()).toBe(`p${parent}\nn/fixture\n`);
    } finally { restore(); childProcess.spawnSync = original; syncBuiltinESMExports(); }
  });

  it.each(['pid=,lstart=', 'pid=,stat=,lstart='])('scopes the %s darwin own-process listing', columns => {
    const original = childProcess.spawnSync;
    const ambient = process.pid + 100_000, child = ambient + 1;
    childProcess.spawnSync = ((command: string, args: string[]) => {
      const stdout = command === 'lsof' ? ''
        : args[0] === '-axo' ? `${process.pid} 1 OWN\n${child} ${process.pid} CHILD\n${ambient} 1 AMBIENT\n`
        : columns.includes('stat=') ? `${child} S OWN\n${ambient} S AMBIENT\n${process.ppid} S PARENT\n`
        : `${child} OWN\n${ambient} AMBIENT\n${process.ppid} PARENT\n`;
      return { pid: 1, status: 0, signal: null, stdout, stderr: '', output: [null, stdout, ''] };
    }) as typeof original;
    const restore = scopeFixtureProcesses('darwin');
    try {
      const result = spawnSync('ps', ['-U', String(process.getuid?.()), '-o', columns], { encoding: 'utf8' }).stdout;
      expect(result).toContain(String(child));
      expect(result).not.toContain(String(ambient));
      expect(result).not.toContain(String(process.ppid));
    } finally { restore(); childProcess.spawnSync = original; syncBuiltinESMExports(); }
  });

  it.each(['failed', 'malformed'])('preserves the unfiltered probe when ancestry enumeration is %s', mode => {
    const original = childProcess.spawnSync;
    const output = `p${process.ppid}\nn/ambient\n`;
    childProcess.spawnSync = ((command: string) => {
      const stdout = command === 'lsof' ? output : 'malformed';
      return { pid: 1, status: command === 'ps' && mode === 'failed' ? 1 : 0, signal: null,
        stdout, stderr: '', output: [null, stdout, ''] };
    }) as typeof original;
    const restore = scopeFixtureProcesses('darwin');
    try {
      expect(spawnSync('lsof', ['-a', '-d', 'cwd', '-Fpn'], { encoding: 'utf8' }).stdout).toBe(output);
    } finally { restore(); childProcess.spawnSync = original; syncBuiltinESMExports(); }
  });

});

describe.runIf(process.platform === 'darwin')('macOS fixture process enumeration safety', { timeout: 20_000 }, () => {
  it('excludes ambient processes but retains real holders and recorded identities outside the scope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-scope-holder-'));
    const restore = scopeFixtureProcesses();
    const holder = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { cwd: root, stdio: ['pipe', 'ignore', 'ignore'] });
    const exited = once(holder, 'exit');
    try {
      const pids = (stdout: string) => stdout.split('\n').map(line => Number(line.trim().split(/\s+/)[0]));
      const own = spawnSync('ps', ['-U', String(process.getuid!()), '-o', 'pid=,lstart='], { encoding: 'utf8' });
      expect(own.status).toBe(0);
      expect(pids(own.stdout)).not.toContain(process.ppid);
      const ownWithStat = spawnSync('ps', ['-U', String(process.getuid!()), '-o', 'pid=,stat=,lstart='], { encoding: 'utf8' });
      expect(ownWithStat.status).toBe(0);
      expect(pids(ownWithStat.stdout)).not.toContain(process.ppid);
      const asyncOwn = await new Promise<string>((resolve, reject) => childProcess.execFile('ps',
        ['-U', String(process.getuid!()), '-o', 'pid=,lstart='], { encoding: 'utf8' },
        (error, stdout) => error ? reject(error) : resolve(stdout)));
      expect(pids(asyncOwn)).not.toContain(process.ppid);
      const asyncCwd = await new Promise<string>((resolve, reject) => childProcess.execFile('lsof',
        ['-a', '-u', String(process.getuid!()), '-d', 'cwd', '-Fpn'], { encoding: 'utf8' },
        (error, stdout) => error && (error.code !== 1 || error.killed) ? reject(error) : resolve(stdout)));
      const cwdPids = [...asyncCwd.matchAll(/^p(\d+)$/gm)].map(match => Number(match[1]));
      expect(cwdPids).toContain(holder.pid);
      expect(cwdPids).not.toContain(process.ppid);
      expect(processesWithCwdUnder(root)).toContain(holder.pid);
      expect(inspectGeneration({ paths: [root], record: { generation: 'fixture',
        controller: { pid: process.pid, startToken: processStartToken(process.pid) },
        processes: [{ pid: process.ppid, startToken: processStartToken(process.ppid) }],
      } }).pids).toContain(process.ppid);
      holder.stdin.end(); await exited;
      expect(inspectGeneration({ paths: [root] }).liveness).toBe('gone');
    } finally {
      holder.stdin.end(); await exited;
      restore(); rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains an observed orphan until it exits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-scope-orphan-'));
    const restore = scopeFixtureProcesses();
    const launcher = spawn(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', "const fs = require('node:fs'); setInterval(() => { if (fs.existsSync('stop')) process.exit(0); }, 10)"], { detached: true, stdio: 'ignore' });
      child.unref(); console.log(child.pid); process.stdin.resume();
    `], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(launcher, 'exit');
    let holder: { pid: number; startToken?: string } | undefined;
    try {
      const [data] = await once(launcher.stdout, 'data');
      const pid = Number(String(data).trim());
      expect(Number.isSafeInteger(pid)).toBe(true);
      holder = { pid, startToken: processStartToken(pid) };
      expect(processesWithCwdUnder(root)).toContain(pid);
      launcher.stdin.end(); await exited;
      expect(processesWithCwdUnder(root)).toContain(pid);
      writeFileSync(join(root, 'stop'), '');
      await vi.waitFor(() => expect(recordedProcessLive(holder!)).toBe(false), { timeout: 5_000 });
      expect(inspectGeneration({ paths: [root] }).liveness).toBe('gone');
    } finally {
      writeFileSync(join(root, 'stop'), ''); launcher.stdin.end(); await exited;
      if (holder) await vi.waitFor(() => expect(recordedProcessLive(holder!)).toBe(false), { timeout: 5_000 });
      restore(); rmSync(root, { recursive: true, force: true });
    }
  });
});
