import { fakeRunnerFactory } from '../core/fake-runner-factory.testkit.ts';
import { useRunners } from '../core/runners-under-test.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { createFixtureManager, drainFixtureManagers } from './fixture-manager.testkit.ts';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** Every spec a (mocked) Cursor runner's `startSession` receives, in spawn order. */
const captured = vi.hoisted(() => ({ specs: [] as AgentRunSpec[], options: [] as Array<{ sessionTransport?: string }> }));

useRunners(fakeRunnerFactory((_backend: string, options: { sessionTransport?: string } = {}) => {
    captured.options.push(options);
    return ({
    backend: 'cursor' as const,
    systemPromptOnResume: 'in-thread' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec) => {
      captured.specs.push(spec);
      return {
        result: Promise.resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 }),
        sendMessage: () => false,
        discardQueuedMessages: () => {}, holdsHumanInput: () => false,
        end: () => {},
        interrupt: () => {},
        open: false,
      };
    },
    interrupt: async () => {},
    });
  }));

/**
 * Continue after a Cursor bootstrap crash must open a fresh session.
 *
 * `run.ts` writes a launch UUID onto the step before Cursor returns a session
 * id, so the step rail has something to show. Continue used that UUID as
 * `session/load` params; Cursor rejected it (`#583`). A session id the runner
 * actually emitted still resumes.
 */
describe('Continue after a Cursor bootstrap crash', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;

  beforeEach(async () => {
    captured.specs.length = 0;
    captured.options.length = 0;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-cursor-bootstrap-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    manager?.dispose();
    manager = undefined;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const LAUNCH_SESSION_ID = 'e339a973-0b14-4963-ab72-6c1dd4e3aa5b';
  const CURSOR_SESSION_ID = 'cursor-sess-confirmed';

  /** Two agent steps at different efforts, so the spec shows which step a Continue runs as. */
  const CHAIN_DEF: WorkflowDef = {
    name: 'two-step',
    source: 'file',
    steps: [
      { id: 'work', name: 'Work', prompt: '{{task}}', effort: 'high' },
      { id: 'review', name: 'Review', prompt: 'review {{task}}', effort: 'low' },
    ],
  };

  function failedCursorRun(sessionId: string, confirmed: boolean, workflowDef?: WorkflowDef): string {
    const record = store.createRun({
      title: 't',
      workflow: workflowDef?.name ?? 'quick-task',
      task: 'do the thing',
      runner: 'cursor',
      steps: (workflowDef?.steps ?? [{ id: 'work', name: 'Work' }]).map(step => ({ id: step.id, name: step.name ?? step.id, kind: STEP_KIND.agent })),
    });
    setRunStatus(store, record.id, RUN_STATUS.failed, { finishedAt: new Date().toISOString(), error: 'Cursor ACP exited unexpectedly (1)', ...(workflowDef ? { workflowDef } : {}) });
    // A real launch writes its step-start event before the runner starts.
    store.appendEvent(record.id, { type: 'step-start', stepId: 'work', name: 'Work', kind: STEP_KIND.agent, iteration: 1 });
    store.updateStep(record.id, 'work', {
      status: STEP_STATUS.failed,
      sessionId,
      backend: 'cursor',
      error: 'Cursor ACP exited unexpectedly (1)',
    });
    if (confirmed) {
      store.appendEvent(record.id, {
        type: 'session',
        stepId: 'work',
        sessionId,
      });
    }
    return record.id;
  }

  async function continueSpec(runId: string): Promise<AgentRunSpec> {
    expect(manager!.continueRun(runId, { text: 'keep going' })).toEqual({ ok: true });
    await expect.poll(() => captured.specs.length, { timeout: 15_000 }).toBeGreaterThan(0);
    return captured.specs[0] as AgentRunSpec;
  }

  async function settled(runId: string): Promise<void> {
    await expect
      .poll(() => store.getRun(runId)?.status, { timeout: 15_000 })
      .toSatisfy((status) => ['done', 'review', 'failed', 'cancelled'].includes(String(status)));
  }

  it('opens session/new instead of loading the launch sessionId', async () => {
    const id = failedCursorRun(LAUNCH_SESSION_ID, false);
    const spec = await continueSpec(id);
    expect(spec.resume).toBeFalsy();
    expect(spec.sessionId).not.toBe(LAUNCH_SESSION_ID);
    await settled(id);
  });

  it('opens the fresh session as the step it continues, not the chain tail', async () => {
    const id = failedCursorRun(LAUNCH_SESSION_ID, false, CHAIN_DEF);
    const spec = await continueSpec(id);
    expect(spec.resume).toBeFalsy();
    expect(spec.effort).toBe('high');
    await settled(id);
  });

  it('hands an untagged confirmed session id to the runner with no transport', async () => {
    const id = failedCursorRun(CURSOR_SESSION_ID, true);
    const spec = await continueSpec(id);
    expect(spec.resume).toBe(true);
    expect(spec.sessionId).toBe(CURSOR_SESSION_ID);
    expect(captured.options[0]).toEqual({});
    await settled(id);
  });

  it('resumes a confirmed print ID through print even after defaults change', async () => {
    const id = failedCursorRun(CURSOR_SESSION_ID, true);
    store.updateStep(id, 'work', { sessionTransport: 'cursor-print', profileId: 'default' });
    store.appendEvent(id, { type: 'session', stepId: 'work', sessionId: CURSOR_SESSION_ID, sessionTransport: 'cursor-print' });
    const spec = await continueSpec(id);
    expect(spec.resume).toBe(true);
    expect(spec.sessionId).toBe(CURSOR_SESSION_ID);
    expect(captured.options[0]).toEqual({ sessionTransport: 'cursor-print' });
    // The Continue step records the owning step's transport, so a crash before its own session
    // event still resumes through print.
    expect(store.getRun(id)?.steps.at(-1)).toMatchObject({ name: 'Continue', sessionTransport: 'cursor-print' });
    await settled(id);
  });

  it('refuses a print checkpoint without matching transport evidence', () => {
    const id = failedCursorRun(CURSOR_SESSION_ID, true);
    store.updateStep(id, 'work', { sessionTransport: 'cursor-print' });
    expect(manager!.continueRun(id, { text: 'keep going' })).toEqual({
      ok: false, error: 'Cursor print session identity lacks a matching recorded session event',
    });
    expect(captured.specs).toHaveLength(0);
  });

  it('does not requeue a print checkpoint as a fresh session on restart', async () => {
    const id = failedCursorRun(CURSOR_SESSION_ID, true);
    store.updateStep(id, 'work', { sessionTransport: 'cursor-print' });
    store.addStep(id, { id: 'continue-1', name: 'Continue', kind: STEP_KIND.agent, synthetic: 'continuation' });
    setRunStatus(store, id, RUN_STATUS.queued, { finishedAt: undefined });
    await manager!.recover(id);
    expect(store.getRun(id)?.status).toBe('failed');
    expect(captured.specs).toHaveLength(0);
  });
});
