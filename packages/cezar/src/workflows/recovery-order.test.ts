import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';

/**
 * Which of two tied runs a restart picks back up first (#779, T7): the shape of the
 * `progressive-history` e2e failure. Two runs left `running`, created in the same millisecond, in
 * a project that runs one task at a time. Recovery continues them in the store's order, so the
 * first one takes the only slot and the other waits in the queue for it. Before `runs.db` that order was
 * `runs.json` order; ordering the tie by id handed the slot to the other run, which then held it
 * (the e2e's run parks waiting) while the expected one never left the queue.
 */
describe('recover() with tied runs in a one-slot project', () => {
  let repoRoot: string;
  let store: RunStore;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  const record = (id: string) => ({
    id, title: `run ${id}`, workflow: 'quick-task', task: 'mock:done pick me up', status: 'running',
    createdAt: '2026-07-30T00:00:00.000Z', startedAt: '2026-07-30T00:00:01.000Z', tokensUsed: 0, archived: false,
    worktree: false, currentStepId: 'work',
    workflowDef: { name: 'quick-task', source: 'built-in', steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }] },
    steps: [{ id: 'work', name: 'Work', kind: 'agent', status: 'running', iterations: 1, tokensUsed: 0, startedAt: '2026-07-30T00:00:01.000Z', sessionId: `session-${id}` }],
  });

  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-recovery-order-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  it('continues them in runs.json order: the first takes the slot, the second queues', async () => {
    // File order is not id order: by id, the second would go first.
    const first = 'cccccccc-1111-4222-8333-dddddddddddd';
    const second = 'eeeeeeee-1111-4222-8333-ffffffffffff';
    writeFileSync(join(repoRoot, '.ai/cezar/runs.json'), JSON.stringify([record(first), record(second)]));
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    const manager = createFixtureManager(store, repoRoot, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 1 } }) });

    // The order the two leave the queue: recovery requeues both, then the pump starts them.
    const queued = new Set<string>();
    const started: string[] = [];
    store.on('run', (run: { id: string; status: string }) => {
      if (run.id !== first && run.id !== second) return;
      if (run.status === 'queued') queued.add(run.id);
      else if (queued.has(run.id) && run.status === 'running' && !started.includes(run.id)) started.push(run.id);
    });

    await manager.recover();
    await expect.poll(() => started, { timeout: 20_000 }).toHaveLength(2);
    expect(started).toEqual([first, second]);
  }, 30_000);
});
