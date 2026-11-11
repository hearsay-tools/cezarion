import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { AgentSession } from '../core/agent-runner.ts';
import type { RunManager } from './run.ts';
import { createActiveRun } from './active-run.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { QUEUE_WATCHDOG_MS } from './run.ts';
import { RunLine } from './run/run-line.ts';
import { RunSettlement } from './run/run-settlement.ts';
import { RunFinish } from './run/run-finish.ts';
import { WorkerExecutions } from './run/worker-executions.ts';
import { TurnBookkeeper } from './run/turn-bookkeeping.ts';
import { WorktreeAutosave } from './run/worktree-autosave.ts';
import type { RunModuleContext } from './run/types.ts';
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
import * as fixtureCleanup from './fixture-claude.testkit.ts';
import { createFixtureManager, removeFixtureRepo, fixtureWorkSettled, unused, fixtureWork, managerDisposed } from './fixture-claude.testkit.ts';
import { noRunners } from '../core/runners-under-test.testkit.ts';

const roots: string[] = [];
async function cleanupFixtureRoots() {
  try {
    for (const root of roots.splice(0)) await removeFixtureRepo(root);
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
}
afterEach(cleanupFixtureRoots);

it('restores real timers when fixture removal rejects', async () => {
  const failure = new Error('fixture drain failed');
  const remove = vi.spyOn(fixtureCleanup, 'removeFixtureRepo').mockRejectedValueOnce(failure);
  roots.push('failed-fixture');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    await expect(cleanupFixtureRoots()).rejects.toBe(failure);
    expect(vi.isFakeTimers()).toBe(false);
  } finally {
    remove.mockRestore();
    vi.useRealTimers();
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cez-cleanup-regression-')); roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'gc.auto', '0'], { cwd: root });
  execFileSync('git', ['config', 'maintenance.auto', 'false'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: root });
  vi.stubEnv('CEZ_DRY_RUN', '1'); vi.stubEnv('CEZ_AUTONAME', '0');
  const store = RunStore.open(join(root, '.ai/cezar'));
  const manager = createFixtureManager(store, root);
  return { root, store, manager };
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
  const run = store.createRun({ title: 'idle closed', task: 'hello', workflow: 'cleanup', steps: [{ id: 'work', name: 'Work', kind: STEP_KIND.agent }] });
  setRunStatus(store, run.id, RUN_STATUS.waiting, { currentStepId: 'work', worktreePath: root, baseBranch: 'main' });
  store.updateStep(run.id, 'work', { status: STEP_STATUS.waiting });
  if (mode === 'delegated root') store.commitDelegation([{ id: run.id, delegation: { role: 'root', permissions: [], receipts: [] } }]);
  const boundary = barrier();
  const diff = git.worktreeDiff;
  const diffSpy = vi.spyOn(git, 'worktreeDiff').mockImplementation(async (...args) => {
    const result = await diff(...args);
    boundary.enter(); await boundary.held;
    return result;
  });
  expect(manager.isActive(run.id)).toBe(false);
  expect(manager.finish(run.id)).toBe(true);
  await boundary.entered;
  const removing = removeFixtureRepo(root);
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(existsSync(root)).toBe(true);
    boundary.release();
    await removing;
    expect(store.getRun(run.id)?.status).toBe('done');
    expect(existsSync(root)).toBe(false);
  } finally {
    boundary.release(); await removing;
    diffSpy.mockRestore();
  }
});

it('drains queue rescue held while loading a lost queued run workflow', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
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
  vi.advanceTimersByTime(QUEUE_WATCHDOG_MS);
  await boundary.entered;
  const removing = removeFixtureRepo(root);
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(existsSync(root)).toBe(true);
    boundary.release();
    await removing;
    expect(manager.isActive(run.id)).toBe(false);
    expect(existsSync(root)).toBe(false);
  } finally {
    boundary.release(); await removing; loadSpy.mockRestore();
  }
});

it.each(['root', 'continuation'] as const)('keeps the repo until a real %s session and its final write finish', async mode => {
  const { root, store, manager } = fixture();
  const track = vi.spyOn(fixtureWork(root), 'track');
  const workflow = { name: 'cleanup', source: 'built-in' as const, steps: [{ id: 'work', prompt: '{{task}}' }] };
  let id: string;
  if (mode === 'root') id = manager.startRun(workflow, { task: 'hello', worktree: false }).id;
  else {
    const record = store.createRun({ title: 'resume', task: 'hello', workflow: 'cleanup', runner: 'claude', steps: [{ id: 'work', name: 'Work', kind: STEP_KIND.agent }] });
    id = record.id; store.updateStep(id, 'work', { sessionId: 'prior-session', backend: 'claude' }); setRunStatus(store, id, RUN_STATUS.done, { worktree: false });
    expect(manager.continueRun(id, { text: 'hello' })).toEqual({ ok: true });
  }
  await vi.waitFor(() => expect(store.getRun(id)?.status).toBe('waiting'), { timeout: 10_000 });
  expect(track.mock.calls.some(([label]) => label === (mode === 'root' ? 'execute' : 'runContinuation'))).toBe(true);
  expect(track.mock.calls.some(([label]) => label === 'session')).toBe(true);
  // Root-directory runs have a no-op autosave. Extend its owned promise with the same
  // delayed filesystem write this fixture used to inject at the autosave method.
  // The real session must close before that tracked final write can settle.
  const work = fixtureWork(root);
  const realTrack = TrackedWork.prototype.track.bind(work);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const saving = new Promise<void>(resolve => { entered = resolve; });
  track.mockImplementation((label, promise) => {
    if (label !== 'saveWorktree') return realTrack(label, promise);
    return realTrack(label, promise.then(async value => {
      entered(); await gate; writeFileSync(join(root, 'late'), 'final write'); return value;
    }));
  });
  manager.cancel(id);
  await saving;
  expect(track.mock.calls.some(([label]) => label === 'saveWorktree')).toBe(true);
  const removing = removeFixtureRepo(root);
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(existsSync(root)).toBe(true);
    release();
    await removing;
    expect(manager.isActive(id)).toBe(false);
    expect(existsSync(root)).toBe(false);
  } finally { release(); await removing; track.mockRestore(); }
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
  const { root, store, manager } = fixture();
  // Three retention passes that each settle inside the bound but together outlast it: the
  // teardown of hearsay-tools/cezarion#1323, which still owned `enforceRetention` three times.
  const passes = [barrier(), barrier(), barrier()];
  let call = 0;
  const reclaim = vi.spyOn(retention, 'reclaimWorktrees').mockImplementation(async () => {
    const pass = passes[call++]!;
    pass.enter(); await pass.held;
    return [];
  });
  const engine = settlementModule(moduleContext(root, store, manager, fixtureWork(root)));
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

it('records disposal and shares owned work across restart', () => {
  const { root, store, manager } = fixture();
  const work = fixtureWork(root);
  expect(managerDisposed(manager)).toBe(false);
  manager.dispose();
  expect(managerDisposed(manager)).toBe(true);
  const recovered = createFixtureManager(store, root);
  expect(fixtureWork(recovered)).toBe(work);
  expect(managerDisposed(recovered)).toBe(false);
});

/** These are module contracts: no public manager call invokes just one owned wrapper. */
function moduleContext(root: string, store: RunStore, manager: RunManager, work: TrackedWork): RunModuleContext {
  return { createRunner: noRunners, home: testHome(), repoRoot: root, dataDir: join(root, '.ai/cezar'), store, semaphore: new WorkspaceSemaphore({ home: testHome() }), work, disposed: () => managerDisposed(manager) };
}

function settlementModule(context: RunModuleContext): RunSettlement {
  const host = unused<ConstructorParameters<typeof RunSettlement>[9]>('RunSettlement.host', {
    active: new Map(), generation: () => undefined, deferParentCompletion: () => true, claimWorktreeReclaim: () => null, preview: undefined,
  });
  return new RunSettlement(context, unused('HumanWaits'), unused('WorkerQuestions'), unused('WorktreeAutosave'),
    unused('TurnBookkeeper'), unused('RunLine'), unused('AutoResumeScheduler'), unused('WorkerExecutions'),
    unused('CompletionGateHost'), host, '', '');
}

const ownedOperations: Array<{ label: string; invoke(context: RunModuleContext, id: string): Promise<void> }> = [
  { label: 'pump', invoke: context => new RunLine({ ...context, disposed: () => true }).pump() },
  { label: 'rescueStalledQueue', invoke: context => new RunLine({ ...context, disposed: () => true }).rescueStalledQueue() },
  { label: 'finishWorkerExecution', invoke: (context, id) => new WorkerExecutions(context, unused('WorkerCleanup'), unused('WorkerExecutions.host')).finishWorkerExecution(id) },
  { label: 'recordTurnEnd', invoke: (context, id) => new TurnBookkeeper(context, unused('TurnBookkeeper.host', {
    isDisposedDelegatedRun: () => true, discoverSkills: async () => [], reviveWorkflow: async () => null, trackTurn() {},
  })).recordTurnEnd(id, 'hello') },
  { label: 'autoNameRun', invoke: (context, id) => new TurnBookkeeper(context, unused('TurnBookkeeper.host')).autoNameRun(id, undefined, 'hello') },
  { label: 'saveWorktree', invoke: (context, id) => new WorktreeAutosave(context, unused('WorktreeAutosave.host')).saveWorktree(id, createActiveRun({ cwd: context.repoRoot, pendingHumanAsk: false, autonomous: false }), 'turn end') },
  { label: 'settleSuccess', invoke: (context, id) => settlementModule(context).settleSuccess(id) },
  { label: 'enforceRetention', invoke: context => settlementModule(context).enforceRetention() },
  { label: 'settleRequestedRootFinish', invoke: (context, id) => new RunFinish(context, unused('RunLine'),
    unused<RunSettlement>('RunSettlement', { settleSuccess: async () => {} }), unused('HumanWaits'), unused('WorkerQuestions'), unused('AutoResumeScheduler'),
    unused<ConstructorParameters<typeof RunFinish>[6]>('RunFinish.host', { reconcileWorkerWaits() {} })).settleRequestedRootFinish(id) },
];

it.each(ownedOperations)('records module-owned $label before returning', async ({ label, invoke }) => {
  const { root, store, manager } = fixture();
  const run = store.createRun({ title: 'ownership', task: 'hello', workflow: 'cleanup', steps: [] });
  setRunStatus(store, run.id, RUN_STATUS.waiting);
  const work = fixtureWork(root);
  const promise = invoke(moduleContext(root, store, manager, work), run.id);
  try { expect([...work.pending.values()]).toContain(label); }
  finally { await promise; await fixtureWorkSettled(root); }
});

it('records a queued continuation at launch', async () => {
  const { root, store, manager: old } = fixture();
  old.dispose();
  const semaphore = new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 0 }, load: async () => ({ maxParallel: 1, memoryLimitMb: 0 }) });
  const manager = createFixtureManager(store, root, { home: testHome(), semaphore });
  const work = fixtureWork(root);
  const track = vi.spyOn(work, 'track');
  const run = store.createRun({ title: 'resume', task: 'hello', workflow: 'cleanup', runner: 'claude', steps: [{ id: 'work', name: 'Work', kind: STEP_KIND.agent }] });
  store.updateStep(run.id, 'work', { sessionId: 'prior-session', backend: 'claude' });
  setRunStatus(store, run.id, RUN_STATUS.done, { worktree: false });
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
  const work = fixtureWork(root);
  const closed = barrier();
  const session: AgentSession = {
    result: closed.held.then(() => ({ text: '', toolCalls: [], tokensUsed: 0 })),
    interrupt: vi.fn(closed.release), end: closed.release, open: true,
    sendMessage: () => false, sendAgentMessage: () => false, discardQueuedMessages() {}, holdsHumanInput: () => false,
  };
  const promise = new WorkerExecutions(moduleContext(root, store, manager, work), unused('WorkerCleanup'), unused('WorkerExecutions.host')).trackWorkerSessionResult('sessionless', session);
  expect(work.pending.get(promise)).toBe('session');
  expect(work.liveSessions.has(session)).toBe(true);
  manager.dispose();
  expect(work.pending.get(promise)).toBe('session');
  expect(work.liveSessions.has(session)).toBe(true);
  const recovered = createFixtureManager(store, root);
  expect(fixtureWork(recovered)).toBe(work);
  await removeFixtureRepo(root);
  expect(session.interrupt).toHaveBeenCalledTimes(1);
  expect(work.liveSessions.size).toBe(0);
  expect(work.pending.size).toBe(0);
});

it('waits for detached work and new work it creates across managers', async () => {
  const { root, store } = fixture();
  const work = fixtureWork(root);
  const first = barrier(), second = barrier();
  const recovered = createFixtureManager(store, root);
  const same = fixtureWork(recovered);
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
  const { root } = fixture();
  const held = barrier();
  fixtureWork(root).track('held-namer', held.held);
  try {
    await expect(removeFixtureRepo(root, 0)).rejects.toThrow('held-namer');
    expect(existsSync(root)).toBe(true);
  } finally { held.release(); await fixtureWorkSettled(root); }
});
