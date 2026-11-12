import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS, WAIT_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { AgentRunner, AgentSession, AgentRunResult } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { fireCapturedTimer, observeWaitTimers } from './waits.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { executionAccount } from './execution-account.ts';
import { createFixtureManager, drainFixtureManagers, fixtureWork } from './fixture-cleanup.testkit.ts';
import type { RunManager } from './run.ts';

const runnerHook = vi.hoisted(() => ({ runner: undefined as AgentRunner | undefined }));
vi.mock('../core/runner-factory.ts', async original => ({
  ...await original<typeof import('../core/runner-factory.ts')>(),
  createRunner: () => runnerHook.runner!,
}));

function initRepo(root: string) {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: root });
}

function controlledSessions() {
  const launched: Array<{ id: string; endTurn(): void; session: AgentSession }> = [];
  runnerHook.runner = {
    backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => {},
    startSession(spec, event, options) {
      let resolve!: (result: AgentRunResult) => void;
      let open = true;
      const result = new Promise<AgentRunResult>(done => { resolve = done; });
      const close = () => { open = false; resolve({ text: '', toolCalls: [], tokensUsed: 0 }); };
      const session: AgentSession = { result, get open() { return open; },
        sendMessage: () => true, sendAgentMessage: () => Promise.resolve(),
        discardQueuedMessages() {}, holdsHumanInput: () => false, end: close, interrupt: close };
      launched.push({ id: spec.env!.CEZ_TASK_ID!, endTurn: () => event?.({ type: 'turn-end' }), session });
      queueMicrotask(() => options?.onUiEvent?.({ type: 'session.started', backend: 'claude', sessionId: spec.sessionId! }));
      return session;
    },
  };
  return launched;
}

async function pumps(manager: RunManager) {
  await Promise.all([...fixtureWork(manager).pending].filter(([, label]) => label === 'pump').map(([promise]) => promise));
}

/** A usage limit closes the account a step RAN on, which a mixed-runner workflow can set apart from
 *  the task-level `runner` (hearsay-tools/cezarion#1236). */
describe('executionAccount', () => {
  const step = (backend: 'claude' | 'codex', profileId?: string) =>
    ({ id: `s-${backend}`, name: 's', kind: STEP_KIND.agent, status: STEP_STATUS.failed, iterations: 1, tokensUsed: 0, sessionId: `sess-${backend}`, backend, profileId });

  it('reads the latest session step, not the task-level runner', () => {
    expect(executionAccount({ runner: 'codex', agentProfile: undefined, steps: [step('codex'), step('claude', 'second')] }))
      .toEqual({ runner: 'claude', agentProfile: 'second' });
  });

  it('falls back to the record before any session exists', () => {
    expect(executionAccount({ runner: 'codex', agentProfile: 'work', steps: [] })).toEqual({ runner: 'codex', agentProfile: 'work' });
  });

  it('takes a continuation that switches backend at its word, on the run account', () => {
    expect(executionAccount({ runner: 'codex', agentProfile: undefined, steps: [step('codex', 'other')] }, { backend: 'claude' }))
      .toEqual({ runner: 'claude', agentProfile: undefined });
  });

  it('takes the account a Continue selected on the same backend, which starts a new session', () => {
    expect(executionAccount({ runner: 'codex', agentProfile: 'new', steps: [step('codex', 'old')] }, { backend: 'codex' }))
      .toEqual({ runner: 'codex', agentProfile: 'new' });
  });

  it('takes the account of the session a continuation resumes', () => {
    expect(executionAccount({ runner: 'codex', agentProfile: 'new', steps: [step('codex', 'old')] }, { backend: 'codex', sessionId: 'sess-codex' }))
      .toEqual({ runner: 'codex', agentProfile: 'old' });
  });

  it('prefers a live session\'s own settings', () => {
    expect(executionAccount({ runner: 'codex', agentProfile: undefined, steps: [step('codex')] }, undefined, { runner: 'claude', agentProfile: 'default' }))
      .toEqual({ runner: 'claude', agentProfile: 'default' });
  });
});

describe('account holds read the execution account', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let semaphore: WorkspaceSemaphore;
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-exec-account-'));
    initRepo(repoRoot);
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    semaphore = new WorkspaceSemaphore({ home: testHome() });
    manager = createFixtureManager(store, repoRoot, { home: testHome(), semaphore });
    vi.stubEnv('CEZ_AUTONAME', '0');
  });
  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    runnerHook.runner = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs();
  });

  function heldRun(): string {
    const run = store.createRun({ title: 'held', workflow: 'w', task: 't', runner: 'codex', steps: [{ id: 'claude-step', name: 'c', kind: STEP_KIND.agent }] });
    store.updateStep(run.id, 'claude-step', { status: STEP_STATUS.failed, sessionId: 'sess-1', backend: 'claude' });
    setRunStatus(store, run.id, RUN_STATUS.waiting, { autoResumeAt: new Date(Date.now() + 600_000).toISOString() });
    return run.id;
  }

  it('holds the account the limited step ran on', () => {
    heldRun();
    const holds = manager.accountHolds();
    expect([...holds.deadline]).toEqual(['claude:default']);
  });

  it('holds a live session\'s wake by the step it runs, not the task-level runner', async () => {
    const launched = controlledSessions();
    const generations = new Map<string, string>();
    const handlers = manager.squawkToolHandlers.bind(manager);
    vi.spyOn(manager, 'squawkToolHandlers').mockImplementation((id, generation) => {
      generations.set(id, generation); return handlers(id, generation);
    });
    observeWaitTimers(manager, store);
    const live = manager.startRun({ name: 'mixed', source: 'built-in', steps: [{ id: 'x', runner: 'claude', prompt: '{{task}}' }] },
      { task: 'live mixed account', runner: 'codex', worktree: false });
    // bound: runner launch is asynchronous; the owned session is the signal.
    await vi.waitFor(() => expect(launched.some(session => session.id === live.id)).toBe(true), { timeout: 15_000 });
    const hold = heldRun();
    const wait = await manager.registerWait(live.id, { kind: WAIT_KIND.timer, seconds: 60 }, 'cezar_wait', generations.get(live.id)!);
    launched.find(session => session.id === live.id)!.endTurn();
    await pumps(manager);
    fireCapturedTimer(wait.id);
    await pumps(manager);
    expect(store.getRun(live.id)?.agentInputs?.find(input => input.id === wait.id)?.deliveredAt).toBeUndefined();
    expect(store.getRun(live.id)?.waits?.find(entry => entry.id === wait.id)?.phase).toBe('resolved');
    const other = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'unheld Codex account', runner: 'codex', worktree: true });
    // bound: the second owned session proves the unheld account can launch.
    await vi.waitFor(() => expect(launched.some(session => session.id === other.id)).toBe(true), { timeout: 15_000 });
    const otherWait = await manager.registerWait(other.id, { kind: WAIT_KIND.timer, seconds: 60 }, 'cezar_wait', generations.get(other.id)!);
    launched.find(session => session.id === other.id)!.endTurn();
    await pumps(manager);
    fireCapturedTimer(otherWait.id);
    // bound: only the unheld account's immediate ACK must commit here.
    await vi.waitFor(() => expect(store.getRun(other.id)?.agentInputs?.find(input => input.id === otherWait.id)?.deliveredAt).toBeDefined(), { timeout: 15_000 });
    expect(store.getRun(live.id)?.agentInputs?.find(input => input.id === wait.id)?.deliveredAt).toBeUndefined();
    setRunStatus(store, hold, RUN_STATUS.failed, { autoResumeAt: undefined });
    // Clearing the hold lets the same live Claude session take its result.
    await semaphore.release();
    // bound: the owned ACK promise resolves immediately; wait only for its durable commit.
    await vi.waitFor(() => expect(store.getRun(live.id)?.agentInputs?.find(input => input.id === wait.id)?.deliveredAt).toBeDefined(), { timeout: 15_000 });
  });

});

describe('a held wake does not advertise itself to the workspace line', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-held-wake-'));
    initRepo(repoRoot);
    vi.stubEnv('CEZ_AUTONAME', '0');
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
  });
  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    runnerHook.runner = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs();
  });

  it('reports only wakes that could leave, so another project\'s eligible wake goes first', async () => {
    const launched = controlledSessions();
    let capacity = 0;
    const semaphore = new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 0 }, load: async () => ({ maxParallel: capacity, memoryLimitMb: null }) });
    manager.dispose();
    manager = createFixtureManager(store, repoRoot, { home: testHome(), semaphore });
    const otherRoot = mkdtempSync(join(tmpdir(), 'cez-eligible-wake-'));
    initRepo(otherRoot);
    const otherStore = RunStore.open(join(otherRoot, '.ai/cezar'));
    const other = createFixtureManager(otherStore, otherRoot, { home: testHome(), semaphore });
    const queuedWake = (target: RunStore, manager: RunManager, runner: 'claude' | 'codex') => {
      const run = target.createRun({ title: 'parked', task: 'parked', workflow: 'quick-task', runner,
        steps: [{ id: 'task', name: 'task', kind: STEP_KIND.agent }] });
      target.updateStep(run.id, 'task', { status: STEP_STATUS.waiting, sessionId: randomUUID(), backend: runner });
      setRunStatus(target, run.id, RUN_STATUS.waiting, { currentStepId: 'task' });
      const continued = manager.continueRun(run.id, { text: 'wake' }, true);
      expect(continued).toEqual({ ok: true });
      return run.id;
    };
    try {
      const holder = store.createRun({ title: 'holder', workflow: 'quick-task', task: 'hold', runner: 'claude', steps: [] });
      setRunStatus(store, holder.id, RUN_STATUS.waiting, { autoResumeAt: new Date(Date.now() + 600_000).toISOString() });
      const parked = queuedWake(store, manager, 'claude');
      const fresh = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'fresh', runner: 'codex', worktree: false });
      const eligible = queuedWake(otherStore, other, 'codex');
      await pumps(manager); await pumps(other);
      expect(launched).toEqual([]);
      capacity = 1;
      await semaphore.refresh();
      // bound: the owned runner's first launch is the fairness result.
      await vi.waitFor(() => expect(launched.map(session => session.id)).toEqual([eligible]), { timeout: 15_000 });
      expect(store.getRun(fresh.id)?.status).toBe('queued');
      expect(store.getRun(parked)?.status).toBe('queued');
      setRunStatus(store, holder.id, RUN_STATUS.failed, { autoResumeAt: undefined });
      expect(other.cancel(eligible)).toBe(true);
      // bound: wait for the owned fake session's result and cleanup, before releasing capacity.
      await launched.find(session => session.id === eligible)!.session.result;
      await Promise.all([...fixtureWork(other).pending].filter(([, label]) => label === 'runContinuation').map(([work]) => work));
      await semaphore.release();
      // bound: the previously held wake becomes eligible and launches exactly once.
      await vi.waitFor(() => expect(launched.map(session => session.id)).toEqual([eligible, parked]), { timeout: 15_000 });
      expect(store.getRun(fresh.id)?.status).toBe('queued');
    } finally {
      for (const id of store.listRunIds()) manager.cancel(id);
      for (const id of otherStore.listRunIds()) other.cancel(id);
      await drainFixtureManagers(otherRoot);
      otherStore.close(); rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('keeps a recovered runnerless task queued while the configured default account is held', async () => {
    const launched = controlledSessions();
    const semaphore = new WorkspaceSemaphore({ home: testHome() });
    manager.dispose();
    manager = createFixtureManager(store, repoRoot, { home: testHome(), semaphore });
    writeFileSync(join(repoRoot, '.ai/cezar/config.json'), JSON.stringify({ defaultRunner: 'codex' }));
    const holder = store.createRun({ title: 'holder', workflow: 'quick-task', task: 'hold', runner: 'codex', steps: [] });
    setRunStatus(store, holder.id, RUN_STATUS.waiting, { autoResumeAt: new Date(Date.now() + 600_000).toISOString() });
    const parked = store.createRun({ title: 'legacy', workflow: 'quick-task', task: 'runnerless',
      workflowDef: QUICK_TASK_WORKFLOW, steps: [{ id: 'task', name: 'task', kind: STEP_KIND.agent }] });
    await manager.recover();
    await pumps(manager);
    expect(store.getRun(parked.id)?.status).toBe('queued');
    expect(launched).toEqual([]);
    setRunStatus(store, holder.id, RUN_STATUS.failed, { autoResumeAt: undefined });
    await semaphore.release();
    // bound: the owned runner's launch proves the recovered task left the account hold.
    await vi.waitFor(() => expect(launched.map(session => session.id)).toEqual([parked.id]), { timeout: 15_000 });
    expect(store.getRun(parked.id)?.runner).toBe('codex');
  });
});
