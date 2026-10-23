import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** Legacy true/false/absent fields never prevent queue recovery, even without a live session. */
describe('recover() reads legacy generated-inbox records — hearsay-tools/cezarion#1543', () => {
  let repoRoot: string;
  let store: RunStore;
  const savedFollowups = process.env.CEZ_FOLLOWUPS;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-recover-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  // Capped at 0 — recover() re-queues, the queue never drains, no agent is spawned.
  const frozen = () =>
    new WorkspaceSemaphore({ initial: { maxParallel: 0 } });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedFollowups === undefined) delete process.env.CEZ_FOLLOWUPS;
    else process.env.CEZ_FOLLOWUPS = savedFollowups;
  });

  const WORKFLOW_DEF = {
    name: 'quick-task',
    description: 'x',
    source: 'built-in' as const,
    steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
  };

  /** A run left `queued` by a crash. `workflowDef` is persisted by a follow-up updateRun, the
   *  way startRun does it (run.ts:254) — recover() revives the workflow from it. */
  const queuedRun = (generateFollowups: boolean | undefined): string => {
    const { id } = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 'do it',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateRun(id, { workflowDef: WORKFLOW_DEF, generateFollowups });
    return id;
  };

  it('reads and recovers an old true record without a live session', async () => {
    delete process.env.CEZ_FOLLOWUPS;
    const id = queuedRun(true);
    expect(store.getRun(id)?.generateFollowups).toBe(true); // the pre-restart truth

    await createFixtureManager(store, repoRoot, { semaphore: frozen() }).recover();

    // Preserve historical data without using it to control generation.
    expect(store.getRun(id)?.generateFollowups).toBe(true);
    expect(store.getRun(id)?.status).toBe('queued');
  });

  it.each([true, false, undefined])('recovers the legacy %s preference even with the retired env flag set', async (preference) => {
    process.env.CEZ_FOLLOWUPS = '1';
    const id = queuedRun(preference);

    await createFixtureManager(store, repoRoot, { semaphore: frozen() }).recover();

    expect(store.getRun(id)?.generateFollowups).toBe(preference);
    expect(store.getRun(id)?.status).toBe('queued');
  });

  it('recovers a legacy false record', async () => {
    process.env.CEZ_FOLLOWUPS = '1';
    const id = queuedRun(false);

    await createFixtureManager(store, repoRoot, { semaphore: frozen() }).recover();

    expect(store.getRun(id)?.generateFollowups).toBe(false);
  });
});
