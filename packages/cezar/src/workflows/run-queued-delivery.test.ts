import { runInternals } from './run-internals.testkit.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { run, GIT_ID, waitForProduct } from './run-fixture.testkit.ts';
describe('queued stacking reaches the backend (#472)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const savedEnv: Record<string, string | undefined> = {};

  const WORKFLOW: WorkflowDef = {
    name: '(planned)',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Do the task', prompt: '{{task}}' }],
  };

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-472-e2e-'));
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    // One slot, so the second run demonstrably waits in the queue.
    writeFileSync(join(repoRoot, '.ai/cezar', 'config.json'), JSON.stringify({ maxParallel: 1 }));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
  });

  afterAll(async () => {
    await drainFixtureManagers(repoRoot);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('delivers the task plus every stacked message, with the edit applied', async () => {
    manager.startRun(WORKFLOW, { task: 'mock:cezar-done occupy the slot', worktree: false });
    const second = manager.startRun(WORKFLOW, { task: 'mock:cezar-done original prompt', worktree: false });

    // The second run is holding in the queue — amend it there.
    expect(store.getRun(second.id)?.status).toBe('queued');
    const typo = manager.enqueueMessage(second.id, [{ type: 'text', text: 'STACKEDONE with a typo' }]);
    expect(typo).not.toBeNull();
    manager.enqueueMessage(second.id, [{ type: 'text', text: 'STACKEDTWO' }]);
    // …and fix the first one before it starts.
    manager.editQueuedMessage(second.id, typo!.id, { text: 'STACKEDONE corrected' });

    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    await waitForProduct(manager, store, () => terminal.has(store.getRun(second.id)?.status ?? '') && !manager.isActive(second.id), 40_000);

    // The mock records the head of each session's userText, one line per spawned
    // session. The second run's line must carry the folded prompt.
    const notes = readFileSync(join(repoRoot, 'notes.md'), 'utf8').trim().split('\n');
    const line = notes.find((n) => n.includes('original prompt'));
    expect(line).toBeDefined();
    expect(line).toContain('STACKEDONE corrected');
    expect(line).toContain('STACKEDTWO');
    // The typo never reached the backend.
    expect(line).not.toContain('with a typo');
    // Order is preserved: task, then the stack.
    expect(line!.indexOf('original prompt')).toBeLessThan(line!.indexOf('STACKEDONE corrected'));
    expect(line!.indexOf('STACKEDONE corrected')).toBeLessThan(line!.indexOf('STACKEDTWO'));

    // And the record still holds the two parts separately — never the folded string.
    expect(store.getRun(second.id)?.task).toBe('mock:cezar-done original prompt');
    expect(store.getRun(second.id)?.queuedMessages).toHaveLength(2);
  }, 60_000);
});

describe('recover() carries the queued stack exactly once (#472)', () => {
  let repoRoot: string;
  let store: RunStore;

  const WORKFLOW = {
    name: '(planned)',
    source: 'built-in' as const,
    steps: [{ id: 'task', name: 'Do the task', prompt: '{{task}}' }],
  };

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-recover-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('folds once across repeated recoveries', async () => {
    const r = store.createRun({ title: 't', workflow: '(planned)', task: 'the original task', steps: [] });
    store.updateRun(r.id, {
      status: RUN_STATUS.queued,
      workflowDef: WORKFLOW,
      queuedMessages: [
        { id: 'm1', text: 'the stacked bit', createdAt: '2026-07-21T10:00:00.000Z' },
      ],
    });

    const expected = 'the original task\n\nthe stacked bit';
    const jobsOf = (m: RunManager) =>
      runInternals(m).line.pendingJobs;

    // Two successive restarts, each re-adopting the same record.
    for (let restart = 0; restart < 2; restart += 1) {
      const manager = createFixtureManager(store, repoRoot);
      // Keep the run parked in the queue: recover() pushes and pumps, but with the
      // job still pending we can read exactly what it rebuilt.
      await manager.recover();
      expect(jobsOf(manager).get(r.id)?.input.task).toBe(expected);
      // The record is never rewritten — that is what stops the compounding.
      expect(store.getRun(r.id)?.task).toBe('the original task');
    }
  });
});
