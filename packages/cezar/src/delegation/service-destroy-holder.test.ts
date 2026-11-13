import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { agentTmpDir } from '../runs/agent-tmpdir.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { createFixtureManager } from '../workflows/fixture-claude.testkit.ts';
import { projectPaths } from '../project-paths.ts';
import { runWorktreeTeardown } from './worktree-teardown.ts';
import { f, linux, cadence, settled, destroyOf, useDestroyBackoffFixture } from './service-destroy-backoff.testkit.ts';

/** A process in its own group with its cwd in `root`, as a test server or file watcher a worktree
 * started for itself. */
async function worktreeService(root: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1e6)"], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  onTestFinished(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } });
  await new Promise(resolve => child.stdout!.once('data', resolve));
  return child;
}

/** A scratch directory outside every checkout, removed after the test. */
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cez-teardown-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The project's `worktreeTeardown` in its config file. */
function useTeardown(...commands: string[]): void {
  const dir = projectPaths(f.root).write; mkdirSync(dir, { recursive: true });
  const file = join(dir, 'config.json');
  const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  writeFileSync(file, JSON.stringify({ ...config, worktreeTeardown: { commands, timeoutSeconds: 10 } }));
}

/** A shell command that ends `pid` and returns once it is gone (bound: the teardown's 10 s timeout). */
const stop = (pid: number) => `kill ${pid}; while kill -0 ${pid} 2>/dev/null; do sleep 0.05; done`;

describe('destroy backoff holder', { timeout: 30_000 }, () => {
  useDestroyBackoffFixture();

  // hearsay-tools/squawk#914, hearsay-tools/squawk#1926: the worktree's own service holds it; the
  // project's teardown stops it before the holder scan, in the worktree.
  it.runIf(linux)("destroys in one call a worker whose own service holds its worktree, through the project's worktreeTeardown", async () => {
    await cadence();
    const { workerId, workspace } = await settled(false);
    const service = await worktreeService(workspace.path);
    const ran = join(scratchDir(), 'ran'); const path = realpathSync(workspace.path);
    useTeardown(`pwd -P > '${ran}'`, stop(service.pid!));
    expect(await f.service.destroy(f.caller, { workerId })).toMatchObject({ state: 'complete', remaining: [] });
    expect(readFileSync(ran, 'utf8').trim()).toBe(path);
    expect(existsSync(workspace.path)).toBe(false);
  });

  it.runIf(linux)('a failed worktreeTeardown ends in the refusal that names the holder, and a scheduled retry runs it again', async () => {
    await cadence({ fastMs: 200, fastCount: 10, capMs: 2_000 });
    const { workerId, workspace } = await settled(false);
    const holder = spawn('sleep', ['30'], { cwd: workspace.path, stdio: 'ignore' });
    onTestFinished(() => { holder.kill('SIGKILL'); });
    const calls = join(scratchDir(), 'calls');
    // The first run fails and stops nothing; the second stops the holder.
    const failing = `echo run >> '${calls}'; [ "$(wc -l < '${calls}')" -gt 1 ] || exit 3`;
    useTeardown(failing, stop(holder.pid!));
    const refused = await f.service.destroy(f.caller, { workerId });
    expect(refused).toMatchObject({ state: 'incomplete' });
    expect(refused.error).toMatch(new RegExp(`processes ${holder.pid} \\(sleep 30\\)`));
    expect(f.store.readEvents(workerId).filter(event => event.type === 'lifecycle' && String(event.message).startsWith('worktree teardown failed:')))
      .toEqual([expect.objectContaining({ message: expect.stringMatching(/^worktree teardown failed: `echo run .*` exited 3$/) })]);
    await vi.waitFor(() => expect(destroyOf(workerId)).toMatchObject({ phase: 'complete', remaining: [] }), { timeout: 10_000 });
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it.runIf(linux)('a project replaced while the worktree teardown runs starts no termination through the old manager', async () => {
    await cadence();
    const { workerId } = await settled(false);
    const dir = scratchDir(); const started = join(dir, 'started'); const gate = join(dir, 'release');
    useTeardown(`touch '${started}'; while [ ! -f '${gate}' ]; do sleep 0.05; done`);
    const termination = vi.spyOn(f.manager, 'awaitRunTermination');
    const explicit = f.service.destroy(f.caller, { workerId });
    await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 10_000 });
    const replacementManager = createFixtureManager(f.store, f.root);
    const detachReplacement = f.service.registerProject({ home: testHome(), id: 'project', root: f.root, store: f.store, manager: replacementManager });
    try {
      writeFileSync(gate, '');
      await expect(explicit).rejects.toThrow();
      expect(termination).not.toHaveBeenCalled();
    } finally { detachReplacement(); replacementManager.dispose(); }
  });

  // A destroy runs the teardown only in the worktree it owns: never in another checkout, even through a
  // worker path replaced by a symlink to it.
  it.runIf(linux)('never runs the worktreeTeardown in another checkout', async () => {
    const other = scratchDir();
    const { workspace } = await settled(false);
    renameSync(workspace.path, `${workspace.path}.moved`); symlinkSync(other, workspace.path);
    useTeardown('touch ran');
    expect(await runWorktreeTeardown({ root: f.root, home: testHome() }, workspace)).toBeUndefined();
    expect(existsSync(join(other, 'ran'))).toBe(false);
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
