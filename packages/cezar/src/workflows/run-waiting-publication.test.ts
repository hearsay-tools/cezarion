import { setupMonitoringFixture } from './run-fixture.testkit.ts';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUN_STATUS, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
describe('RunManager waiting publication', () => {
  const fixture = setupMonitoringFixture();
  const { SINGLE_STEP, waitFor, publishedWaiting, persistedRun } = fixture;
  it.each([
    { name: 'dry-run runner', task: 'plain markerless turn' },
    { name: 'Codex app-server', runner: 'codex' as const, task: 'plain markerless Codex turn' },
  ])('$name publishes and persists a complete waiting record before yielding', async ({ runner, task }) => {
    if (runner === 'codex') {
      process.env.CEZ_CODEX_BIN = join(import.meta.dirname, '../core/__fixtures__/codex/mock-codex-app-server.mjs');
    }
    const record = fixture.manager.startRun(SINGLE_STEP, { task, ...(runner ? { runner } : {}), worktree: false });
    fixture.currentId = record.id;
    const published = await publishedWaiting(record.id);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(published).toMatchObject({ status: RUN_STATUS.waiting });
    expect(published.steps.find((step) => step.id === published.currentStepId)?.status).toBe('waiting');
    expect(persistedRun(record.id)).toMatchObject({
      status: RUN_STATUS.waiting,
      steps: [expect.objectContaining({ id: 'task', status: STEP_STATUS.waiting })],
    });
  });

  it('a continuation turn persists a complete waiting record before yielding', async () => {
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'first markerless turn', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, (candidate) => candidate?.status === 'waiting');
    fixture.store.flush();

    // Delivery publishes turn.started before resumeParkedRun; ignore that prior parked snapshot.
    let resumed = false;
    const published = publishedWaiting(record.id, () => resumed);
    expect(fixture.manager.sendMessage(record.id, [{ type: 'text', text: 'mock:hold second markerless turn' }])).toBe(true);
    fixture.store.flush();
    resumed = true;
    await published;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(persistedRun(record.id)).toMatchObject({
      status: RUN_STATUS.waiting,
      steps: [expect.objectContaining({ id: 'task', status: STEP_STATUS.waiting })],
    });
  });
});
