import { RUN_STATUS, STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { AgentSession } from '../core/agent-runner.ts';
import type { RunManager } from './run.ts';
import { createActiveRun } from './active-run.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RUN_MODULE_CLASSES, runInternals } from './run-internals.testkit.ts';
import { TrackedWork } from './run/tracked-work.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import * as git from '../git-worktree.ts';
import * as retention from '../runs/retention.ts';
import * as workflows from './load.ts';
import { createFixtureManager, removeFixtureRepo, fixtureWorkSettled } from './fixture-cleanup.testkit.ts';

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
  const track = vi.spyOn(runInternals(manager).context.work, 'track');
  const workflow = { name: 'cleanup', source: 'built-in' as const, steps: [{ id: 'work', prompt: '{{task}}' }] };
  let id: string;
  if (mode === 'root') id = manager.startRun(workflow, { task: 'hello', worktree: false }).id;
  else {
    const record = store.createRun({ title: 'resume', task: 'hello', workflow: 'cleanup', runner: 'claude', steps: [{ id: 'work', name: 'Work', kind: 'agent' }] });
    id = record.id; store.updateStep(id, 'work', { sessionId: 'prior-session', backend: 'claude' }); store.updateRun(id, { status: 'done', worktree: false });
    expect(manager.continueRun(id, { text: 'hello' })).toEqual({ ok: true });
  }
  await vi.waitFor(() => expect(store.getRun(id)?.status).toBe('waiting'), { timeout: 10_000 });
  expect(track.mock.calls.some(([label]) => label === (mode === 'root' ? 'execute' : 'runContinuation'))).toBe(true);
  expect(track.mock.calls.some(([label]) => label === 'session')).toBe(true);
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

it('keeps draining while owned work settles one operation at a time past one bound', async () => {
  const { root, manager } = fixture();
  // Three retention passes that each settle inside the bound but together outlast it: the
  // teardown of hearsay-tools/cezarion#1323, which still owned `enforceRetention` three times.
  const passes = [barrier(), barrier(), barrier()];
  let call = 0;
  const reclaim = vi.spyOn(retention, 'reclaimWorktrees').mockImplementation(async () => {
    const pass = passes[call++]!;
    pass.enter(); await pass.held;
    return [];
  });
  const engine = manager as unknown as { enforceRetention(): Promise<void> };
  const retained = Promise.allSettled([engine.enforceRetention(), engine.enforceRetention(), engine.enforceRetention()]);
  await Promise.all(passes.map(pass => pass.entered));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    const removed = removeFixtureRepo(root, 1_000).then(() => undefined, (error: unknown) => error);
    for (const pass of passes) {
      await vi.advanceTimersByTimeAsync(600);
      expect(existsSync(root)).toBe(true);
      pass.release();
    }
    expect(await removed).toBeUndefined();
    expect(existsSync(root)).toBe(false);
  } finally {
    vi.useRealTimers();
    for (const pass of passes) pass.release();
    await retained; reclaim.mockRestore();
  }
});

it('propagates removal errors', async () => {
  const { root } = fixture();
  const file = join(root, 'loop'); symlinkSync('loop', file);
  await expect(removeFixtureRepo(join(file, 'child'))).rejects.toThrow();
});

it('reads every facade module through the typed internals seam', () => {
  const { manager } = fixture();
  const internals = runInternals(manager);
  for (const [name, Module] of Object.entries(RUN_MODULE_CLASSES)) {
    expect(internals[name as keyof typeof RUN_MODULE_CLASSES], name).toBeInstanceOf(Module);
  }
  expect(internals.context.work).toBeInstanceOf(TrackedWork);
  expect(internals.active).toBeInstanceOf(Map);
  expect(internals.disposed).toBe(false);
  manager.dispose();
  expect(internals.disposed).toBe(true);
});

const ownedOperations: Array<{ label: string; invoke(manager: RunManager, id: string): Promise<void> }> = [
  { label: 'pump', invoke: manager => runInternals(manager).line.pump() },
  { label: 'rescueStalledQueue', invoke: manager => runInternals(manager).line.rescueStalledQueue() },
  { label: 'finishWorkerExecution', invoke: (manager, id) => runInternals(manager).workerExecutions.finishWorkerExecution(id) },
  { label: 'recordTurnEnd', invoke: (manager, id) => runInternals(manager).turnBookkeeper.recordTurnEnd(id, 'hello') },
  { label: 'autoNameRun', invoke: (manager, id) => runInternals(manager).turnBookkeeper.autoNameRun(id, undefined, 'hello') },
  { label: 'saveWorktree', invoke: (manager, id) => {
    const { context, worktreeAutosave } = runInternals(manager);
    return worktreeAutosave.saveWorktree(id, createActiveRun({ cwd: context.repoRoot, pendingHumanAsk: false, autonomous: false }), 'turn end');
  } },
  { label: 'settleSuccess', invoke: (manager, id) => runInternals(manager).runSettlement.settleSuccess(id) },
  { label: 'enforceRetention', invoke: manager => manager['enforceRetention']() },
  { label: 'settleRequestedRootFinish', invoke: (manager, id) => manager['settleRequestedRootFinish'](id) },
];

it.each(ownedOperations)('records module-owned $label before returning', async ({ label, invoke }) => {
  const { root, store, manager } = fixture();
  const run = store.createRun({ title: 'ownership', task: 'hello', workflow: 'cleanup', steps: [] });
  store.updateRun(run.id, { status: RUN_STATUS.waiting });
  const work = runInternals(manager).context.work;
  const promise = invoke(manager, run.id);
  try { expect([...work.pending.values()]).toContain(label); }
  finally { await Promise.allSettled([promise]); await fixtureWorkSettled(root); }
});

it('records a queued continuation at launch', async () => {
  const { root, store, manager: old } = fixture();
  old.dispose();
  const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 0 }, load: async () => ({ maxParallel: 1, memoryLimitMb: 0 }) });
  const manager = createFixtureManager(store, root, { semaphore });
  const work = runInternals(manager).context.work;
  const track = vi.spyOn(work, 'track');
  const run = store.createRun({ title: 'resume', task: 'hello', workflow: 'cleanup', runner: 'claude', steps: [{ id: 'work', name: 'Work', kind: STEP_KIND.agent }] });
  store.updateStep(run.id, 'work', { sessionId: 'prior-session', backend: 'claude' });
  store.updateRun(run.id, { status: RUN_STATUS.done, worktree: false });
  expect(manager.continueRun(run.id, { text: 'hello' }, true)).toEqual({ ok: true });
  expect(store.getRun(run.id)?.status).toBe('queued');
  try {
    await semaphore.refresh();
    await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe('waiting'), { timeout: 10_000 });
    expect(track.mock.calls.some(([label]) => label === 'runContinuation')).toBe(true);
  } finally {
    manager.cancel(run.id);
    await vi.waitFor(() => expect(manager.isActive(run.id)).toBe(false), { timeout: 10_000 });
  }
}, 20_000);

it.each(['fulfilled', 'rejected'] as const)('returns the same %s promise and signals settlement once', async outcome => {
  const work = new TrackedWork();
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  const settled = vi.fn();
  const off = work.onSettle(settled);
  expect(work.track('operation', promise)).toBe(promise);
  expect(work.pending.get(promise)).toBe('operation');
  const failure = new Error('engine failure');
  if (outcome === 'fulfilled') resolve(); else reject(failure);
  if (outcome === 'fulfilled') await expect(promise).resolves.toBeUndefined();
  else await expect(promise).rejects.toBe(failure);
  expect(settled).toHaveBeenCalledTimes(1);
  expect(work.pending.size).toBe(0);
  off();
  await work.track('later', Promise.resolve());
  expect(settled).toHaveBeenCalledTimes(1);
});

it('keeps a session until close, interrupts it after dispose, and shares ownership across restart', async () => {
  const { root, store, manager } = fixture();
  const work = runInternals(manager).context.work;
  const closed = barrier();
  const session = { result: closed.held, interrupt: vi.fn(closed.release) } as unknown as AgentSession;
  const promise = runInternals(manager).workerExecutions.trackWorkerSessionResult('sessionless', session);
  expect(work.pending.get(promise)).toBe('session');
  expect(work.liveSessions.has(session)).toBe(true);
  manager.dispose();
  expect(work.pending.get(promise)).toBe('session');
  expect(work.liveSessions.has(session)).toBe(true);
  const recovered = createFixtureManager(store, root);
  expect(runInternals(recovered).context.work).toBe(work);
  await removeFixtureRepo(root);
  expect(session.interrupt).toHaveBeenCalledTimes(1);
  expect(work.liveSessions.size).toBe(0);
  expect(work.pending.size).toBe(0);
});

it('waits for detached work and new work it creates across managers', async () => {
  const { root, store, manager } = fixture();
  const work = runInternals(manager).context.work;
  const first = barrier(), second = barrier();
  const recovered = createFixtureManager(store, root);
  const same = runInternals(recovered).context.work;
  const child = first.held.then(() => same.track('namer', second.held));
  work.track('bookkeeping', child);
  let settled = false;
  const waiting = fixtureWorkSettled(root).then(() => { settled = true; });
  first.release();
  await new Promise(resolve => setImmediate(resolve));
  expect(settled).toBe(false);
  second.release(); await waiting;
  expect(work.pending.size).toBe(0);
});

it('reports the label of held work on a drain timeout', async () => {
  const { root, manager } = fixture();
  const held = barrier();
  runInternals(manager).context.work.track('held-namer', held.held);
  try {
    await expect(removeFixtureRepo(root, 0)).rejects.toThrow('held-namer');
    expect(existsSync(root)).toBe(true);
  } finally { held.release(); await fixtureWorkSettled(root); }
});
