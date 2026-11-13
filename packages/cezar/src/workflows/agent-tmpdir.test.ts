import { Home } from '../home/home.ts';
import { useTestHome } from '../home/test-home.testkit.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { execFileSync } from 'node:child_process';
import { agentEnv, agentEnvForStep } from './run/launch-context.ts';
import { terminalScratchDisposition } from './run/run-settlement.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { createFixtureManager, drainFixtureManagers } from './fixture-claude.testkit.ts';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunStore } from '../runs/store.ts';
import {
  AgentTempDirError,
  MAX_SOCKET_SAFE_DIR_LENGTH,
  agentTmpDir,
  resolveAgentTmpDir,
  removeAgentTmpDir,
} from '../runs/agent-tmpdir.ts';
import { registerProject } from '../workspace/projects.ts';
import { RunManager, agentDirectories } from './run.ts';

/** Hang guard for the waits below: each ends the moment its condition holds, so the bound only ends a hang. */
const HANG_GUARD_MS = 15_000;

/**
 * #785 wiring: the per-run temp directory has to reach the SPAWN, be gone when
 * the run ends, and fail the run loudly when it cannot be had.
 *
 * Exercised at the `agentEnvForStep` seam — the last common path before every
 * backend spawn — for the same reason the agent-profile tests use it: the point
 * under test is the exact environment handed to the child, and a dry run would
 * prove nothing (the mock CLI does not echo its environment).
 */
describe('RunManager — task-scoped agent TMPDIR (#785)', () => {
  const savedHome = process.env.CEZ_HOME;
  let home: string;
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let manager: RunManager;

  const resolveStepEnv = (runId: string, backend: Parameters<typeof agentEnvForStep>[3], options?: Parameters<typeof agentEnvForStep>[4]) => {
    const context = { home: testHome(), store, repoRoot, dataDir };
    return agentEnvForStep(context, { agentEnv: id => agentEnv(context, undefined, id), workerStep: () => undefined }, runId, backend, options);
  };

  beforeEach(async () => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-agent-tmpdir-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-agent-tmpdir-repo-'));
    dataDir = join(repoRoot, '.ai/cezar');
    useTestHome(home ? Home.sandbox(home) : undefined);
    store = RunStore.open(dataDir);
    manager = createFixtureManager(store, repoRoot);
    await registerProject(repoRoot, undefined, testHome());
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    manager.dispose();
    vi.unstubAllEnvs();
    for (const run of store.listRuns()) removeAgentTmpDir(dataDir, run.id);
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) useTestHome(undefined);
    else useTestHome(savedHome ? Home.sandbox(savedHome) : undefined);
  });

  const newRun = () =>
    store.createRun({
      title: 't',
      workflow: 'w',
      task: 't',
      steps: [{ id: 's', name: 's', kind: STEP_KIND.agent }],
    });

  it('hands the spawn the resolved per-run TMPDIR, already created', async () => {
    const run = newRun();
    const { env } = await resolveStepEnv(run.id, 'claude');
    // The exact location is `resolveAgentTmpDir`'s call — repo-local when the
    // checkout is shallow enough for unix-socket paths (#387), a short
    // OS-temp directory when it is not. The spawn seam pins the resolution.
    expect(env.TMPDIR).toBe(resolveAgentTmpDir(dataDir, run.id));
    expect(env.TEMP).toBe(env.TMPDIR);
    expect(env.TMP).toBe(env.TMPDIR);
    // Created BEFORE the backend spawns — the backend roots its own scratch tree
    // at `os.tmpdir()` the moment it starts.
    expect(existsSync(env.TMPDIR as string)).toBe(true);
  });

  it('gives two runs on the same machine separate directories', async () => {
    const [a, b] = [newRun(), newRun()];
    const envA = (await resolveStepEnv(a.id, 'claude')).env;
    const envB = (await resolveStepEnv(b.id, 'claude')).env;
    expect(envA.TMPDIR).not.toBe(envB.TMPDIR);
  });

  it.each(['done', 'review', 'failed', 'cancelled'] as const)('reaps the directory when a %s run leaves the active registry', async status => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: repoRoot });
    vi.stubEnv('CEZ_DRY_RUN', '1'); vi.stubEnv('CEZ_AUTONAME', '0'); vi.stubEnv('CEZ_MOCK_NOTES', '0');
    vi.stubEnv('CEZ_REVIEW_GATE', status === 'review' ? '1' : '0');
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:cezar-ask' });
    // bound: the native tool's pending question is the safe input boundary.
    await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe('waiting'), { timeout: HANG_GUARD_MS });
    const scratch = resolveAgentTmpDir(dataDir, run.id);
    writeFileSync(join(scratch, 'scratch'), 'x', 'utf8');
    if (status === 'review') writeFileSync(join(store.getRun(run.id)!.worktreePath!, 'change.txt'), 'review this');
    if (status === 'cancelled') manager.cancel(run.id);
    else if (status === 'failed') expect(manager.sendMessage(run.id, [{ type: 'text', text: 'mock:request-error' }])).toBe(true);
    else expect(manager.finish(run.id)).toBe(true);
    // bound: status and registry release follow the owned runner's exit.
    await vi.waitFor(() => {
      expect(store.getRun(run.id)?.status).toBe(status);
      expect(manager.isActive(run.id)).toBe(false);
      expect(existsSync(scratch)).toBe(false);
    }, { timeout: HANG_GUARD_MS });
  });

  it.each([RUN_STATUS.queued, RUN_STATUS.running, RUN_STATUS.waiting])('preserves %s scratch before reading liveness or worker evidence', status => {
    const run = newRun();
    setRunStatus(store, run.id, status);
    const unexpected = vi.fn((): never => { throw new Error('nonterminal scratch must not read reap dependencies'); });
    expect(terminalScratchDisposition(run.id, store.getRun(run.id), {
      active: unexpected, starting: unexpected, queued: unexpected, claimed: unexpected,
      autosaveBlocker: unexpected, privateWorkers: unexpected,
    })).toBe('keep');
    expect(unexpected).not.toHaveBeenCalled();
  });

  it('preserves waiting scratch through a fresh store and manager recovery', async () => {
    const run = newRun();
    setRunStatus(store, run.id, RUN_STATUS.waiting);
    const { env } = await resolveStepEnv(run.id, 'claude');
    const dirs = new Set([env.TMPDIR!, agentTmpDir(dataDir, run.id)]);
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'scratch'), 'survive restart');
    }
    manager.dispose();
    store.flush();
    store = RunStore.open(dataDir, { keepLive: true });
    manager = createFixtureManager(store, repoRoot);
    await manager.recover();
    expect(store.getRun(run.id)?.status).toBe('waiting');
    for (const dir of dirs) expect(readFileSync(join(dir, 'scratch'), 'utf8')).toBe('survive restart');
  });

  it('reaps scratch immediately when an inactive task history is deleted', async () => {
    const run = newRun();
    const { env } = await resolveStepEnv(run.id, 'claude');
    setRunStatus(store, run.id, RUN_STATUS.waiting);
    const local = agentTmpDir(dataDir, run.id);
    mkdirSync(local, { recursive: true });
    expect(store.deleteRun(run.id)).toBe(true);
    expect(existsSync(env.TMPDIR!)).toBe(false);
    expect(existsSync(local)).toBe(false);
  });

  it('reaps scratch when an idle-closed task is finished without another session', async () => {
    const run = newRun();
    const { env } = await resolveStepEnv(run.id, 'claude');
    store.updateStep(run.id, 's', { status: STEP_STATUS.waiting });
    setRunStatus(store, run.id, RUN_STATUS.waiting, { currentStepId: 's' });
    expect(manager.finish(run.id)).toBe(true);
    await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe('done'), { timeout: HANG_GUARD_MS });
    expect(existsSync(env.TMPDIR!)).toBe(false);
  });

  // The whole point of the preflight: refuse to start rather than spawn an agent
  // whose every shell command will come back empty. The sabotage lands on the
  // RESOLVED directory — wherever the length cap (#387) puts it — so the case
  // stays deterministic at any checkout depth.
  it('fails before spawning when the temp directory cannot be had', async () => {
    const run = newRun();
    const resolved = resolveAgentTmpDir(dataDir, run.id);
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, 'not a directory', 'utf8');
    await expect(resolveStepEnv(run.id, 'claude')).rejects.toBeInstanceOf(AgentTempDirError);
  });

  // A crash never reaches the terminal-transition reap, so without the startup
  // sweep the directories would accumulate exactly the way `/tmp` did.
  it('sweeps orphaned directories at startup', async () => {
    const dead = newRun();
    const { env } = await resolveStepEnv(dead.id, 'claude');
    setRunStatus(store, dead.id, RUN_STATUS.done, { finishedAt: new Date().toISOString() });
    // Seed leftovers from a crash that missed terminal cleanup.
    mkdirSync(env.TMPDIR!, { recursive: true });
    // The resolved fallback needs its owner marker for the sweep to claim it.
    await resolveStepEnv(dead.id, 'claude');
    expect(existsSync(env.TMPDIR as string)).toBe(true);

    await manager.recover();
    expect(existsSync(env.TMPDIR as string)).toBe(false);
  });

  it('the error names the path and the way out, so the thread footer is actionable', async () => {
    const run = newRun();
    const resolved = resolveAgentTmpDir(dataDir, run.id);
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, 'not a directory', 'utf8');
    let err: Error | undefined;
    try {
      await resolveStepEnv(run.id, 'claude');
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(AgentTempDirError);
    // The path, so the thread footer can show it...
    expect(err!.message).toContain(`agent temp directory is not writable: ${resolved} `);
    // ...and the remedy, so the message alone is enough to act on.
    expect(err!.message).toContain('— free disk space, or set CEZ_AGENT_TMPDIR=0');
  });

  describe('CEZ_AGENT_TMPDIR=0', () => {
    const saved = process.env.CEZ_AGENT_TMPDIR;
    beforeEach(() => {
      process.env.CEZ_AGENT_TMPDIR = '0';
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.CEZ_AGENT_TMPDIR;
      else process.env.CEZ_AGENT_TMPDIR = saved;
    });

    it('restores the pre-#785 environment: no override, no directory', async () => {
      const run = newRun();
      const { env } = await resolveStepEnv(run.id, 'claude');
      expect(env.TMPDIR).toBeUndefined();
      // Nothing minted at either location the resolver may choose.
      expect(existsSync(resolveAgentTmpDir(dataDir, run.id))).toBe(false);
      // The handoff contract is untouched by the opt-out.
      expect(env.CEZ_TASK_ID).toBe(run.id);
    });

    // A run that started before #785 must still start with the hatch set — the
    // preflight is part of what the hatch turns off, or it is not an escape.
    it('still spawns when the temp directory could not have been created', async () => {
      const run = newRun();
      const resolved = resolveAgentTmpDir(dataDir, run.id);
      mkdirSync(dirname(resolved), { recursive: true });
      writeFileSync(resolved, 'not a directory', 'utf8');
      await expect(resolveStepEnv(run.id, 'claude')).resolves.toMatchObject({
        env: { CEZ_TASK_ID: run.id },
      });
    });
  });
});

/**
 * An agent handed a TMPDIR its file tools may not write to would trade one silent
 * failure for another, so the grant travels with the variable.
 */
describe('agentDirectories (#785)', () => {
  it('grants the run’s temp directory alongside the run-state folder', () => {
    expect(agentDirectories('/data/runs', { TMPDIR: '/data/tmp/run-1' }))
      .toEqual(['/data/runs', '/data/tmp/run-1']);
  });

  it('is exactly the pre-#785 list when the run has no temp directory', () => {
    expect(agentDirectories('/data/runs', {})).toEqual(['/data/runs']);
  });
});

/**
 * #387: a repo checked out deep enough that `<dataDir>/tmp/<runId>` crosses
 * the kernel's unix-socket path cap must still get a working per-run temp
 * directory at the spawn seam, and its fallback must reap like any other.
 */
describe('RunManager — deep checkout falls back to a socket-safe TMPDIR (#387)', () => {
  const savedHome = process.env.CEZ_HOME;
  let home: string;
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let manager: RunManager;

  const resolveStepEnv = (runId: string, backend: Parameters<typeof agentEnvForStep>[3], options?: Parameters<typeof agentEnvForStep>[4]) => {
    const context = { home: testHome(), store, repoRoot, dataDir };
    return agentEnvForStep(context, { agentEnv: id => agentEnv(context, undefined, id), workerStep: () => undefined }, runId, backend, options);
  };

  beforeEach(async () => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-deep-tmp-home-'));
    // Deep enough that the repo-local per-run path crosses the socket cap —
    // the shape Squawk's own nested task worktrees produce.
    repoRoot = join(realpathSync(tmpdir()), `cez-deep-tmp-${'r'.repeat(80)}`, 'repo');
    dataDir = join(repoRoot, '.ai/cezar');
    useTestHome(home ? Home.sandbox(home) : undefined);
    store = RunStore.open(dataDir);
    manager = createFixtureManager(store, repoRoot);
    await registerProject(repoRoot, undefined, testHome());
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    manager.dispose();
    vi.unstubAllEnvs();
    for (const run of store.listRuns()) removeAgentTmpDir(dataDir, run.id);
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) useTestHome(undefined);
    else useTestHome(savedHome ? Home.sandbox(savedHome) : undefined);
  });

  const newRun = () =>
    store.createRun({
      title: 't',
      workflow: 'w',
      task: 't',
      steps: [{ id: 's', name: 's', kind: STEP_KIND.agent }],
    });

  it('hands the spawn a short TMPDIR outside the checkout and reaps the fallback', async () => {
    const run = newRun();
    const { env } = await resolveStepEnv(run.id, 'claude');
    expect(env.TMPDIR).toBeTruthy();
    expect(env.TMPDIR!.length).toBeLessThanOrEqual(MAX_SOCKET_SAFE_DIR_LENGTH);
    expect(env.TMPDIR).not.toBe(agentTmpDir(dataDir, run.id));
    expect(existsSync(env.TMPDIR as string)).toBe(true);
    expect(env.TEMP).toBe(env.TMPDIR);
    expect(env.TMP).toBe(env.TMPDIR);
    writeFileSync(join(env.TMPDIR as string, 'scratch'), 'x', 'utf8');
    store.updateStep(run.id, 's', { status: STEP_STATUS.waiting });
    setRunStatus(store, run.id, RUN_STATUS.waiting, { currentStepId: 's' });
    expect(manager.finish(run.id)).toBe(true);
    // bound: public Finish owns terminal cleanup, including the socket-safe fallback.
    await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe('done'), { timeout: HANG_GUARD_MS });
    expect(existsSync(env.TMPDIR as string)).toBe(false);
  });
});
