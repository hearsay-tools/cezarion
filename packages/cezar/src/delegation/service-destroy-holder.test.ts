import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { DatabaseSync } from 'node:sqlite';

import { agentTmpDir } from '../runs/agent-tmpdir.ts';
import { leaseIdentity } from '../detached-process.ts';
import { stopWorktreeServices } from './worktree-services.ts';
import { f, linux, cadence, settled, destroyOf, useDestroyBackoffFixture } from './service-destroy-backoff.testkit.ts';

/** A process titled as Squeal titles its daemon, validating `root`, with its cwd there and its own
 * process group. */
async function fakeSquealDaemon(root: string): Promise<ChildProcess> {
  const title = `squeal repo daemon @0000 /cli/squeal.mjs daemon ${root}`;
  const child = spawn(process.execPath, ['-e', "process.title = process.argv[1]; console.log('ready'); setInterval(() => {}, 1e6)", title],
    { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  onTestFinished(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } });
  await new Promise(resolve => child.stdout!.once('data', resolve));
  return child;
}

/** A `squeal` on PATH that records its arguments and ends `pid`, as `squeal stop` ends its daemon.
 * Returns the recorded calls. */
function fakeSquealCli(pid: number): () => string {
  const bin = mkdtempSync(join(tmpdir(), 'cez-squeal-bin-')); const log = join(bin, 'calls');
  onTestFinished(() => rmSync(bin, { recursive: true, force: true }));
  // Like `squeal stop`, it returns once the daemon is gone (bound: 10 s).
  writeFileSync(join(bin, 'squeal'), `#!/bin/sh\necho "$@" >> '${log}'\nkill ${pid}\nfor i in $(seq 200); do kill -0 ${pid} 2>/dev/null || exit 0; sleep 0.05; done\n`); chmodSync(join(bin, 'squeal'), 0o755);
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  return () => { try { return readFileSync(log, 'utf8').trim(); } catch { return ''; } };
}

describe('destroy backoff holder', { timeout: 30_000 }, () => {
  useDestroyBackoffFixture();

  // hearsay-tools/squawk#914, hearsay-tools/squawk#1926: the daemon's test run holds the worktree,
  // and its e2e global setup holds the test-env lease, as Squeal runs the browser files.
  it.runIf(linux)("destroys in one call a worker whose own Squeal daemon holds its worktree and test-env lease", async () => {
    await cadence();
    const { workerId, workspace } = await settled(false);
    const daemon = await fakeSquealDaemon(workspace.path);
    const calls = fakeSquealCli(daemon.pid!);
    const qa = join(workspace.path, '.ai/qa'); mkdirSync(qa, { recursive: true });
    writeFileSync(join(qa, 'test-env.json'), JSON.stringify({ startedByThisRepo: true, status: 'stopped', app: {} }));
    const db = new DatabaseSync(join(qa, 'test-env-lease.sqlite'));
    try {
      db.exec('CREATE TABLE holders (id TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, start TEXT, pgid INTEGER)');
      db.prepare('INSERT INTO holders VALUES (?, ?, ?, ?, ?)').run('squeal', 'token', daemon.pid!, leaseIdentity(daemon.pid!).start!, daemon.pid!);
    } finally { db.close(); }
    expect(await f.service.destroy(f.caller, { workerId })).toMatchObject({ state: 'complete', remaining: [] });
    expect(calls()).toBe(`stop --until-start ${workspace.path}`);
    expect(existsSync(workspace.path)).toBe(false);
  });

  it.runIf(linux)("never stops another worktree's Squeal daemon", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'cez-other-worktree-'));
    onTestFinished(() => rmSync(elsewhere, { recursive: true, force: true }));
    const other = await fakeSquealDaemon(elsewhere);
    const calls = fakeSquealCli(other.pid!);
    const { workspace } = await settled(false);
    await stopWorktreeServices(workspace.path);
    expect(calls()).toBe('');
    expect(other.exitCode).toBeNull();
  });

  it.runIf(linux)('a holder that moves out of the worktree ends the skipping', async () => {
    await cadence({ fastMs: 200, fastCount: 10, capMs: 2_000 });
    const { workerId, workspace } = await settled(false);
    const child = spawn(process.execPath, ['-e', "console.log('ready'); process.stdin.on('data', () => { process.chdir('/'); console.log('moved'); })"],
      { cwd: workspace.path, stdio: ['pipe', 'pipe', 'ignore'] });
    onTestFinished(() => { child.kill('SIGKILL'); });
    const line = () => new Promise<void>(done => child.stdout!.once('data', () => done()));
    await line();
    expect(await f.service.destroy(f.caller, { workerId })).toMatchObject({ state: 'incomplete' });
    await vi.waitFor(() => expect(destroyOf(workerId)?.retry?.attempts).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    const moved = line(); child.stdin!.write('go\n'); await moved;
    // Still running, so only its cwd says it no longer holds anything.
    await vi.waitFor(() => expect(destroyOf(workerId)).toMatchObject({ phase: 'complete', remaining: [] }), { timeout: 10_000 });
    expect(child.exitCode).toBeNull();
  });

  it.runIf(linux)("a holder only the removal's own last check saw still ends the skipping when it exits", async () => {
    await cadence({ fastMs: 200, fastCount: 10, capMs: 2_000 });
    const { workerId, workspace } = await settled(false);
    // A locked worktree fails Git's removal after both holder checks pass, so ticks settle into skipping.
    execFileSync('git', ['worktree', 'lock', workspace.path], { cwd: f.root });
    expect(await f.service.destroy(f.caller, { workerId })).toMatchObject({ state: 'incomplete' });
    await vi.waitFor(() => expect(destroyOf(workerId)?.retry?.attempts).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    // The next full attempt: its own proof answers safe, then a process enters the worktree before the
    // removal's second check, the real race between the two scans.
    let late: ReturnType<typeof spawn> | undefined;
    const proof = f.store.workerResourceHolders.bind(f.store);
    vi.spyOn(f.store, 'workerResourceHolders').mockImplementation((...args) => {
      const answer = proof(...args);
      if (answer === 'safe' && !late) late = spawn('sleep', ['30'], { cwd: workspace.path, stdio: 'ignore' });
      return answer;
    });
    onTestFinished(() => { late?.kill('SIGKILL'); });
    execFileSync('git', ['worktree', 'unlock', workspace.path], { cwd: f.root });
    await vi.waitFor(() => expect(late).toBeDefined(), { timeout: 10_000 });
    await vi.waitFor(() => expect(destroyOf(workerId)?.error).toMatch(new RegExp(`processes ${late!.pid} \\(sleep 30\\)`)), { timeout: 10_000 });
    const exited = new Promise<void>(resolve => late!.once('exit', () => resolve()));
    late!.kill('SIGKILL'); await exited;
    await vi.waitFor(() => expect(destroyOf(workerId)).toMatchObject({ phase: 'complete', remaining: [] }), { timeout: 10_000 });
    expect(existsSync(workspace.path)).toBe(false);
  });

  it('a holder check that names no process is retried in full once its evidence is repaired, never skipped', async () => {
    await cadence({ fastMs: 200, fastCount: 10, capMs: 2_000 });
    const { workerId, workspace } = await settled(false);
    // A malformed fallback pointer leaves scratch ownership unproven: held, with no process to name and
    // nothing in the scratch directory's own stamp to show the repair.
    const scratch = agentTmpDir(join(f.root, '.ai/cezar'), workerId);
    mkdirSync(scratch, { recursive: true }); writeFileSync(join(scratch, '.cez-fallback'), '{not a pointer');
    expect(await f.service.destroy(f.caller, { workerId })).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
    await vi.waitFor(() => expect(destroyOf(workerId)?.retry?.attempts).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    expect(destroyOf(workerId)?.phase).toBe('incomplete');
    rmSync(join(scratch, '.cez-fallback'));
    await vi.waitFor(() => expect(destroyOf(workerId)).toMatchObject({ phase: 'complete', remaining: [] }), { timeout: 10_000 });
    expect(existsSync(workspace.path)).toBe(false);
  });
});
