import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore, type StepState } from '../runs/store.ts';
import { RunManager } from './run.ts';
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
  let manager: RunManager;
  let settle: (id: string, durable?: boolean) => Promise<void>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-settlement-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = new RunManager(store, root);
    settle = (manager as unknown as { settleSuccess(id: string, durable?: boolean): Promise<void> }).settleSuccess.bind(manager);
    vi.mocked(worktreeDiff).mockResolvedValue('a changed file');
    vi.stubEnv('CEZ_REVIEW_GATE', '0');
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function seed(durable = false) {
    const record = store.createRun({ title: 'settlement', task: 'finish', workflow: 'quick-task', steps: [] });
    for (const status of [...liveStatuses, ...preservedStatuses]) {
      for (const stamped of [false, true]) {
        const id = `${status}-${stamped}`;
        store.addStep(record.id, { id, name: id, kind: 'agent', synthetic: 'continuation' });
        store.updateStep(record.id, id, { status, startedAt: oldFinish, ...(stamped ? { finishedAt: oldFinish } : {}) });
      }
    }
    store.updateRun(record.id, { status: 'waiting', currentStepId: 'waiting-false', worktreePath: root,
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
          expect(completed.steps.find(step => step.id === `${live}-false`)).toMatchObject({ status: 'done', finishedAt: completed.finishedAt, startedAt: oldFinish });
          expect(completed.steps.find(step => step.id === `${live}-true`)).toMatchObject({ status: 'done', finishedAt: oldFinish, startedAt: oldFinish });
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

  it('uses current step statuses after diff I/O, retaining a concurrent failure', async () => {
    const id = seed();
    vi.mocked(worktreeDiff).mockImplementationOnce(async () => {
      store.updateStep(id, 'waiting-false', { status: 'failed', error: 'late failure', finishedAt: oldFinish });
      store.addStep(id, { id: 'late-step', name: 'Late step', kind: 'agent', synthetic: 'continuation' });
      store.updateStep(id, 'late-step', { status: 'running' });
      return 'changed';
    });
    await settle(id);
    expect(store.getRun(id)?.steps.find(step => step.id === 'waiting-false')).toMatchObject({ status: 'failed', error: 'late failure', finishedAt: oldFinish });
    expect(store.getRun(id)?.steps.find(step => step.id === 'late-step')).toMatchObject({ status: 'done', finishedAt: store.getRun(id)?.finishedAt });
  });

  it.each([false, true])('does not reconcile a replacement execution during diff I/O (disposed=%s)', async disposed => {
    const id = seed();
    const active = (manager as unknown as { active: Map<string, unknown> }).active;
    active.set(id, { finishRequested: true });
    vi.mocked(worktreeDiff).mockImplementationOnce(async () => {
      if (disposed) manager.dispose();
      // A new ActiveRun is the generation boundary used by Continue admission.
      active.set(id, {});
      store.updateRun(id, { status: 'running' });
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
    const active = (manager as unknown as { active: Map<string, unknown> }).active;
    active.set(id, { finishRequested: intent === 'finish', cancelled: intent === 'cancel' });
    vi.mocked(worktreeDiff).mockImplementationOnce(async () => {
      manager.dispose();
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
