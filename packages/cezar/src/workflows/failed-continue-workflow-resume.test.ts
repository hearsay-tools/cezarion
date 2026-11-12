import { setRunStatus } from '../runs/run-store.testkit.ts';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { RunStore } from '../runs/store.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-claude.testkit.ts';
import type { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Slice S7, Table B row B11 (.ai/specs/2026-11-03-run-store-owns-exits.md). A root parks with an
 * earlier workflow step `waiting` when its session closes without done (settleIncompleteStep);
 * that step is the cursor a Continue resumes. A Continue that fails settles the run failed, and
 * the exit to failed must keep the cursor waiting: the next Continue then resumes the step and
 * runs the rest of the workflow.
 */
describe('a failed Continue on a root parked at an earlier workflow step', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  let dryRun: string | undefined;

  const workflow: WorkflowDef = {
    name: 'two-steps', source: 'file',
    steps: [{ id: 'a', name: 'A', prompt: '{{task}}' }, { id: 'b', name: 'B', prompt: 'mock:cezar-done step b' }],
  };
  const stepStatus = (id: string, stepId: string) => store.getRun(id)?.steps.find(step => step.id === stepId)?.status;

  beforeEach(async () => {
    dryRun = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-failed-continue-'));
    // bound: five local git commands; 10 s each covers a loaded host.
    const git = (args: string[]) => run('git', args, { cwd: repoRoot, timeout: 10_000 });
    await git(['init', '-q', '-b', 'main']);
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await git(['add', '-A']);
    await git([...GIT_ID, 'commit', '-q', '-m', 'base']);
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  }, 60_000);

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    manager?.dispose();
    manager = undefined;
    if (dryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = dryRun;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('keeps the step waiting, and the next Continue resumes it and runs the next step', async () => {
    const { id } = store.createRun({ title: 'resume', task: 'mock:cezar-done step a', workflow: workflow.name, workflowDef: workflow,
      steps: workflow.steps.map(step => ({ id: step.id, name: step.name!, kind: STEP_KIND.agent })) });
    setRunStatus(store, id, RUN_STATUS.waiting, { currentStepId: 'a', runner: 'claude', startedAt: new Date().toISOString() });
    store.updateStep(id, 'a', { status: STEP_STATUS.waiting, iterations: 1, sessionId: '11111111-1111-4111-8111-111111111111', backend: 'claude' });
    store.flush();
    manager = createFixtureManager(store, repoRoot);

    expect(manager.continueRun(id, { text: 'mock:request-error resume' })).toEqual({ ok: true });
    await expect.poll(() => store.getRun(id)?.status, { timeout: 20_000 }).toBe(RUN_STATUS.failed);
    expect(stepStatus(id, 'a')).toBe(STEP_STATUS.waiting);

    expect(manager.continueRun(id, { text: 'mock:cezar-done resume' })).toEqual({ ok: true });
    await expect.poll(() => store.getRun(id)?.status, { timeout: 20_000 }).toBe(RUN_STATUS.done);
    expect([stepStatus(id, 'a'), stepStatus(id, 'b')]).toEqual([STEP_STATUS.done, STEP_STATUS.done]);
  }, 60_000);
});
