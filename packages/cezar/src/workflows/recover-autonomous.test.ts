import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import * as runners from '../core/runner-factory.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import { fixtureWorkSettled } from './fixture-cleanup.testkit.ts';
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

  const frozen = () => new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 0 } });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
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
      steps: [{ id: 'work', name: 'Work', kind: STEP_KIND.agent }],
    });
    store.updateRun(id, { workflowDef: WORKFLOW_DEF });
    return id;
  };

  it('keeps a recovered queued run autonomous (the invariant settleSuccess reads)', async () => {
    const id = queuedRun(true);
    expect(store.getRun(id)?.autonomous).toBe(true);

    await createFixtureManager(store, repoRoot, { home: testHome(), semaphore: frozen() }).recover();

    // Still recovered (queued), still autonomous — so a later settleSuccess lands it at `done`.
    expect(store.getRun(id)?.status).toBe('queued');
    expect(store.getRun(id)?.autonomous).toBe(true);
  });

  it('leaves a non-autonomous recovered run non-autonomous', async () => {
    const id = queuedRun(false);
    await createFixtureManager(store, repoRoot, { home: testHome(), semaphore: frozen() }).recover();
    expect(store.getRun(id)?.autonomous).toBe(false);
  });

  it.each([true, false, undefined])('preserves saved %s through deferred Continue and restart (#458)', async (autonomous) => {
    // Changing the composer seed after launch must not re-resolve an existing run's mode.
    vi.stubEnv('CEZ_AUTONOMOUS_DEFAULT', autonomous ? '0' : '1');
    const id = queuedRun(autonomous);
    store.updateStep(id, 'work', { status: STEP_STATUS.done, sessionId: 'previous-session', backend: 'claude' });
    setRunStatus(store, id, RUN_STATUS.done, { runner: 'claude' });
    const manager = createFixtureManager(store, repoRoot, { home: testHome(), semaphore: frozen() });
    try {
      expect(manager.continueRun(id, { text: 'Continue setup' }, true)).toEqual({ ok: true });
      expect(store.getRun(id)?.autonomous).toBe(autonomous);
      expect(store.getRun(id)?.status).toBe('queued');
    } finally {
      manager.dispose();
      store.close();
    }
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    const semaphore = frozen();
    const recovered = createFixtureManager(store, repoRoot, { home: testHome(), semaphore });
    try {
      await recovered.recover();
      expect(store.getRun(id)?.autonomous).toBe(autonomous);
      expect(store.getRun(id)?.status).toBe('queued');
      expect(store.readEvents(id).some(event => event.type === 'lifecycle' &&
        typeof event.message === 'string' && event.message.includes('cezar restarted'))).toBe(true);
      const startSession = vi.fn(() => ({
        result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }), open: false,
        sendMessage: () => false, sendAgentMessage: () => false, discardQueuedMessages: () => {},
        holdsHumanInput: () => false, interrupt: () => {}, end: () => {},
      }));
      vi.spyOn(runners, 'createRunner').mockReturnValue({
        backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
        startSession, run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => {},
      });
      vi.spyOn(semaphore, 'maxParallel').mockReturnValue(1);
      await semaphore.release();
      await fixtureWorkSettled(repoRoot);
      expect(startSession).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'previous-session', userPrompt: expect.stringContaining('Continue setup'), resume: true,
      }), expect.any(Function), expect.any(Object));
      expect(store.getRun(id)?.steps.at(-1)?.id).toBe('continue-1');
      store.flush();
      expect(RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true }).getRun(id)?.autonomous)
        .toBe(autonomous);
    } finally {
      recovered.dispose();
    }
  });
});
