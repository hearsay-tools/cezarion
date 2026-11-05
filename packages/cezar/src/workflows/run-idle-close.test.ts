import { idleClose, observeIdleClose, sessionOf } from './worker-wait-readiness.testkit.ts';
import { setupMonitoringFixture } from './run-fixture.testkit.ts';
import { createFixtureManager } from './fixture-cleanup.testkit.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAgentTmpDir } from '../runs/agent-tmpdir.ts';
describe('RunManager idle close', () => {
  const fixture = setupMonitoringFixture();
  const { SINGLE_STEP, waitFor } = fixture;
  it.each(['fresh', 'continuation'].flatMap(mode => ['zero-config', 'delegated root'].flatMap(delegation => [
    { mode, delegation, name: 'markerless wait', task: 'just do the thing' },
    { mode, delegation, name: 'cezar_ask wait', task: 'mock:cezar-ask choose' },
  ])))('idle-closes a $mode $delegation $name without completing it, matching restart recovery (#280)', async ({ mode, delegation, task }) => {
    const clock = observeIdleClose(fixture.store);
    const record = fixture.manager.startRun(SINGLE_STEP, {
      task: mode === 'fresh' ? task : 'just do the thing',
      worktree: false,
    });
    if (delegation === 'delegated root') {
      fixture.store.commitDelegation([{
        id: record.id,
        delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] },
      }]);
    }
    fixture.currentId = record.id;
    await waitFor(record.id, (candidate) => candidate?.status === 'waiting');
    if (mode === 'continuation') {
      expect(fixture.manager.finish(record.id)).toBe(true);
      await waitFor(record.id, (candidate) => candidate?.status === 'done' || candidate?.status === 'review');
      expect(fixture.manager.continueRun(record.id, { text: task })).toEqual({ ok: true });
      await waitFor(record.id, (candidate) => candidate?.status === 'waiting');
    }

    const session = sessionOf(record.id);

    // Resolved, not hand-built: a deep sandbox checkout falls back to the short
    // OS-temp location (#387), and idle-close must preserve THAT directory.
    const scratch = resolveAgentTmpDir(join(fixture.repoRoot, '.ai/cezar'), record.id);
    expect(existsSync(scratch)).toBe(true);
    await idleClose(clock, record.id, fixture.manager, fixture.store, predicate => waitFor(record.id, predicate));

    const idleClosed = structuredClone(fixture.store.getRun(record.id));
    expect(session.open).toBe(false); // the runner CLI is still terminated
    expect(idleClosed?.status).toBe('waiting');
    expect(idleClosed?.finishedAt).toBeUndefined();
    const waitingStep = idleClosed?.steps.find((step) => step.id === idleClosed.currentStepId);
    expect(waitingStep?.status).toBe('waiting');
    expect(waitingStep?.finishedAt).toBeUndefined();
    expect(existsSync(scratch)).toBe(true); // task scratch outlives the idle-closed session (#515)

    // The idle-closed run no longer owns the in-place checkout lease.
    const successor = fixture.manager.startRun(SINGLE_STEP, { task: 'mock:cezar-done successor', worktree: false });
    fixture.currentId = successor.id;
    await waitFor(successor.id, (candidate) => candidate?.status === 'done' || candidate?.status === 'review');

    fixture.manager.dispose();
    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot);
    await fixture.manager.recover();
    expect(fixture.store.getRun(record.id)).toEqual(idleClosed);
    if (mode === 'fresh' && delegation === 'zero-config' && task === 'just do the thing') {
      expect(fixture.manager.finish(record.id)).toBe(true);
    } else {
      expect(fixture.manager.continueRun(record.id, { text: 'mock:cezar-done resume after idle close' })).toEqual({ ok: true });
    }
    fixture.currentId = record.id;
    await waitFor(record.id, (candidate) => candidate?.status === 'done' || candidate?.status === 'review');
    expect(fixture.store.getRun(record.id)?.steps.find(step => step.id === 'task')?.status).toBe('done');
  }, 30_000);
});
