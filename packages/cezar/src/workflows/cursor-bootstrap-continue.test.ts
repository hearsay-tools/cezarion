import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSpec } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** Every spec a (mocked) Cursor runner's `startSession` receives, in spawn order. */
const captured = vi.hoisted(() => ({ specs: [] as AgentRunSpec[] }));

vi.mock('../core/runner-factory.ts', () => ({
  createRunner: () => ({
    backend: 'cursor' as const,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
    startSession: (spec: AgentRunSpec) => {
      captured.specs.push(spec);
      return {
        result: Promise.resolve({ text: 'ok', toolCalls: [], tokensUsed: 0 }),
        sendMessage: () => false,
        discardQueuedMessages: () => {},
        end: () => {},
        interrupt: () => {},
        open: false,
      };
    },
    interrupt: async () => {},
  }),
}));

/**
 * Continue after a Cursor ACP bootstrap crash must open `session/new`.
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
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-cursor-bootstrap-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(async () => {
    manager?.dispose();
    manager = undefined;
    store.flush();
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        break;
      } catch (err) {
        if (attempt >= 5) throw err;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  });

  const LAUNCH_SESSION_ID = 'e339a973-0b14-4963-ab72-6c1dd4e3aa5b';
  const CURSOR_SESSION_ID = 'cursor-sess-confirmed';

  function failedCursorRun(sessionId: string, confirmed: boolean): string {
    const record = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 'do the thing',
      runner: 'cursor',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateRun(record.id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: 'Cursor ACP exited unexpectedly (1)',
    });
    store.updateStep(record.id, 'work', {
      status: 'failed',
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

  it('still session/loads a Cursor-confirmed session id', async () => {
    const id = failedCursorRun(CURSOR_SESSION_ID, true);
    const spec = await continueSpec(id);
    expect(spec.resume).toBe(true);
    expect(spec.sessionId).toBe(CURSOR_SESSION_ID);
    await settled(id);
  });
});
