import { testHome } from '../home/test-home.testkit.ts';
import { clearAutosaveTimer } from './run/input-timers.ts';
import { createActiveRun } from './active-run.ts';
import { WorktreeAutosave } from './run/worktree-autosave.ts';
import { unused } from './fixture-no-runner.testkit.ts';
import { TrackedWork } from './run/tracked-work.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { autosaveCommit, createWorktree } from '../git-worktree.ts';
import { RunStore } from '../runs/store.ts';
import { AUTOSAVE_INTERVAL_MS, periodicAutosaveEnabled } from './run.ts';
import { noRunners } from '../core/runners-under-test.testkit.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * The periodic autosave timer is opt-in via CEZ_AUTOSAVE=1 (#471). armAutosave is
 * driven on its owner module with interval time controlled by the test. The turn-end/pre-PR flushes are a separate, ungated
 * call to autosaveCommit — proven env-independent below.
 */
describe('periodic autosave gate (#471)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: WorktreeAutosave;
  let worktreePath: string;
  const work = new TrackedWork();
  const saves: Promise<void>[] = [];
  let runId: string;
  const savedEnv = process.env.CEZ_AUTOSAVE;

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-autosave-gate-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'base\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new WorktreeAutosave({ createRunner: noRunners, home: testHome(), store, repoRoot, dataDir: join(repoRoot, '.ai/cezar'),
      work, semaphore: new WorkspaceSemaphore({ home: testHome() }), disposed: () => false,
    }, unused<ConstructorParameters<typeof WorktreeAutosave>[1]>('WorktreeAutosave.host', {
      saveWorktree: (id, state, reason) => manager.saveWorktree(id, state, reason),
      trackTurn: (_id, task) => { saves.push(task); },
    }));
    const record = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    runId = record.id;
    worktreePath = (await createWorktree(repoRoot, record.id, 'main')).path;
  });

  afterAll(async () => {
    await Promise.all(saves);
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedEnv === undefined) delete process.env.CEZ_AUTOSAVE;
    else process.env.CEZ_AUTOSAVE = savedEnv;
  });

  it('is off by default, on only for the exact value "1"', () => {
    expect(periodicAutosaveEnabled({})).toBe(false);
    expect(periodicAutosaveEnabled({ CEZ_AUTOSAVE: '0' })).toBe(false);
    expect(periodicAutosaveEnabled({ CEZ_AUTOSAVE: 'true' })).toBe(false);
    expect(periodicAutosaveEnabled({ CEZ_AUTOSAVE: '1' })).toBe(true);
    delete process.env.CEZ_AUTOSAVE;
    expect(periodicAutosaveEnabled()).toBe(false); // defaults to process.env
  });

  async function head(): Promise<string> {
    return (await run('git', ['rev-parse', 'HEAD'], { cwd: worktreePath })).stdout.trim();
  }

  it('does not save periodically when the env is off (default)', async () => {
    delete process.env.CEZ_AUTOSAVE;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const before = await head();
    writeFileSync(join(worktreePath, 'gate.txt'), 'off');
    const state = createActiveRun({ cwd: worktreePath, pendingHumanAsk: false, autonomous: false });
    manager.armAutosave(runId, state);
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS);
    await Promise.all(saves);
    expect(await head()).toBe(before);
  });

  it('saves once per interval with CEZ_AUTOSAVE=1, stops after clear, and never saves a repo-root run', async () => {
    process.env.CEZ_AUTOSAVE = '1';
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const state = createActiveRun({ cwd: worktreePath, pendingHumanAsk: false, autonomous: false });
    writeFileSync(join(worktreePath, 'gate.txt'), 'on');
    const before = await head();
    manager.armAutosave(runId, state);
    manager.armAutosave(runId, state);
    const savesBefore = saves.length;
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS);
    await Promise.all(saves);
    expect(saves).toHaveLength(savesBefore + 1);
    expect([...work.pending.values()]).not.toContain('saveWorktree');
    const saved = await head();
    expect(saved).not.toBe(before);
    expect((await run('git', ['log', '-1', '--format=%s'], { cwd: worktreePath })).stdout.trim()).toBe('cezar autosave (periodic)');
    clearAutosaveTimer(state);
    writeFileSync(join(worktreePath, 'gate.txt'), 'after clear');
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS);
    await Promise.all(saves);
    expect(await head()).toBe(saved);
    expect(saves).toHaveLength(savesBefore + 1);

    const rootBefore = (await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
    writeFileSync(join(repoRoot, 'root.txt'), 'root edit');
    const rootState = createActiveRun({ cwd: repoRoot, pendingHumanAsk: false, autonomous: false });
    manager.armAutosave(runId, rootState);
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS);
    await Promise.all(saves);
    expect(saves).toHaveLength(savesBefore + 1);
    expect((await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim()).toBe(rootBefore);
  });

  it('AUTOSAVE_INTERVAL_MS stays the spec-006 90 s contract', () => {
    expect(AUTOSAVE_INTERVAL_MS).toBe(90_000);
  });

  it('the flush path (autosaveCommit) still commits with the env off', async () => {
    delete process.env.CEZ_AUTOSAVE;
    writeFileSync(join(worktreePath, 'work.txt'), 'progress\n');
    expect(await autosaveCommit(worktreePath, 'turn end')).toBe('committed');
    const { stdout } = await run('git', ['log', '-1', '--format=%s'], { cwd: worktreePath });
    // Keeps the `Squawk autosave` prefix so existing log greps still match, and
    // names the reason so an opted-out user can tell this flush apart from the
    // periodic timer they disabled (#471 follow-up).
    expect(stdout.trim()).toBe('cezar autosave (turn end)');
  });

  it('records the reason, so the gated timer is distinguishable in the log', async () => {
    delete process.env.CEZ_AUTOSAVE;
    for (const reason of ['periodic', 'turn end', 'run finalize', 'pre-PR'] as const) {
      writeFileSync(join(worktreePath, 'work.txt'), `progress ${reason}\n`);
      expect(await autosaveCommit(worktreePath, reason)).toBe('committed');
      const { stdout } = await run('git', ['log', '-1', '--format=%s'], { cwd: worktreePath });
      expect(stdout.trim()).toBe(`cezar autosave (${reason})`);
    }
  });
});
