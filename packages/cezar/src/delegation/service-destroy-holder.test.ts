import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { agentTmpDir } from '../runs/agent-tmpdir.ts';
import { f, linux, cadence, settled, destroyOf, useDestroyBackoffFixture } from './service-destroy-backoff.testkit.ts';

describe('destroy backoff holder', { timeout: 30_000 }, () => {
  useDestroyBackoffFixture();

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
    await vi.waitFor(() => expect(destroyOf(workerId)?.error).toMatch(new RegExp(`processes ${late!.pid}\\b`)), { timeout: 10_000 });
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
