import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInput, Wait } from '@open-mercato/cezar-contract';

import { readPersistedRuns } from './run-store.testkit.ts';
import { RunStore } from './store.ts';

/**
 * A resume time belongs only to a `waiting` run (hearsay-tools/cezarion#1496): every commit that
 * leaves `waiting` takes `autoResumeAt` off the row it writes. Each case starts from a usage-limit
 * hold and reads the committed row, as another process or the next start would, so a value kept
 * only in memory cannot pass. The attempt counter is not the resume time: `MAX_AUTO_RESUMES`
 * counts attempts across resumes, so it stays.
 */

const AT = '2026-10-25T23:00:00.000Z';
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cez-resume-time-'));
  const store = RunStore.open(dir, { keepLive: true });
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const hold = (id: string, extra: Parameters<RunStore['updateRun']>[1] = {}) => {
    store.updateRun(id, { status: 'waiting', autoResumeAt: AT, autoResumeAttempts: 2, ...extra });
    store.flush();
    expect(committed(id)).toMatchObject({ status: 'waiting', autoResumeAt: AT });
  };
  const committed = (id: string) => readPersistedRuns(dir).find((row) => row.id === id);
  const root = () => {
    const { id } = store.createRun({ title: 'held', task: 'held', workflow: 'quick-task', steps: [] });
    hold(id, { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    return id;
  };
  return { dir, store, hold, committed, root };
}

function resolvedTimer(): Wait {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), kind: 'timer', source: 'agent', via: 'cezar_wait', registeredAt: now, deadline: now, phase: 'resolved',
    resolvedAt: now, turnId: 'turn-1', seconds: 60,
  } as Wait;
}

describe('a commit that leaves waiting', () => {
  it('drops the resume time when a delivery resumes the hold to running', () => {
    const { store, hold, committed } = setup();
    const { id } = store.createRun({ title: 'held', task: 'held', workflow: 'quick-task', steps: [] });
    hold(id);
    const wait = resolvedTimer();
    const input: AgentInput = { id: wait.id, parentRunId: id, source: 'lifecycle', text: 'wake', createdAt: new Date().toISOString() };
    store.commitWait(id, wait, input);
    store.commitWaitDelivery(id, [wait.id], {}, true);
    expect(committed(id)).toMatchObject({ status: 'running', autoResumeAttempts: 2 });
    expect(committed(id)).not.toHaveProperty('autoResumeAt');
    expect(store.getRun(id)?.autoResumeAt).toBeUndefined();
  });

  it('drops the resume time when a pending Finish is cancelled', () => {
    const { store, committed, root } = setup();
    const id = root();
    store.commitRootFinishIntent(id);
    expect(store.commitRootFinishCancellation(id)).toBe(true);
    expect(committed(id)).toMatchObject({ status: 'cancelled', autoResumeAttempts: 2 });
    expect(committed(id)).not.toHaveProperty('autoResumeAt');
    expect(store.getRun(id)?.autoResumeAt).toBeUndefined();
  });

  it.each(['done', 'review'] as const)('drops the resume time when a pending Finish settles %s', (status) => {
    const { store, committed, root } = setup();
    const id = root();
    store.commitRootFinishIntent(id);
    expect(store.commitRootFinishSuccess(id, status)).toBe(true);
    expect(committed(id)).toMatchObject({ status });
    expect(committed(id)).not.toHaveProperty('autoResumeAt');
    expect(store.getRun(id)?.autoResumeAt).toBeUndefined();
  });

  it('drops the resume time when a held worker is cancelled', () => {
    const { dir, store, hold, committed, root } = setup();
    const parentId = root();
    const workerId = randomUUID();
    const worker = store.createOwnedRun({ title: 'worker', task: 'worker', workflow: 'quick-task', runner: 'claude', steps: [] }, parentId, randomUUID(), {
      role: 'worker', permissions: [], parentRunId: parentId,
      workspace: { ownerRunId: workerId, resourceId: randomUUID(), kind: 'owned-isolated', path: join(dir, 'absent-worktree'), branch: `cez/${workerId.slice(0, 8)}`, baselineSha: 'a'.repeat(40) },
    }, 'a'.repeat(64));
    hold(worker.id);
    store.commitWorkerCancellation(worker.id);
    expect(committed(worker.id)).toMatchObject({ status: 'cancelled', autoResumeAttempts: 2 });
    expect(committed(worker.id)).not.toHaveProperty('autoResumeAt');
    expect(store.getRun(worker.id)?.autoResumeAt).toBeUndefined();
  });
});

describe('a commit that stays waiting', () => {
  // Passes before and after the rule: it pins that the rule does not retire the appointment itself.
  it('keeps the resume time of the hold', () => {
    const { store, hold, committed } = setup();
    const { id } = store.createRun({ title: 'held', task: 'held', workflow: 'quick-task', steps: [] });
    hold(id);
    const wait = resolvedTimer();
    store.commitWait(id, wait);
    expect(committed(id)).toMatchObject({ status: 'waiting', autoResumeAt: AT, autoResumeAttempts: 2 });
    expect(store.getRun(id)?.autoResumeAt).toBe(AT);
  });
});
