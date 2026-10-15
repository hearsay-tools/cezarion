import { execFileSync, spawn } from 'node:child_process';
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual };
});

import { autosaveCommit } from './git-worktree.ts';
import { killFromPidFile, readPids, requirePid, writePidSource } from './pid-file.testkit.ts';

const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const budget = { timeoutMs: 500, killGraceMs: 100, confirmMs: 100 };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('autosave shutdown (#495)', () => {
  let repo: string;
  let bin: string;
  const jobs: Promise<unknown>[] = [];
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cez-autosave-bound-'));
    bin = mkdtempSync(join(tmpdir(), 'cez-autosave-bin-'));
    execFileSync(realGit, ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync(realGit, ['config', 'user.name', 'test'], { cwd: repo });
    execFileSync(realGit, ['config', 'user.email', 'test@local'], { cwd: repo });
    writeFileSync(join(repo, 'work.txt'), 'keep this work\n');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    if (process.platform === 'linux') {
      // These fixtures prove shutdown of their real Git children, not unrelated host tools
      // born during the save. Keep recorded descendants and every readable cwd; omit only
      // ambient permission-denied cwd entries. Other errors and group probes stay real.
      const readdir = fs.readdirSync;
      vi.spyOn(fs, 'readdirSync').mockImplementation(((...args: unknown[]) => {
        if (String(args[0]) !== '/proc') return Reflect.apply(readdir, fs, args);
        const recorded = readPids(join(bin, 'pid')).map(String);
        return readdir('/proc').filter(pid => {
          if (!/^\d+$/.test(pid) || recorded.includes(pid)) return true;
          try { fs.readlinkSync(`/proc/${pid}/cwd`); return true; }
          catch (error) { return !['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''); }
        });
      }) as typeof fs.readdirSync);
      syncBuiltinESMExports();
    }
  });
  afterEach(async () => {
    vi.restoreAllMocks(); syncBuiltinESMExports();
    // Also reaps the intentionally unbounded implementation during the red run.
    killFromPidFile(join(bin, 'pid'));
    await Promise.allSettled(jobs.splice(0));
    vi.unstubAllEnvs();
    rmSync(repo, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });
  function intercept(command: string, behavior: 'stall' | 'fail') {
    writeFileSync(join(bin, 'git'), `#!${process.execPath}\n
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes(${JSON.stringify(command)})) {
  ${writePidSource(join(bin, 'pid'), { append: true })}
  ${behavior === 'fail' ? 'process.exit(128);' : `process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(join(bin, 'term'))}, 'received'));
  setInterval(() => {}, 1000);`}
} else {
  const result = cp.spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  }
  async function save() {
    const job = autosaveCommit(repo, 'run finalize', budget);
    jobs.push(job);
    return Promise.race([job, delay(2500).then(() => 'still waiting')]);
  }
  for (const command of ['status', 'add', 'config', 'commit']) {
    it(`terminates resistant ${command}, reports failure and preserves files`, async () => {
      intercept(command, 'stall');
      expect(await save()).toBe('failed');
      expect(existsSync(join(bin, 'term'))).toBe(true);
      const pid = requirePid(join(bin, 'pid'));
      expect(() => process.kill(pid, 0)).toThrow();
      expect(readFileSync(join(repo, 'work.txt'), 'utf8')).toBe('keep this work\n');
      expect(execFileSync(realGit, ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toContain('work.txt');
    });
  }
  for (const command of ['status', 'add', 'config']) {
    it(`does not claim a save or commit after ${command} fails`, async () => {
      if (command === 'add') execFileSync(realGit, ['add', 'work.txt'], { cwd: repo });
      intercept(command, 'fail');
      expect(await save()).toBe('failed');
      expect(() => execFileSync(realGit, ['rev-parse', '--verify', 'HEAD'], { cwd: repo, stdio: 'pipe' })).toThrow();
    });
  }
  it('preserves a pre-existing agent while saving its worktree', async () => {
    const agent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: repo, stdio: 'ignore' });
    try {
      expect(await save()).toBe('committed');
      expect(() => process.kill(agent.pid!, 0)).not.toThrow();
    } finally {
      agent.kill('SIGKILL');
      await new Promise(resolve => agent.once('exit', resolve));
    }
  });
  it('serializes overlapping autosaves without losing later work', async () => {
    const first = autosaveCommit(repo, 'periodic', budget);
    const second = autosaveCommit(repo, 'run finalize', budget);
    jobs.push(first, second);
    expect(await first).toBe('committed');
    expect(await second).toBe('nothing-to-do');
    expect(execFileSync(realGit, ['show', 'HEAD:work.txt'], { cwd: repo, encoding: 'utf8' })).toBe('keep this work\n');
  });
  it('terminates descendants after the Git leader exits with closed pipes', async () => {
    const descendant = join(bin, 'descendant.cjs');
    writeFileSync(descendant, `
process.on('SIGTERM', () => {});
${writePidSource(join(bin, 'pid'))}
setInterval(() => {}, 1000);
`);
    writeFileSync(join(bin, 'git'), `#!${process.execPath}\n
const fs = require('node:fs');
require('node:child_process').spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: 'ignore' }).unref();
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(join(bin, 'pid'))})) { clearInterval(timer); process.exit(0); }
}, 5);
`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    expect(await save()).toBe('failed');
    const pid = requirePid(join(bin, 'pid'));
    // Linux init may retain an exited grandchild as a zombie; it cannot write.
    if (existsSync(`/proc/${pid}/stat`)) {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      expect(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[0]).toBe('Z');
    } else expect(() => process.kill(pid, 0)).toThrow();
    expect(readFileSync(join(repo, 'work.txt'), 'utf8')).toBe('keep this work\n');
  });
  it.each([false, true])('waits for a detached descendant after leader exit (stalled=%s)', async stalled => {
    const descendant = join(bin, 'detached.cjs');
    writeFileSync(descendant, `
const fs = require('node:fs');
${writePidSource(join(bin, 'pid'))}
setTimeout(() => { fs.writeFileSync('late.txt', 'last write'); process.exit(0); }, 1400);
`);
    writeFileSync(join(bin, 'git'), `#!${process.execPath}\n
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('status')) {
  require('node:child_process').spawn(process.execPath, [${JSON.stringify(descendant)}], { detached: true, stdio: 'ignore' }).unref();
  process.on('SIGTERM', () => {});
  const timer = setInterval(() => {
    if (fs.existsSync(${JSON.stringify(join(bin, 'pid'))}) && !${stalled}) { clearInterval(timer); process.exit(0); }
  }, 5);
} else process.exit(0);
`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    let settled = false;
    const job = autosaveCommit(repo, 'run finalize', budget).then(result => { settled = true; return result; });
    jobs.push(job);
    await delay(1000);
    expect(settled).toBe(false);
    expect(await Promise.race([job, delay(2000).then(() => 'still waiting')])).toBe('failed');
    expect(readFileSync(join(repo, 'late.txt'), 'utf8')).toBe('last write');
  });
  it('keeps the save pending when termination cannot be proven', async () => {
    intercept('status', 'stall');
    const kill = process.kill.bind(process);
    let obscure = true;
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid < 0 && signal === 0 && obscure) throw Object.assign(new Error('unreadable'), { code: 'EPERM' });
      return kill(pid, signal);
    });
    // SIGKILL can leave a /proc zombie that autosave treats as proof of death,
    // so the save settles and `onBlocked` never reports EPERM. Hide that pid
    // from the async group scan while the probe is obscured (#950).
    const actualReaddir = fsPromises.readdir.bind(fsPromises);
    vi.spyOn(fsPromises, 'readdir').mockImplementation((async (path: Parameters<typeof actualReaddir>[0], options?: Parameters<typeof actualReaddir>[1]) => {
      const entries = await actualReaddir(path, options as never);
      if (String(path) !== '/proc' || !obscure) return entries;
      const recorded = readPids(join(bin, 'pid')).map(String);
      return (entries as string[]).filter(entry => !recorded.includes(String(entry)));
    }) as typeof fsPromises.readdir);
    let settled = false;
    const blocked = vi.fn();
    const job = autosaveCommit(repo, 'run finalize', { ...budget, onBlocked: blocked }).then(result => { settled = true; return result; });
    jobs.push(job);
    try {
      await vi.waitFor(() => { expect(blocked).toHaveBeenCalled(); }, { timeout: 10_000, interval: 10 });
      expect(settled).toBe(false);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('termination'));
      expect(blocked).toHaveBeenCalledWith(expect.stringContaining('EPERM'), expect.objectContaining({ groups: expect.any(Array) }));
      expect(blocked).toHaveBeenCalledWith(expect.stringContaining('process group'), expect.objectContaining({ groups: expect.any(Array) }));
    } finally { obscure = false; }
    expect(await Promise.race([job, delay(1000).then(() => 'still waiting')])).toBe('failed');
  }, 15_000);
});
