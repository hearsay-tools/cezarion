import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autosaveGit } from './autosave-git.ts';
import { autosaveCommit } from './git-worktree.ts';
import { killFromPidFile, requirePid, writePidSource } from './pid-file.testkit.ts';

const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const gone = (pid: number) => { try { process.kill(pid, 0); return !existsSync(`/proc/${pid}/stat`) || readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z'); } catch { return true; } };

// hearsay-tools/cezarion#958: a process merely born in the worktree during a save
// (Squeal's Vitest workers, an agent tool) is not Git's. Attribution follows Git's
// own process tree, so it neither fails a successful command nor holds cleanup.
describe.runIf(process.platform === 'linux')('autosave holder attribution (#958)', () => {
  let repo: string;
  let bin: string;
  const unrelated: ChildProcess[] = [];
  const jobs: Promise<unknown>[] = [];
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cez-autosave-owner-'));
    bin = mkdtempSync(join(tmpdir(), 'cez-autosave-owner-bin-'));
    execFileSync(realGit, ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync(realGit, ['config', 'user.name', 'test'], { cwd: repo });
    execFileSync(realGit, ['config', 'user.email', 'test@local'], { cwd: repo });
    writeFileSync(join(repo, 'work.txt'), 'keep this work\n');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    for (const child of unrelated.splice(0)) child.kill('SIGKILL');
    killFromPidFile(join(bin, 'pid'));
    await Promise.allSettled(jobs.splice(0));
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    rmSync(repo, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });
  /** An unrelated process in the worktree; it records any signal it receives. */
  function startUnrelated(ms: number) {
    const child = spawn(process.execPath, ['-e', `
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => require('node:fs').writeFileSync(${JSON.stringify(join(bin, 'signalled'))}, signal));
setTimeout(() => {}, ${ms});`], { cwd: repo, stdio: 'ignore' });
    unrelated.push(child);
    return child;
  }

  it('completes a successful status while an unrelated process starts in the worktree', async () => {
    const started = Date.now();
    const warnings: string[] = [];
    const job = autosaveGit(repo, ['status', '--porcelain'], { timeoutMs: 800, killGraceMs: 20, confirmMs: 20, onWarning: message => warnings.push(message) });
    const timer = startUnrelated(1800);
    expect(await job).toEqual({ ok: true, stdout: '?? work.txt\n', code: 0 });
    expect(Date.now() - started).toBeLessThan(800);
    expect(warnings).toEqual([]);
    expect(timer.exitCode).toBeNull();
    expect(existsSync(join(bin, 'signalled'))).toBe(false);
  });

  it('commits through continuous unrelated process churn without a timeout or a cleanup hold', async () => {
    let churning = true;
    const churn = (async () => { while (churning) { startUnrelated(60); await delay(15); } })();
    try {
      const started = Date.now();
      const warnings: string[] = [];
      const job = autosaveCommit(repo, 'run finalize', { timeoutMs: 1500, killGraceMs: 50, confirmMs: 50, onWarning: message => warnings.push(message) });
      jobs.push(job);
      expect(await Promise.race([job, delay(3000).then(() => 'still waiting')])).toBe('committed');
      expect(Date.now() - started).toBeLessThan(1500);
      expect(warnings).toEqual([]);
    } finally { churning = false; await churn; }
    expect(execFileSync(realGit, ['show', 'HEAD:work.txt'], { cwd: repo, encoding: 'utf8' })).toBe('keep this work\n');
    expect(existsSync(join(bin, 'signalled'))).toBe(false);
  });

  it('retains a detached Git descendant, names only it, and leaves the unrelated holder alone', async () => {
    const descendant = join(bin, 'detached.cjs');
    writeFileSync(descendant, `
const fs = require('node:fs');
${writePidSource(join(bin, 'pid'), { append: true })}
setTimeout(() => { fs.writeFileSync('late.txt', 'last write'); process.exit(0); }, 1200);
`);
    writeFileSync(join(bin, 'git'), `#!${process.execPath}\n
require('node:child_process').spawn(process.execPath, [${JSON.stringify(descendant)}], { detached: true, stdio: 'ignore' }).unref();
setTimeout(() => process.exit(0), 50);
`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    const other = startUnrelated(5000);
    const blocked = vi.fn();
    let settled = false;
    const job = autosaveGit(repo, ['status'], { timeoutMs: 300, killGraceMs: 50, confirmMs: 50, onBlocked: blocked })
      .then(result => { settled = true; return result; });
    jobs.push(job);
    await delay(700);
    expect(settled).toBe(false);
    const holder = requirePid(join(bin, 'pid'));
    const proofs = blocked.mock.calls.map(([, proof]) => proof as { processes: { pid: number }[] });
    expect(proofs.at(-1)?.processes.map(entry => entry.pid)).toEqual([holder]);
    expect(proofs.flatMap(proof => proof.processes.map(entry => entry.pid))).not.toContain(other.pid);
    expect(await Promise.race([job, delay(2000).then(() => 'still waiting')])).toEqual({ ok: false, stdout: '', code: null });
    expect(readFileSync(join(repo, 'late.txt'), 'utf8')).toBe('last write');
    expect(other.exitCode).toBeNull();
    expect(existsSync(join(bin, 'signalled'))).toBe(false);
  });

  it('bounds cleanup warnings while the retained descendants keep changing PIDs', async () => {
    const descendant = join(bin, 'churn.cjs');
    writeFileSync(descendant, `
const fs = require('node:fs');
const cp = require('node:child_process');
${writePidSource(join(bin, 'pid'), { append: true })}
// Each short-lived child is a new Git descendant in the worktree.
const timer = setInterval(() => cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 40)'], { stdio: 'ignore' }), 25);
setTimeout(() => { clearInterval(timer); setTimeout(() => process.exit(0), 100); }, 1600);
`);
    writeFileSync(join(bin, 'git'), `#!${process.execPath}\n
require('node:child_process').spawn(process.execPath, [${JSON.stringify(descendant)}], { detached: true, stdio: 'ignore' }).unref();
setTimeout(() => process.exit(0), 50);
`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    const warnings: string[] = [];
    const blocked = vi.fn();
    const job = autosaveGit(repo, ['status'], { timeoutMs: 200, killGraceMs: 20, confirmMs: 20, onWarning: message => warnings.push(message), onBlocked: blocked });
    jobs.push(job);
    expect(await Promise.race([job, delay(4000).then(() => 'still waiting')])).toEqual({ ok: false, stdout: '', code: null });
    // The durable proof follows every change; the transcript does not.
    expect(new Set(blocked.mock.calls.map(([, proof]) => JSON.stringify(proof))).size).toBeGreaterThan(5);
    expect(warnings.length).toBeLessThanOrEqual(6);
    expect(warnings.at(-1)).toContain('suppressed');
    const holder = requirePid(join(bin, 'pid'));
    expect(gone(holder)).toBe(true);
  });
});
