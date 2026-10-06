import childProcess, { execFile, spawn, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { nonDumpableHolder } from './non-dumpable.testkit.ts';
import { inspectGeneration, processesWithCwdUnder, processStartToken, recordedProcessLive } from './process-liveness.ts';
import { scopeFixtureProcesses } from './process-scope.testkit.ts';

describe.runIf(process.platform === 'linux')('fixture process enumeration safety', () => {
  it('retains real unrecorded non-dumpable holders and independently reads recorded PIDs outside the scope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-scope-holder-'));
    const original = fs.readdirSync;
    const restore = scopeFixtureProcesses();
    const holder = await nonDumpableHolder(root);
    let closed = false;
    try {
      // No age exclusion, even though the unreadable fixture child is outside this path.
      expect(inspectGeneration({ paths: [join(root, 'elsewhere')], since: Date.now() + 60_000 })).toMatchObject({ liveness: 'alive', pids: [holder.pid] });
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
  it('retains a newly enumerated orphan across scans but excludes a later reuse of its PID', () => {
    const original = childProcess.spawnSync;
    const ambient = process.pid + 100_000, orphan = ambient + 1;
    let snapshot = `${process.pid} 1 OWN\n${ambient} 1 AMBIENT\n`;
    let calls = 0;
    const output = `p${ambient}\nn/ambient\np${orphan}\nn/fixture\n`;
    childProcess.spawnSync = ((command: string, args: string[]) => {
      const stdout = command === 'lsof' ? output : args[0] === '-axo'
        ? snapshot + (calls++ === 1 ? `${orphan} 1 ORPHAN\n` : '') : 'ORPHAN\n';
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

  it.each(['ambient', 'owned'])('classifies a late child of an %s parent using refreshed ancestry', kind => {
    const original = childProcess.spawnSync;
    const ambient = process.pid + 100_000, child = ambient + 1;
    let calls = 0;
    childProcess.spawnSync = ((command: string) => {
      const stdout = command === 'lsof' ? `p${child}\nn/fixture\n`
        : `${process.pid} 1 OWN\n${ambient} 1 AMBIENT\n` +
          (calls++ ? `${child} ${kind === 'owned' ? process.pid : ambient} CHILD\n` : '');
      return { pid: 1, status: 0, signal: null, stdout, stderr: '', output: [null, stdout, ''] };
    }) as typeof original;
    const restore = scopeFixtureProcesses('darwin');
    try {
      const result = spawnSync('lsof', ['-a', '-d', 'cwd', '-Fpn'], { encoding: 'utf8' }).stdout;
      expect(result).toBe(kind === 'owned' ? `p${child}\nn/fixture\n` : '');
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
      const own = spawnSync('ps', ['-U', String(process.getuid!()), '-o', 'pid=,lstart='], { encoding: 'utf8' });
      expect(own.status).toBe(0);
      expect(own.stdout.split('\n').map(line => Number(line.trim().split(/\s+/)[0]))).not.toContain(process.ppid);
      const asyncCwds = await new Promise<string>((resolve, reject) => execFile('lsof',
        ['-a', '-u', String(process.getuid!()), '-d', 'cwd', '-Fpn'], { encoding: 'utf8' },
        (error, stdout) => error && error.code !== 1 ? reject(error) : resolve(stdout)));
      expect(asyncCwds).not.toContain(`p${process.ppid}\n`);
      expect(asyncCwds).toContain(`p${holder.pid}\n`);
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
