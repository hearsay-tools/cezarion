import { RunSettlement } from './run/run-settlement.ts';
import { AutoResumeScheduler } from './run/auto-resume.ts';
import { TrackedWork } from './run/tracked-work.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { createActiveRun, type ActiveRun } from './active-run.ts';
import type { RunModuleContext } from './run/types.ts';
import { hasPendingHumanAsk, pendingHumanAskSeq } from './run/pending-ask-facts.ts';
import { makeTimerWait, RUN_STATUS, STEP_STATUS, STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore, type StepState } from '../runs/store.ts';
import { worktreeDiff } from '../git-worktree.ts';

vi.mock('../git-worktree.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../git-worktree.ts')>(),
  worktreeDiff: vi.fn(async () => 'a changed file'),
}));

const oldFinish = '2026-07-01T12:00:00.000Z';
const liveStatuses = ['waiting', 'running'] as const;
const preservedStatuses = ['done', 'failed', 'cancelled', 'skipped', 'pending'] as const;

describe('successful run settlement (#473)', () => {
  let root: string;
  let store: RunStore;
  let settlement: RunSettlement;
  let scheduler: AutoResumeScheduler;
  let context: RunModuleContext;
  let disposed: boolean;
  const active = new Map<string, ActiveRun>();
  const releaseSlot = vi.fn();
  function fakeState(patch: Partial<ActiveRun> = {}) {
    const state = createActiveRun({ cwd: root, pendingHumanAsk: false, autonomous: false });
    Object.assign(state, patch);
    return state;
  }
  function dispose() { disposed = true; active.clear(); scheduler.dispose(); }
  let settle: (id: string, durable?: boolean) => Promise<void>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-settlement-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    disposed = false;
    active.clear();
    releaseSlot.mockReset();
    context = { store, repoRoot: root, dataDir: join(root, '.ai/cezar'), work: new TrackedWork(),
      semaphore: new WorkspaceSemaphore(), disposed: () => disposed };
    scheduler = new AutoResumeScheduler(context, { move: (id, exit, patch) => store.move(id, exit, patch),
      continueRun: vi.fn(), pump: vi.fn(async () => {}) });
    type Args = ConstructorParameters<typeof RunSettlement>;
    settlement = new RunSettlement(context, {} as Args[1], {} as Args[2],
      { autosaveCleanupBlocker: () => undefined } as unknown as Args[3],
      { forget: vi.fn() } as unknown as Args[4],
      { clearForced: vi.fn(), hasStarting: () => false, hasQueued: () => false } as unknown as Args[5], scheduler,
      { has: () => false } as unknown as Args[7], {} as Args[8], {
        active, isActive: id => active.has(id), generation: () => undefined,
        deferParentCompletion: id => hasPendingHumanAsk(id, key => pendingHumanAskSeq(store, key)),
        move: (id, exit, patch) => store.move(id, exit, patch),
        forgetMemoryPause: vi.fn(), isDisposedDelegatedRun: () => false, reconcileWorkerWaits: vi.fn(),
        queueWaitWake: vi.fn(), releaseSlot, hasClaim: () => false, autosaveCleanupBlocker: () => undefined,
      } satisfies Partial<Args[9]> as unknown as Args[9], '', '');
    settle = settlement.settleSuccess.bind(settlement);
    vi.mocked(worktreeDiff).mockResolvedValue('a changed file');
    vi.stubEnv('CEZ_REVIEW_GATE', '0');
  });

  afterEach(() => {
    dispose();
    store.flush();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function seed(durable = false) {
    const record = store.createRun({ title: 'settlement', task: 'finish', workflow: 'quick-task', steps: [] });
    for (const status of [...liveStatuses, ...preservedStatuses]) {
      for (const stamped of [false, true]) {
        const id = `${status}-${stamped}`;
        store.addStep(record.id, { id, name: id, kind: STEP_KIND.agent, synthetic: 'continuation' });
        store.updateStep(record.id, id, { status, startedAt: oldFinish, ...(stamped ? { finishedAt: oldFinish } : {}) });
      }
    }
    store.updateRun(record.id, { status: RUN_STATUS.waiting, currentStepId: 'waiting-false', worktreePath: root,
      ...(durable ? { delegation: { role: 'root' as const, permissions: [], receipts: [] } } : {}),
    });
    if (durable) store.commitRootFinishIntent(record.id);
    return record.id;
  }

  for (const durable of [false, true]) {
    for (const status of ['done', 'review'] as const) {
      it(`${durable ? 'durable root' : 'ordinary'} ${status} closes only live steps and preserves timestamps`, async () => {
        vi.stubEnv('CEZ_REVIEW_GATE', status === 'review' ? '1' : '0');
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
      vi.mocked(worktreeDiff).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      const pending = settle(id, durable);
      store.updateRun(id, { status, finishedAt: oldFinish });
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
    if (timing === 'before diff') ask();
    else vi.mocked(worktreeDiff).mockImplementationOnce(async () => { ask(); return 'changed'; });
    await settle(id, true);
    expect(store.getRun(id)?.status).toBe('waiting');
    expect(store.getRun(id)?.finishedAt).toBeUndefined();
    expect(store.getRun(id)?.steps).toEqual(steps);
  });

  it('publishes a usage-limit resume before releasing a failed run with an open wait', () => {
    const run = store.createRun({ title: 'limit', task: 'wait', workflow: 'quick-task', steps: [] });
    store.addStep(run.id, { id: 'work', name: 'Work', kind: STEP_KIND.agent });
    store.updateStep(run.id, 'work', { status: STEP_STATUS.failed, sessionId: 'session-1' });
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const now = new Date().toISOString();
    store.updateRun(run.id, { status: RUN_STATUS.running });
    const held = store.pin(run.id, 'active')!;
    store.pin(run.id, 'continue');
    store.updateRun(run.id, {
      status: RUN_STATUS.failed, error: `Claude AI usage limit reached|${reset}`,
      agentInputs: [{ id: randomUUID(), parentRunId: run.id, source: 'lifecycle', text: 'pending', createdAt: now }],
    });
    held.waits = [makeTimerWait({ id: randomUUID(), registeredAt: now, deadline: new Date(Date.now() + 60_000).toISOString() })];
    const snapshots: Array<{ resume: string | undefined }> = [];
    releaseSlot.mockImplementation(() => {
      snapshots.push({ resume: store.getRun(run.id)?.autoResumeAt });
    });
    store.unpin(run.id, 'active');
    settlement.afterDropActive(run.id);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({ resume: expect.any(String) });
    expect(store.getRun(run.id)?.status).toBe('waiting');
    store.unpin(run.id, 'continue');
  });

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

  it.each([false, true])('does not reconcile a replacement execution during diff I/O (disposed=%s)', async disposed => {
    const id = seed();
    active.set(id, fakeState({ finishRequested: true }));
    vi.mocked(worktreeDiff).mockImplementationOnce(async () => {
      if (disposed) dispose();
      // A new ActiveRun is the generation boundary used by Continue admission.
      active.set(id, fakeState());
      store.updateRun(id, { status: RUN_STATUS.running });
      return 'changed';
    });
    const steps = structuredClone(store.getRun(id)!.steps);
    try {
      await settle(id);
      expect(store.getRun(id)?.status).toBe('running');
      expect(store.getRun(id)?.finishedAt).toBeUndefined();
      expect(store.getRun(id)?.steps).toEqual(steps);
    } finally { active.delete(id); }
  });

  it.each(['none', 'finish', 'cancel'] as const)('disposal during diff I/O preserves explicit terminal intent: %s', async intent => {
    const id = seed();
    active.set(id, fakeState({ finishRequested: intent === 'finish', cancelled: intent === 'cancel' }));
    vi.mocked(worktreeDiff).mockImplementationOnce(async () => {
      dispose();
      return 'changed';
    });
    await settle(id);
    const completed = store.getRun(id)!;
    expect(completed.status).toBe(intent === 'none' ? 'waiting' : intent === 'cancel' ? 'cancelled' : 'done');
    if (intent === 'none') expect(completed.finishedAt).toBeUndefined();
    else {
      expect(completed.finishedAt).toBeDefined();
      expect(completed.steps.some(step => step.status === 'running' || step.status === 'waiting')).toBe(false);
    }
  });
});
