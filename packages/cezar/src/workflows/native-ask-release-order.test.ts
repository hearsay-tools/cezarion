import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { useBoundaryRunner } from './boundary-runner.testkit.ts';
import { setupMonitoringFixture, waitForProduct } from './run-fixture.testkit.ts';

const f = setupMonitoringFixture();
afterEach(() => vi.restoreAllMocks());
const runner = useBoundaryRunner();

it('native ask routes only after synchronous release withdraws expired parent hold', async () => {
  const release = vi.spyOn(f.semaphore, 'release');
  const worker = f.manager.startRun(f.SINGLE_STEP, { task: 'work', runner: 'claude', worktree: false });
  f.currentId = worker.id;
  await waitForProduct(f.manager, f.store, () => runner.sessions.length === 1);
  // Finish the startup sweep before publishing the unarmed hold. The next release has one idle participant.
  await f.semaphore.release();
  await Promise.all(release.mock.results.map(result => result.value));
  release.mockClear();
  const parent = f.store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', runner: 'claude', steps: [] });
  f.store.move(parent.id, 'start');
  f.store.move(parent.id, 'fail', { error: 'provider usage limit' });
  f.store.move(parent.id, 'hold', { autoResumeAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString() });
  f.store.commitDelegation([{ id: parent.id, delegation: { role: 'root', permissions: ['spawn', 'wait', 'steer'], receipts: [] } },
    { id: worker.id, delegation: { role: 'worker', permissions: [], parentRunId: parent.id,
      workspace: { ownerRunId: worker.id, resourceId: randomUUID(), kind: 'owned-isolated', path: f.repoRoot, branch: 'worker', baselineSha: 'a'.repeat(40) } } }]);
  runner.emitUi({ type: 'ask.requested', requestId: randomUUID(), questions: [{ header: 'Choice', question: 'Which path?' }] });
  // Read before the callback's release pump or any family microtask can settle.
  expect(release).toHaveBeenCalled();
  const atReturn = structuredClone(f.store.getRun(parent.id));
  expect(atReturn?.status).toBe('failed');
  expect(atReturn?.autoResumeAt).toBeUndefined();
  expect(atReturn?.delegation?.role).toBe('root');
  expect(atReturn?.delegation?.role === 'root' ? atReturn.delegation.conversation?.messages ?? [] : []).toEqual([]);
  expect(atReturn?.agentInputs ?? []).toEqual([]);
  const events = f.store.readEvents(worker.id);
  expect(events.filter(event => event.type === 'human-ask-closed')).toEqual([
    expect.objectContaining({ reason: 'parent-stopped' }),
  ]);
  expect(events.filter(event => event.type === 'worker-question-routed')).toEqual([]);
  // A failed parent leaves its worker running (hearsay-tools/squawk#3337): its question closed above.
  expect(f.store.getRun(worker.id)?.status).not.toBe('cancelled');
});
