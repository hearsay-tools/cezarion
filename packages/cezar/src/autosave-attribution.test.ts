import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autosaveGit, withAutosaveGit } from './autosave-git.ts';
import * as holders from './autosave-holders.ts';
import { autosaveCommit } from './autosave-commit.ts';
import { killFromPidFile, readPids, requirePid, writePidSource } from './pid-file.testkit.ts';

const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
// Captured before any case fakes the product's timers, so the test's own waits stay real.
const realSetTimeout = globalThis.setTimeout;
const delay = (ms: number) => new Promise(resolve => realSetTimeout(resolve, ms));
/** Hang guard for a wait on a product or fixture signal; it bounds a hang, not a duration. */
const HANG_CEILING_MS = 10_000;
async function until(condition: () => boolean, what: string) {
  for (const deadline = Date.now() + HANG_CEILING_MS; !condition();) {
    if (Date.now() > deadline) throw new Error(`still waiting for ${what} after ${HANG_CEILING_MS} ms`);
    await delay(10);
  }
}
const gone = (pid: number) => { try { process.kill(pid, 0); return !existsSync(`/proc/${pid}/stat`) || readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z'); } catch { return true; } };

// hearsay-tools/cezarion#958: a process merely born in the worktree during a save
// (Squeal's Vitest workers, an agent tool) is not Git's. Attribution follows Git's
// own process tree, so it neither fails a successful command nor holds cleanup.
describe.runIf(process.platform === 'linux')('autosave holder attribution (#958)', () => {
  let repo: string;
  let bin: string;
  const unrelated: ChildProcess[] = [];
  const jobs: Promise<unknown>[] = [];
  let clock: { start: () => void; stop: () => void } | undefined;
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
    // A pending save polls on the held clock: it must keep running until the save settles.
    clock?.start();
    await Promise.allSettled(jobs.splice(0));
    clock?.stop(); clock = undefined;
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
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
  /*
   * The product's timers, held still until the fixture is in place (hearsay-tools/cezarion#1108).
   *
   * `autosaveGit` arms `timeoutMs` when it spawns Git, and the two detached-descendant cases
   * need Git to have launched its descendant BEFORE that timeout stops Git's process group.
   * Their fake Git is a Node script, so with a 200-300 ms timeout the case assumed a Node
   * startup always fits in it. At load 40-75 on 24 cores it did not: the timeout killed the
   * fake before it spawned anything, the product correctly settled with nothing to retain,
   * and the cases failed with `expected true to be false` (settled at 700 ms) and
   * `expected 1 to be greater than 5` (one proof). A 400 ms stall injected at the top of the
   * fake Git reproduces both signatures exactly. The product is right to kill a Git that
   * outlives its budget; the cases' precondition was a wall-clock guess.
   *
   * So the case fakes only `setTimeout`/`clearTimeout` (process exits, /proc and the clock
   * stay real), waits for the descendant to publish its pid (written after Node detached
   * it into its own session), and only then lets the product's clock run, at real pace.
   * That wait also replaces the old `delay(700)` before reading the pid file: an 800 ms
   * stall at the top of the descendant reproduces its `pid file … "<ENOENT>"` miss. After
   * the gate, the cases wait for the product's own `onBlocked` proofs and release the
   * descendant themselves, so no fixed lifetime races the product's /proc observation.
   */
  function holdProductClock() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let running = false;
    let last = 0;
    const tick = () => {
      if (!running) return;
      const now = Date.now();
      vi.advanceTimersByTime(now - last);
      last = now;
      realSetTimeout(tick, 5);
    };
    clock = {
      start: () => { if (running) return; running = true; last = Date.now(); tick(); },
      stop: () => { running = false; },
    };
    return clock;
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
    // bound: a load generator, not a poll; the `finally` below clears `churning` and awaits it.
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
    const release = join(bin, 'release');
    // The descendant holds the worktree until the case has seen the product name it, rather
    // than for a fixed 1.2 s that a loaded host could spend before the first /proc scan (#1108).
    writeFileSync(descendant, `
const fs = require('node:fs');
${writePidSource(join(bin, 'pid'), { append: true })}
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(release)})) return;
  clearInterval(timer);
  fs.writeFileSync('late.txt', 'last write');
  process.exit(0);
}, 10);
`);
    writeFileSync(join(bin, 'git'), `#!${process.execPath}\n
require('node:child_process').spawn(process.execPath, [${JSON.stringify(descendant)}], { detached: true, stdio: 'ignore' }).unref();
setTimeout(() => process.exit(0), 50);
`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    // Outlives the case on purpose; afterEach kills it. Its lifetime is no bound.
    const other = startUnrelated(10 * HANG_CEILING_MS);
    const blocked = vi.fn();
    let settled = false;
    const productClock = holdProductClock();
    const job = autosaveGit(repo, ['status'], { timeoutMs: 300, killGraceMs: 50, confirmMs: 50, onBlocked: blocked })
      .then(result => { settled = true; return result; });
    jobs.push(job);
    await until(() => readPids(join(bin, 'pid')).length > 0, 'the detached descendant to publish its pid');
    const holder = requirePid(join(bin, 'pid'));
    productClock.start();
    const proofs = () => blocked.mock.calls.map(([, proof]) => proof as { processes: { pid: number }[] });
    // A save that settles first never retained the descendant: that ends the wait and fails below.
    await until(() => settled || proofs().at(-1)?.processes.some(entry => entry.pid === holder) === true, 'a blocked proof naming the descendant');
    expect(settled).toBe(false);
    expect(proofs().at(-1)?.processes.map(entry => entry.pid)).toEqual([holder]);
    expect(proofs().flatMap(proof => proof.processes.map(entry => entry.pid))).not.toContain(other.pid);
    writeFileSync(release, '');
    expect(await Promise.race([job, delay(HANG_CEILING_MS).then(() => 'still waiting')])).toEqual({ ok: false, stdout: '', code: null });
    // The save settled only after the descendant's last write.
    expect(readFileSync(join(repo, 'late.txt'), 'utf8')).toBe('last write');
    expect(other.exitCode).toBeNull();
    expect(existsSync(join(bin, 'signalled'))).toBe(false);
  });

  // Review of hearsay-tools/squawk#3545: the save observes each command's descendants when the
  // command ends, so one that leaves the worktree before the save's last command stays retained.
  it('retains a descendant of an early command that leaves the worktree before the save ends', async () => {
    const descendant = join(bin, 'mover.cjs');
    const move = join(bin, 'move');
    const release = join(bin, 'release');
    writeFileSync(descendant, `
const fs = require('node:fs');
${writePidSource(join(bin, 'pid'), { append: true })}
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(move)}) && process.cwd() !== ${JSON.stringify(bin)}) process.chdir(${JSON.stringify(bin)});
  if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); process.exit(0); }
}, 10);
`);
    // Only the first command, `status`, starts the detached descendant.
    writeFileSync(join(bin, 'git'), `#!${process.execPath}\n
if (process.argv.includes('status')) require('node:child_process').spawn(process.execPath, [${JSON.stringify(descendant)}], { detached: true, stdio: 'ignore' }).unref();
setTimeout(() => process.exit(0), 50);
`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    const blocked = vi.fn();
    let settled = false;
    const productClock = holdProductClock();
    const job = withAutosaveGit(repo, { timeoutMs: 300, killGraceMs: 50, confirmMs: 50, onBlocked: blocked }, 'unsuccessful', async git => {
      await git(['status']);
      await until(() => readPids(join(bin, 'pid')).length > 0, 'the detached descendant to publish its pid');
      const holder = requirePid(join(bin, 'pid'));
      writeFileSync(move, '');
      await until(() => readlinkSync(`/proc/${holder}/cwd`) === bin, 'the descendant to leave the worktree');
      await git(['rev-parse']);
      return 'saved';
    }).then(result => { settled = true; return result; });
    jobs.push(job);
    await until(() => existsSync(move), 'the first command to end');
    const holder = requirePid(join(bin, 'pid'));
    productClock.start();
    const proofs = () => blocked.mock.calls.map(([, proof]) => proof as { processes: { pid: number }[] });
    // A save that settles first never retained the descendant: that ends the wait and fails below.
    await until(() => settled || proofs().at(-1)?.processes.some(entry => entry.pid === holder) === true, 'a blocked proof naming the descendant');
    expect(settled).toBe(false);
    writeFileSync(release, '');
    expect(await Promise.race([job, delay(HANG_CEILING_MS).then(() => 'still waiting')])).toBe('unsuccessful');
  });

  // Review round 2 of hearsay-tools/squawk#3545: each check reads every cwd again, so a descendant
  // first seen outside the worktree is retained once it enters it.
  it('retains a descendant that starts outside the worktree and enters it during the save', async () => {
    const descendant = join(bin, 'enterer.cjs');
    const enter = join(bin, 'enter');
    const release = join(bin, 'release');
    writeFileSync(descendant, `
const fs = require('node:fs');
${writePidSource(join(bin, 'pid'), { append: true })}
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(enter)}) && process.cwd() !== ${JSON.stringify(repo)}) process.chdir(${JSON.stringify(repo)});
  if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); process.exit(0); }
}, 10);
`);
    // Only the first command, `status`, starts the detached descendant, outside the worktree.
    writeFileSync(join(bin, 'git'), `#!${process.execPath}\n
if (process.argv.includes('status')) require('node:child_process').spawn(process.execPath, [${JSON.stringify(descendant)}], { cwd: ${JSON.stringify(bin)}, detached: true, stdio: 'ignore' }).unref();
setTimeout(() => process.exit(0), 50);
`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    const blocked = vi.fn();
    let settled = false;
    const productClock = holdProductClock();
    const job = withAutosaveGit(repo, { timeoutMs: 300, killGraceMs: 50, confirmMs: 50, onBlocked: blocked }, 'unsuccessful', async git => {
      await git(['status']);
      await until(() => readPids(join(bin, 'pid')).length > 0, 'the detached descendant to publish its pid');
      const holder = requirePid(join(bin, 'pid'));
      writeFileSync(enter, '');
      await until(() => readlinkSync(`/proc/${holder}/cwd`) === repo, 'the descendant to enter the worktree');
      await git(['rev-parse']);
      return 'saved';
    }).then(result => { settled = true; return result; });
    jobs.push(job);
    await until(() => existsSync(enter), 'the first command to end');
    const holder = requirePid(join(bin, 'pid'));
    productClock.start();
    const proofs = () => blocked.mock.calls.map(([, proof]) => proof as { processes: { pid: number }[] });
    await until(() => settled || proofs().at(-1)?.processes.some(entry => entry.pid === holder) === true, 'a blocked proof naming the descendant');
    expect(settled).toBe(false);
    writeFileSync(release, '');
    expect(await Promise.race([job, delay(HANG_CEILING_MS).then(() => 'still waiting')])).toBe('unsuccessful');
  });

  // CodeRabbit on hearsay-tools/squawk#3545: a holder an earlier command left may have moved out
  // of the worktree, where the restart-time cwd scan cannot find it, so every proof names it.
  it('names the holders earlier commands left in a later command\'s blocked proof', async () => {
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nfor a; do [ "$a" = stall ] && exec sleep 30; done\nexit 0\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    let held = true;
    const left = { pid: 4242, startToken: 'left-by-the-first-command' };
    vi.spyOn(holders, 'watchAutosaveHolders').mockResolvedValue(Object.assign(async () => held,
      { diagnostics: () => ({ pids: held ? [left.pid] : [], processes: held ? [left] : [], inspectionFailed: false }) }));
    // The stalled command's group stays unproven until the case lifts this.
    let obscure = true;
    const kill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid < 0 && signal === 0 && obscure) throw Object.assign(new Error('unreadable'), { code: 'EPERM' });
      return kill(pid, signal);
    });
    const blocked = vi.fn();
    const job = withAutosaveGit(repo, { timeoutMs: 100, killGraceMs: 20, confirmMs: 20, onBlocked: blocked }, 'unsuccessful', async git => {
      await git(['first']);
      return (await git(['stall'])).ok ? 'saved' : 'unsuccessful';
    });
    jobs.push(job);
    await until(() => blocked.mock.calls.length > 0, 'the stalled command to report blocked');
    expect(blocked.mock.calls[0]![1]).toMatchObject({ processes: expect.arrayContaining([left]), groups: [expect.any(Number)] });
    obscure = false; held = false;
    expect(await Promise.race([job, delay(HANG_CEILING_MS).then(() => 'still waiting')])).toBe('unsuccessful');
  });

  // Review round 3 of hearsay-tools/squawk#3545: the caller does more work after its last Git
  // command (the conflict-marker reads), so the save scans again once `run` returns.
  it('waits for a holder that appears after the last Git command\'s check', async () => {
    let held = false;
    const late = { pid: 4343, startToken: 'after-the-last-command' };
    vi.spyOn(holders, 'watchAutosaveHolders').mockResolvedValue(Object.assign(async () => held,
      { diagnostics: () => ({ pids: held ? [late.pid] : [], processes: held ? [late] : [], inspectionFailed: false }) }));
    const blocked = vi.fn();
    const job = withAutosaveGit(repo, { timeoutMs: 100, killGraceMs: 20, confirmMs: 20, onBlocked: blocked }, 'unsuccessful', async git => {
      await git(['status', '--porcelain']);
      held = true;
      return 'refused';
    });
    jobs.push(job);
    await until(() => blocked.mock.calls.length > 0, 'the save to report the late holder');
    expect(blocked.mock.calls[0]![1]).toMatchObject({ processes: [late] });
    held = false;
    expect(await Promise.race([job, delay(HANG_CEILING_MS).then(() => 'still waiting')])).toBe('unsuccessful');
  });

  // CodeRabbit on hearsay-tools/squawk#3545: a caller that throws still waits for Git's descendants.
  it('waits for observed holders before a failing save rejects', async () => {
    let held = true;
    const left = { pid: 4545, startToken: 'left-before-the-throw' };
    vi.spyOn(holders, 'watchAutosaveHolders').mockResolvedValue(Object.assign(async () => held,
      { diagnostics: () => ({ pids: held ? [left.pid] : [], processes: held ? [left] : [], inspectionFailed: false }) }));
    const blocked = vi.fn();
    let settled = false;
    const job = withAutosaveGit(repo, { timeoutMs: 100, killGraceMs: 20, confirmMs: 20, onBlocked: blocked }, 'unsuccessful', async git => {
      await git(['status']);
      throw new Error('unexpected');
    }).finally(() => { settled = true; });
    const rejected = job.catch((error: Error) => error.message);
    await until(() => settled || blocked.mock.calls.length > 0, 'the save to report the held worktree');
    expect(settled).toBe(false);
    held = false;
    expect(await Promise.race([rejected, delay(HANG_CEILING_MS).then(() => 'still waiting')])).toBe('unexpected');
  });

  // Review round 3 of hearsay-tools/squawk#3545: the proof is compared after the holders are
  // merged in, so a new incarnation of the same PID and executable reaches the evidence.
  it('reports a new incarnation of the same holder PID', async () => {
    let held = true;
    let holder = { pid: 4444, startToken: 'first' };
    vi.spyOn(holders, 'watchAutosaveHolders').mockResolvedValue(Object.assign(async () => held,
      { diagnostics: () => ({ pids: held ? [holder.pid] : [], processes: held ? [holder] : [], inspectionFailed: false }) }));
    const blocked = vi.fn();
    const job = withAutosaveGit(repo, { timeoutMs: 100, killGraceMs: 20, confirmMs: 20, onBlocked: blocked }, 'unsuccessful', async git => (await git(['status'])).ok ? 'saved' : 'failed');
    jobs.push(job);
    const tokens = () => blocked.mock.calls.flatMap(([, proof]) => (proof as { processes: { startToken?: string }[] }).processes.map(entry => entry.startToken));
    await until(() => tokens().includes('first'), 'a proof naming the first incarnation');
    holder = { pid: 4444, startToken: 'second' };
    await until(() => tokens().includes('second'), 'a proof naming the second incarnation');
    held = false;
    expect(await Promise.race([job, delay(HANG_CEILING_MS).then(() => 'still waiting')])).toBe('unsuccessful');
  });

  it('bounds cleanup warnings while the retained descendants keep changing PIDs', async () => {
    const descendant = join(bin, 'churn.cjs');
    const release = join(bin, 'release');
    // The churn lasts until the case has seen enough distinct proofs, not for a fixed 1.6 s
    // (#1108). How many changes the product observes in a fixed window depends on how often
    // a loaded host lets the churn spawn and the product scan /proc; the contract is that the
    // proof follows every change it observes while the transcript stays bounded.
    writeFileSync(descendant, `
const fs = require('node:fs');
const cp = require('node:child_process');
${writePidSource(join(bin, 'pid'), { append: true })}
// Each short-lived child is a new Git descendant in the worktree.
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); setTimeout(() => process.exit(0), 100); return; }
  cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 40)'], { stdio: 'ignore' });
}, 25);
`);
    writeFileSync(join(bin, 'git'), `#!${process.execPath}\n
require('node:child_process').spawn(process.execPath, [${JSON.stringify(descendant)}], { detached: true, stdio: 'ignore' }).unref();
setTimeout(() => process.exit(0), 50);
`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    const warnings: string[] = [];
    const blocked = vi.fn();
    const productClock = holdProductClock();
    let settled = false;
    const job = autosaveGit(repo, ['status'], { timeoutMs: 200, killGraceMs: 20, confirmMs: 20, onWarning: message => warnings.push(message), onBlocked: blocked })
      .then(result => { settled = true; return result; });
    jobs.push(job);
    await until(() => readPids(join(bin, 'pid')).length > 0, 'the churning descendant to publish its pid');
    const holder = requirePid(join(bin, 'pid'));
    productClock.start();
    // The durable proof follows every change; the transcript does not.
    const distinctProofs = () => new Set(blocked.mock.calls.map(([, proof]) => JSON.stringify(proof))).size;
    await until(() => settled || distinctProofs() > 5, 'more than five distinct blocked proofs');
    expect(settled).toBe(false);
    writeFileSync(release, '');
    expect(await Promise.race([job, delay(HANG_CEILING_MS).then(() => 'still waiting')])).toEqual({ ok: false, stdout: '', code: null });
    expect(distinctProofs()).toBeGreaterThan(5);
    // One timeout warning, BLOCKED_WARNINGS (3) blocked reports, one suppression notice.
    expect(warnings.length).toBeLessThanOrEqual(6);
    expect(warnings.at(-1)).toContain('suppressed');
    expect(gone(holder)).toBe(true);
  });
});
