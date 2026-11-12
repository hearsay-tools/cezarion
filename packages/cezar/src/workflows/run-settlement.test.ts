import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { runnerHook, setupMonitoringFixture, waitForProduct } from './run-fixture.testkit.ts';
import { RunSettlement } from './run/run-settlement.ts';
import { createActiveRun, type ActiveRun } from './active-run.ts';
import { TrackedWork } from './run/tracked-work.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { createFixtureManager, fixtureWorkSettled } from './fixture-cleanup.testkit.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import type { AgentSession, AgentRunResult } from '../core/agent-runner.ts';
import type { RunManager } from './run.ts';
import { RUN_STATUS, WAIT_KIND, STEP_STATUS, STEP_KIND, WAIT_PHASE, makeTimerWait } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore, type StepState } from '../runs/store.ts';
import { worktreeDiff } from '../git-worktree.ts';
import { noRunners } from '../core/runners-under-test.testkit.ts';

vi.mock('../git-worktree.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../git-worktree.ts')>(),
  worktreeDiff: vi.fn(async () => 'a changed file'),
}));

function unused<T extends object>(name: string, values: Partial<T> = {}): T {
  return new Proxy(values, { get(target, key) {
    if (key in target) return Reflect.get(target, key);
    throw new Error(`unused collaborator ${name}.${String(key)}`);
  } }) as T;
}

const oldFinish = '2026-07-01T12:00:00.000Z';
const liveStatuses = ['waiting', 'running'] as const;
const preservedStatuses = ['done', 'failed', 'cancelled', 'skipped', 'pending'] as const;

describe('successful run settlement (#473)', () => {
  let root: string;
  let store: RunStore;
  const f = setupMonitoringFixture();
  let manager: RunManager;
  let settle: (id: string, durable?: boolean) => Promise<void>;

  beforeEach(() => {
    root = f.repoRoot;
    store = f.store;
    manager = f.manager;
    runnerHook.runner = { backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => {},
      startSession: () => ({ open: false, result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
        sendMessage: () => false, sendAgentMessage: () => false, end: () => {}, interrupt: () => {},
        discardQueuedMessages: () => {}, holdsHumanInput: () => false }),
    };
    settle = async (id, durable) => {
      if (durable) expect(manager.finish(id)).toBe(true);
      else expect(manager.continueRun(id, { text: 'complete', runner: 'claude' })).toMatchObject({ ok: true });
      await fixtureWorkSettled(root);
    };
    vi.mocked(worktreeDiff).mockResolvedValue('a changed file');
    vi.stubEnv('CEZ_REVIEW_GATE', '0');
  });

  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  function seed(durable = false) {
    const record = store.createRun({ title: 'settlement', task: 'finish', workflow: 'quick-task', workflowDef: { name: 'quick-task', source: 'file', steps: [{ id: 'waiting-false', prompt: 'work' }] }, steps: [] });
    for (const status of [...liveStatuses, ...preservedStatuses]) {
      for (const stamped of [false, true]) {
        const id = `${status}-${stamped}`;
        store.addStep(record.id, { id, name: id, kind: STEP_KIND.agent, synthetic: 'continuation' });
        store.updateStep(record.id, id, { status, startedAt: oldFinish, ...(stamped ? { finishedAt: oldFinish } : {}) });
      }
    }
    {
      const { status: fixtureStatus, ...fixtureExtras }: NonNullable<Parameters<typeof setRunStatus>[3]> & { status: Parameters<typeof setRunStatus>[2] } = { status: RUN_STATUS.waiting, currentStepId: 'waiting-false', worktreePath: root,
      ...(durable ? { delegation: { role: 'root' as const, permissions: [], receipts: [] } } : {}),
    };
      setRunStatus(store, record.id, fixtureStatus, fixtureExtras);
    }
    store.updateStep(record.id, 'waiting-false', { sessionId: 'seed-session', backend: 'claude' });
    if (durable) store.commitRootFinishIntent(record.id);
    return record.id;
  }

  for (const durable of [false, true]) {
    for (const status of ['done', 'review'] as const) {
      it(`${durable ? 'durable root' : 'ordinary'} ${status} closes only live steps and preserves timestamps`, async () => {
        vi.stubEnv('CEZ_REVIEW_GATE', status === 'review' ? '1' : '0');
        vi.useFakeTimers({ toFake: ['Date'] });
        const id = seed(durable);
        const untouched = structuredClone(store.getRun(id)!.steps.filter(step => preservedStatuses.includes(step.status as typeof preservedStatuses[number])));
        const terminalSnapshots: StepState[][] = [];
        store.on('run', record => {
          if (record.id === id && record.status === status) terminalSnapshots.push(structuredClone(record.steps));
        });
        await settle(id, durable);
        store.flush();
        const completed = RunStore.open(join(root, '.ai/cezar'), { keepLive: true }).getRun(id)!;
        expect(completed.status).toBe(status);
        expect(completed.currentStepId).toBeUndefined();
        expect(completed.steps.filter(step => preservedStatuses.some(preserved => step.id.startsWith(preserved)))).toEqual(untouched);
        for (const live of liveStatuses) {
          expect(completed.steps.find(step => step.id === `${live}-false`)).toMatchObject({ status: STEP_STATUS.done, finishedAt: completed.finishedAt, startedAt: oldFinish });
          expect(completed.steps.find(step => step.id === `${live}-true`)).toMatchObject({ status: STEP_STATUS.done, finishedAt: oldFinish, startedAt: oldFinish });
        }
        expect(terminalSnapshots.length).toBeGreaterThan(0);
        expect(terminalSnapshots.flat().some(step => step.status === 'waiting' || step.status === 'running')).toBe(false);
      });
    }

    it.each(['cancelled', 'failed'] as const)(`${durable ? 'durable root' : 'ordinary'} settlement preserves %s during diff I/O`, async status => {
      const id = seed(durable);
      let release!: (diff: string) => void;
      let enter!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      vi.mocked(worktreeDiff).mockImplementationOnce(() => new Promise(resolve => { release = resolve; enter(); }));
      const pending = settle(id, durable);
      await entered;
      setRunStatus(store, id, status, { finishedAt: oldFinish });
      const snapshot = structuredClone(store.getRun(id));
      release('changed');
      await pending;
      expect(store.getRun(id)).toEqual(snapshot);
      expect(store.readEvents(id).some(event => event.type === 'lifecycle' && event.message === 'run finished')).toBe(false);
    });
  }

  it.each(['before diff', 'during diff'])('parent attention deferral %s leaves live steps untouched', async timing => {
    const id = seed(true);
    const steps = structuredClone(store.getRun(id)!.steps);
    const ask = () => store.appendEvent(id, { type: 'ask.requested', requestId: randomUUID(), questions: [{
      header: 'Choice', question: 'Which option?', options: [{ label: 'One' }, { label: 'Two' }],
    }] });
    const family = () => store.commitDelegation([{ id, delegation: { role: 'root', permissions: [], receipts: [{ requestId: randomUUID(), workerId: randomUUID(), requestHash: 'b'.repeat(64) }] } }]);
    if (timing === 'before diff') ask();
    // The question holds completion only for a root with workers (hearsay-tools/cezarion#2784).
    else vi.mocked(worktreeDiff).mockImplementationOnce(async () => { family(); ask(); return 'changed'; });
    if (timing === 'before diff') { family(); expect(manager.finish(id)).toBe(false); }
    else await settle(id, true);
    expect(store.getRun(id)?.status).toBe('waiting');
    expect(store.getRun(id)?.finishedAt).toBeUndefined();
    expect(store.getRun(id)?.steps).toEqual(steps);
  });

  async function usageLimitFailure(late: boolean) {
    manager.dispose();
    const semaphore = new WorkspaceSemaphore({ home: testHome() });
    manager = createFixtureManager(store, root, { home: testHome(), semaphore });
    f.manager = manager;
    let fail!: (error: Error) => void;
    let finish!: (result: AgentRunResult) => void;
    const tools = vi.spyOn(manager, 'cezarToolHandlers');
    let started = false;
    const startSession = vi.fn<NonNullable<typeof runnerHook.runner>['startSession']>((_spec, onEvent) => {
      const session: AgentSession = { open: true, result: new Promise((resolve, reject) => { finish = resolve; fail = reject; }),
        sendMessage: () => true, sendAgentMessage: () => false, discardQueuedMessages: () => {}, holdsHumanInput: () => false,
        end: () => finish({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: () => finish({ text: '', toolCalls: [], tokensUsed: 0 }) };
      started = true;
      queueMicrotask(() => onEvent?.({ type: 'session', sessionId: 'limited' }));
      return session;
    });
    runnerHook.runner = { backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => {}, startSession };
    const record = manager.startRun(f.SINGLE_STEP, { task: 'wait', runner: 'claude', worktree: false });
    f.currentId = record.id;
    await waitForProduct(manager, store, () => started);
    const handlers = tools.mock.results.find(result => result.type === 'return')!.value;
    expect((await handlers.registerWait({ kind: WAIT_KIND.timer, seconds: 3600 }, 'cezar_wait', new AbortController().signal)).answer.ok).toBe(true);
    const reset = Math.floor(Date.now() / 1000) + 3600;
    store.commitAgentInputs(record.id, [{ id: randomUUID(), parentRunId: record.id, source: 'lifecycle',
      text: 'pending', createdAt: new Date().toISOString() }]);
    let raced = false;
    let heldSnapshot: ReturnType<RunStore['getRun']>;
    const lateWait = makeTimerWait({ id: randomUUID(), registeredAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 3_600_000).toISOString() });
    const commitLateWait = ({ runId, event }: { runId: string; event: { type: string; message?: string } }) => {
      if (!late || runId !== record.id || event.type !== 'lifecycle' || !event.message?.startsWith('usage limit reached') || raced) return;
      raced = true;
      store.commitWait(record.id, lateWait);
      heldSnapshot = structuredClone(store.getRun(record.id));
    };
    store.on('event', commitLateWait);
    const releaseSlot = semaphore.release.bind(semaphore);
    const release = vi.spyOn(semaphore, 'release').mockImplementation(() => {
      expect(store.getRun(record.id)?.autoResumeAt).toEqual(expect.any(String));
      return releaseSlot();
    });
    try {
      fail(new Error(`Claude AI usage limit reached|${reset}`));
      await waitForProduct(manager, store, () => !!store.getRun(record.id)?.autoResumeAt && !manager.isActive(record.id));
      await fixtureWorkSettled(root);
      expect(raced).toBe(late);
      // The hold is the failure's own write (hearsay-tools/squawk#3337): a wait committed as it lands
      // stays open on the held run, and the retry delivers it (hold.wait-resolves).
      if (late) {
        expect(heldSnapshot).toMatchObject({ status: RUN_STATUS.waiting, autoResumeAt: expect.any(String),
          waits: expect.arrayContaining([expect.objectContaining({ id: lateWait.id, phase: WAIT_PHASE.open })]) });
        expect(store.getRun(record.id)?.waits).toContainEqual(expect.objectContaining({ id: lateWait.id, phase: WAIT_PHASE.open }));
      }
      expect(startSession).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalled();
      expect(store.getRun(record.id)).toMatchObject({ status: RUN_STATUS.waiting, autoResumeAt: expect.any(String) });
      expect(store.readEvents(record.id).filter(event => String(event.message).includes('continu'))).toEqual([]);
    } finally {
      store.off('event', commitLateWait);
    }

  }

  it('publishes a usage-limit resume before releasing a failed run', () => usageLimitFailure(false));
  it('a timer wait committed as the run holds stays open without queuing a wake', () => usageLimitFailure(true));

  it('uses current step statuses after diff I/O, retaining a concurrent failure', async () => {
    const id = seed();
    vi.mocked(worktreeDiff).mockImplementationOnce(async () => {
      store.updateStep(id, 'waiting-false', { status: STEP_STATUS.failed, error: 'late failure', finishedAt: oldFinish });
      store.addStep(id, { id: 'late-step', name: 'Late step', kind: STEP_KIND.agent, synthetic: 'continuation' });
      store.updateStep(id, 'late-step', { status: STEP_STATUS.running });
      return 'changed';
    });
    await settle(id);
    expect(store.getRun(id)?.steps.find(step => step.id === 'waiting-false')).toMatchObject({ status: STEP_STATUS.failed, error: 'late failure', finishedAt: oldFinish });
    expect(store.getRun(id)?.steps.find(step => step.id === 'late-step')).toMatchObject({ status: STEP_STATUS.done, finishedAt: store.getRun(id)?.finishedAt });
  });

  function fakeState(finishRequested = false, cancelled = false) {
    const state = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
    if (finishRequested) state.liveSession.requestFinish();
    if (cancelled) state.liveSession.cancel();
    return state;
  }

  function policy(active: Map<string, ActiveRun>, disposed: boolean | (() => boolean), asyncSuccess = false) {
    type Args = ConstructorParameters<typeof RunSettlement>;
    return new RunSettlement({ createRunner: noRunners, home: testHome(), store, repoRoot: root, dataDir: join(root, '.ai/cezar'),
      work: new TrackedWork(), semaphore: new WorkspaceSemaphore({ home: testHome() }), disposed: () => typeof disposed === 'function' ? disposed() : disposed },
      unused<Args[1]>('humanWaits'), unused<Args[2]>('workerQuestions'), unused<Args[3]>('autosave', asyncSuccess ? { autosaveCleanupBlocker: () => undefined } : {}),
      unused<Args[4]>('bookkeeper'), unused<Args[5]>('line'), unused<Args[6]>('resume'),
      unused<Args[7]>('workers'), unused<Args[8]>('completionGate'),
      unused<Args[9]>('host', { active, generation: () => undefined,
        ...(asyncSuccess ? { deferParentCompletion: () => false } : {}) }), '', '');
  }

  it.each([false, true])('does not reconcile a replacement execution during diff I/O (disposed=%s)', async disposed => {
    const id = seed();
    const original = fakeState(true);
    const active = new Map([[id, original]]);
    let detached = false;
    const settlement = policy(active, () => detached, true);
    vi.mocked(worktreeDiff).mockImplementationOnce(async () => {
      detached = disposed;
      active.set(id, fakeState());
      return 'changed';
    });
    const before = structuredClone(store.getRun(id)!);
    await settlement.settleSuccess(id);
    expect(store.getRun(id)?.status).toBe(before.status);
    expect(store.getRun(id)?.finishedAt).toBe(before.finishedAt);
    expect(store.getRun(id)?.steps).toEqual(before.steps);
  });

  it('disposal without terminal intent leaves the row unchanged after diff I/O', async () => {
    const id = seed();
    const active = new Map([[id, fakeState()]]);
    let disposed = false;
    const settlement = policy(active, () => disposed, true);
    vi.mocked(worktreeDiff).mockImplementationOnce(async () => {
      disposed = true;
      active.clear();
      return 'changed';
    });
    const before = structuredClone(store.getRun(id)!);
    await settlement.settleSuccess(id);
    expect(store.getRun(id)?.status).toBe(before.status);
    expect(store.getRun(id)?.finishedAt).toBe(before.finishedAt);
    expect(store.getRun(id)?.steps).toEqual(before.steps);
  });

  it.each(['none', 'finish', 'cancel'] as const)('disposal during diff I/O preserves explicit terminal intent: %s', intent => {
    const original = fakeState(intent === 'finish', intent === 'cancel');
    expect(policy(new Map(), true).successSuperseded('run', RUN_STATUS.waiting, original, undefined)).toBe(intent === 'none');
  });

  it.each(['finish', 'cancel'] as const)('public %s survives disposal during success diff I/O', async intent => {
    const id = seed(true);
    vi.mocked(worktreeDiff).mockImplementationOnce(async () => {
      if (intent === 'cancel') {
        expect(manager.cancel(id)).toBe(true);
        expect(store.getRun(id)?.status).toBe(RUN_STATUS.cancelled);
      }
      manager.dispose();
      return 'changed';
    });
    await settle(id, true);
    const completed = store.getRun(id)!;
    expect(completed.status).toBe(intent === 'cancel' ? RUN_STATUS.cancelled : RUN_STATUS.done);
    expect(completed.finishedAt).toBeDefined();
    expect(completed.steps.some(step => step.status === 'running' || step.status === 'waiting')).toBe(false);
  });
});
