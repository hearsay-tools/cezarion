import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';


const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Restart recovery vs the autonomous flag (#489). `recover()` re-queues a
 * `queued` run by rebuilding its StartRunInput from the persisted record — the
 * one engine path that does NOT go through `startRun`. It must re-thread
 * `autonomous` (H2 in the spec) so a recovered autonomous run stays autonomous.
 *
 * The review-gate outcome after recovery is driven by the *record's* persisted
 * `autonomous` (which `settleSuccess`/group-pick read and which recover never
 * overwrites); this test pins that invariant. A workspace semaphore capped at 0
 * (the cap is workspace-level since spec 2026-07-20, step 2.5) keeps the queue
 * from dispatching, so nothing spawns.
 */
describe('recover() and the autonomous flag (#489)', () => {
  let repoRoot: string;
  let store: RunStore;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-recover-auto-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  const frozen = () => new WorkspaceSemaphore({ initial: { maxParallel: 0 } });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    vi.unstubAllEnvs();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const WORKFLOW_DEF = {
    name: 'quick-task',
    description: 'x',
    source: 'built-in' as const,
    steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
  };

  const queuedRun = (autonomous: boolean | undefined): string => {
    const { id } = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 'do it',
      autonomous,
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateRun(id, { workflowDef: WORKFLOW_DEF });
    return id;
  };

  it('keeps a recovered queued run autonomous (the invariant settleSuccess reads)', async () => {
    const id = queuedRun(true);
    expect(store.getRun(id)?.autonomous).toBe(true);

    await createFixtureManager(store, repoRoot, { semaphore: frozen() }).recover();

    // Still recovered (queued), still autonomous — so a later settleSuccess lands it at `done`.
    expect(store.getRun(id)?.status).toBe('queued');
    expect(store.getRun(id)?.autonomous).toBe(true);
  });

  it('leaves a non-autonomous recovered run non-autonomous', async () => {
    const id = queuedRun(false);
    await createFixtureManager(store, repoRoot, { semaphore: frozen() }).recover();
    expect(store.getRun(id)?.autonomous).toBe(false);
  });

  it.each([true, false, undefined])('preserves saved %s through deferred Continue and restart (#458)', async (autonomous) => {
    // Changing the composer seed after launch must not re-resolve an existing run's mode.
    vi.stubEnv('CEZ_AUTONOMOUS_DEFAULT', autonomous ? '0' : '1');
    const id = queuedRun(autonomous);
    store.updateStep(id, 'work', { status: 'done', sessionId: 'previous-session', backend: 'claude' });
    store.updateRun(id, { status: 'done', runner: 'claude' });
    const manager = createFixtureManager(store, repoRoot, { semaphore: frozen() });
    try {
      expect(manager.continueRun(id, { text: 'Continue setup' }, true)).toEqual({ ok: true });
      expect(store.getRun(id)?.autonomous).toBe(autonomous);
      expect(store.getRun(id)?.status).toBe('queued');
    } finally {
      manager.dispose();
      store.flush();
    }
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    const recovered = createFixtureManager(store, repoRoot, { semaphore: frozen() });
    try {
      await recovered.recover();
      expect(store.getRun(id)?.autonomous).toBe(autonomous);
      expect(store.getRun(id)?.status).toBe('queued');
      expect(store.readEvents(id).some(event => event.type === 'lifecycle' &&
        typeof event.message === 'string' && event.message.includes('cezar restarted'))).toBe(true);
      const continuation = (recovered as unknown as {
        pendingContinuations: Map<string, { stepId: string; sessionId?: string; prompt: string }>;
      }).pendingContinuations.get(id);
      expect(continuation).toMatchObject({
        stepId: 'continue-1', sessionId: 'previous-session', prompt: 'Continue setup',
      });
      store.flush();
      expect(RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true }).getRun(id)?.autonomous)
        .toBe(autonomous);
    } finally {
      recovered.dispose();
    }
  });
});
