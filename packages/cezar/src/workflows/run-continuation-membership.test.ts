import { idleClose, observeIdleClose } from './worker-wait-readiness.testkit.ts';
import { setupMonitoringFixture } from './run-fixture.testkit.ts';
import { createFixtureManager } from './fixture-cleanup.testkit.ts';
import { describe, expect, it } from 'vitest';
import { RUN_STATUS, STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
describe('RunManager continuation membership', () => {
  const fixture = setupMonitoringFixture();
  const { SINGLE_STEP, waitFor } = fixture;
  it('does not let Finish skip a remaining workflow after an idle-closed synthetic continuation', async () => {
    const clock = observeIdleClose(fixture.store);
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'mock:cezar-ask choose', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, (candidate) => candidate?.status === 'waiting');
    fixture.store.addStep(record.id, { id: 'later', name: 'Later', kind: STEP_KIND.agent });
    fixture.store.updateRun(record.id, { workflowDef: {
      name: 'ask-then-later', source: 'file',
      steps: [SINGLE_STEP.steps[0]!, { id: 'later', name: 'Later', prompt: 'mock:cezar-done later' }],
    } });
    await idleClose(clock, record.id, fixture.manager, fixture.store, predicate => waitFor(record.id, predicate));
    expect(fixture.manager.continueRun(record.id, { text: 'mock:cezar-ask choose again' })).toEqual({ ok: true });
    await waitFor(record.id, (candidate) => candidate?.status === 'waiting');
    await idleClose(clock, record.id, fixture.manager, fixture.store, predicate => waitFor(record.id, predicate));

    expect(fixture.manager.finish(record.id)).toBe(false);
    expect(fixture.store.getRun(record.id)).toMatchObject({ status: RUN_STATUS.waiting, currentStepId: 'continue-1' });
  }, 30_000);

  it('recognizes a legacy final continuation from workflow membership after restart', async () => {
    const clock = observeIdleClose(fixture.store);
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'plain markerless turn', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, candidate => candidate?.status === 'waiting');
    await idleClose(clock, record.id, fixture.manager, fixture.store, predicate => waitFor(record.id, predicate));
    expect(fixture.manager.continueRun(record.id, { text: 'plain markerless continuation' })).toEqual({ ok: true });
    await waitFor(record.id, candidate => candidate?.status === 'waiting');
    await idleClose(clock, record.id, fixture.manager, fixture.store, predicate => waitFor(record.id, predicate));
    fixture.store.getRun(record.id)!.steps.find(step => step.id === 'continue-1')!.synthetic = undefined;
    fixture.store.updateRun(record.id, { continuationMessage: undefined, workflowDef: SINGLE_STEP });
    fixture.store.flush();
    fixture.manager.dispose();
    fixture.manager = createFixtureManager(fixture.store, fixture.repoRoot);
    await fixture.manager.recover();
    expect(fixture.manager.finish(record.id)).toBe(true);
  }, 30_000);
});
