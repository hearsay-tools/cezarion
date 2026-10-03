import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import * as git from '../git-worktree.ts';
import * as workflows from './load.ts';
import { createFixtureManager, removeFixtureRepo } from './fixture-cleanup.testkit.ts';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeFixtureRepo(root);
  vi.unstubAllEnvs();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cez-cleanup-regression-')); roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'gc.auto', '0'], { cwd: root });
  execFileSync('git', ['config', 'maintenance.auto', 'false'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: root });
  vi.stubEnv('CEZ_DRY_RUN', '1'); vi.stubEnv('CEZ_AUTONAME', '0');
  const store = RunStore.open(join(root, '.ai/cezar'));
  return { root, store, manager: createFixtureManager(store, root) };
}

function barrier() {
  let release!: () => void;
  let enter!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  return { held, entered, enter, release };
}

it.each(['ordinary', 'delegated root'] as const)('drains detached Finish settlement for an inactive %s run', async mode => {
  const { root, store, manager } = fixture();
  const run = store.createRun({ title: 'idle closed', task: 'hello', workflow: 'cleanup', steps: [{ id: 'work', name: 'Work', kind: 'agent' }] });
  store.updateRun(run.id, { status: 'waiting', currentStepId: 'work', worktreePath: root, baseBranch: 'main' });
  store.updateStep(run.id, 'work', { status: 'waiting' });
  if (mode === 'delegated root') store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: [], receipts: [] } }]);
  const boundary = barrier();
  const diff = git.worktreeDiff;
  const diffSpy = vi.spyOn(git, 'worktreeDiff').mockImplementation(async (...args) => {
    const result = await diff(...args);
    boundary.enter(); await boundary.held;
    return result;
  });
  const engine = manager as unknown as { settleSuccess(id: string): Promise<void>; settleRequestedRootFinish(id: string): Promise<void> };
  const settlement = vi.spyOn(engine, mode === 'ordinary' ? 'settleSuccess' : 'settleRequestedRootFinish');
  expect(manager.isActive(run.id)).toBe(false);
  expect(manager.finish(run.id)).toBe(true);
  // Observe the real detached operation, including rejection on the broken helper.
  const finished = Promise.allSettled([settlement.mock.results[0]!.value]);
  await boundary.entered;
  const removing = removeFixtureRepo(root);
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(existsSync(root)).toBe(true);
    boundary.release();
    expect(await finished).toEqual([{ status: 'fulfilled', value: undefined }]);
    await removing;
    expect(store.getRun(run.id)?.status).toBe('done');
    expect(existsSync(root)).toBe(false);
  } finally {
    boundary.release(); await finished; await removing;
    settlement.mockRestore(); diffSpy.mockRestore();
  }
});

it('drains queue rescue held while loading a lost queued run workflow', async () => {
  const { root, store, manager } = fixture();
  const run = store.createRun({ title: 'lost queued run', task: 'hello', workflow: 'quick-task', steps: [] });
  const boundary = barrier();
  const load = workflows.loadWorkflows;
  const loadSpy = vi.spyOn(workflows, 'loadWorkflows').mockImplementation(async (...args) => {
    const result = await load(...args);
    boundary.enter(); await boundary.held;
    return result;
  });
  expect(store.getRun(run.id)?.status).toBe('queued');
  const rescued = Promise.allSettled([manager.rescueStalledQueue()]);
  await boundary.entered;
  const removing = removeFixtureRepo(root);
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(existsSync(root)).toBe(true);
    boundary.release();
    expect(await rescued).toEqual([{ status: 'fulfilled', value: undefined }]);
    await removing;
    expect(manager.isActive(run.id)).toBe(false);
    expect(existsSync(root)).toBe(false);
  } finally {
    boundary.release(); await rescued; await removing; loadSpy.mockRestore();
  }
});

it.each(['root', 'continuation'] as const)('keeps the repo until a real %s session and its final write finish', async mode => {
  const { root, store, manager } = fixture();
  const workflow = { name: 'cleanup', source: 'built-in' as const, steps: [{ id: 'work', prompt: '{{task}}' }] };
  let id: string;
  if (mode === 'root') id = manager.startRun(workflow, { task: 'hello', worktree: false }).id;
  else {
    const record = store.createRun({ title: 'resume', task: 'hello', workflow: 'cleanup', runner: 'claude', steps: [{ id: 'work', name: 'Work', kind: 'agent' }] });
    id = record.id; store.updateStep(id, 'work', { sessionId: 'prior-session', backend: 'claude' }); store.updateRun(id, { status: 'done', worktree: false });
    expect(manager.continueRun(id, { text: 'hello' })).toEqual({ ok: true });
  }
  await vi.waitFor(() => expect(store.getRun(id)?.status).toBe('waiting'), { timeout: 10_000 });
  // Delay the real final autosave at its filesystem boundary, after the real
  // session has been interrupted. Removal must not race this closing write.
  const engine = manager as unknown as { saveWorktree(...args: unknown[]): Promise<void> };
  const save = engine.saveWorktree.bind(manager);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const saving = new Promise<void>(resolve => { entered = resolve; });
  engine.saveWorktree = async (...args) => { entered(); await gate; writeFileSync(join(root, 'late'), 'final write'); await save(...args); };
  manager.cancel(id);
  await saving;
  const removing = removeFixtureRepo(root);
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(existsSync(root)).toBe(true);
    release();
    await removing;
    expect(manager.isActive(id)).toBe(false);
    expect(existsSync(root)).toBe(false);
  } finally { release(); await removing; }
}, 20_000);

it('retains the repository and reports an ownership timeout', async () => {
  const { root, manager } = fixture();
  const run = manager.startRun({ name: 'hold', source: 'built-in', steps: [{ id: 'work', prompt: '{{task}}' }] }, { task: 'hello', worktree: false });
  try {
    await expect(removeFixtureRepo(root, 0)).rejects.toThrow('Fixture still owns work');
    expect(existsSync(root)).toBe(true);
  } finally { await removeFixtureRepo(root); }
  expect(manager.isActive(run.id)).toBe(false);
});

it('propagates removal errors', async () => {
  const { root } = fixture();
  const file = join(root, 'loop'); symlinkSync('loop', file);
  await expect(removeFixtureRepo(join(file, 'child'))).rejects.toThrow();
});
