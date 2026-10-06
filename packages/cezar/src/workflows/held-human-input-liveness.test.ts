/**
 * #486 review: a held human follow-up that drains without opening a turn must
 * not leave the run stuck `running`. The backstop timer re-settles that boundary.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunResult, AgentRunner, AgentSession } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import { RunStore } from '../runs/store.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const runnerHook = vi.hoisted(() => ({ runner: undefined as AgentRunner | undefined }));
vi.mock('../core/runner-factory.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/runner-factory.ts')>();
  return {
    ...actual,
    createRunner: (...args: Parameters<typeof actual.createRunner>) => runnerHook.runner ?? actual.createRunner(...args),
  };
});

const SINGLE_STEP: WorkflowDef = {
  name: 'quick-task',
  source: 'built-in',
  steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
};

describe('held human input liveness bound (#486)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-486-live-'));
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
    runnerHook.runner = undefined;
    await drainFixtureManagers(repoRoot);
    store.close();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('re-settles a DONE boundary after holdsHumanInput flips false without a new turn', async () => {
    let holding = true;
    let open = true;
    let finish!: (result: AgentRunResult) => void;
    runnerHook.runner = {
      backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT,
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
      interrupt: async () => undefined,
      startSession(spec, onEvent, opts): AgentSession {
        const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
        queueMicrotask(() => {
          opts?.onUiEvent?.({ type: 'session.started', sessionId: spec.sessionId ?? 's', backend: 'claude' });
          opts?.onUiEvent?.({ type: 'turn.started', turnId: 't1' });
          onEvent?.({ type: 'text', text: 'Working.\nCEZ:DONE' });
          onEvent?.({ type: 'turn-end' });
        });
        const close = () => {
          if (!open) return;
          open = false;
          finish({ text: 'Working.', toolCalls: [], tokensUsed: 0, sessionId: spec.sessionId });
        };
        return {
          result, sendMessage: () => true, sendAgentMessage: () => false,
          discardQueuedMessages: () => undefined, holdsHumanInput: () => holding,
          end: close, interrupt: close, get open() { return open; },
        };
      },
    };

    const record = manager.startRun(SINGLE_STEP, { task: 'hold then drain', runner: 'claude', worktree: false });
    const deadline = Date.now() + 8_000;
    while (!store.readEvents(record.id).some(e => e.type === 'turn-end')) {
      if (Date.now() > deadline) throw new Error('turn-end never arrived');
      await new Promise(r => setTimeout(r, 20));
    }
    expect(store.getRun(record.id)?.status).toBe('running');
    expect(store.readEvents(record.id).some(e => e.type === 'lifecycle' && String(e.message).includes('goal achieved'))).toBe(false);
    holding = false;
    while (!['done', 'review', 'failed', 'waiting'].includes(store.getRun(record.id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error(`run stuck ${store.getRun(record.id)?.status}`);
      await new Promise(r => setTimeout(r, 20));
    }
    expect(['done', 'review']).toContain(store.getRun(record.id)?.status);
    expect(store.readEvents(record.id).some(e => e.type === 'lifecycle' && String(e.message).includes('goal achieved'))).toBe(true);
  }, 15_000);

  it('expires a hold that never drains and settles with an unconfirmed-read note', async () => {
    let open = true;
    let finish!: (result: AgentRunResult) => void;
    runnerHook.runner = {
      backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT,
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
      interrupt: async () => undefined,
      startSession(spec, onEvent, opts): AgentSession {
        const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
        queueMicrotask(() => {
          opts?.onUiEvent?.({ type: 'session.started', sessionId: spec.sessionId ?? 's', backend: 'claude' });
          opts?.onUiEvent?.({ type: 'turn.started', turnId: 't1' });
          onEvent?.({ type: 'text', text: 'Working.\nCEZ:DONE' });
          onEvent?.({ type: 'turn-end' });
        });
        const close = () => {
          if (!open) return;
          open = false;
          finish({ text: 'Working.', toolCalls: [], tokensUsed: 0, sessionId: spec.sessionId });
        };
        return {
          result, sendMessage: () => true, sendAgentMessage: () => false,
          discardQueuedMessages: () => undefined, holdsHumanInput: () => true,
          end: close, interrupt: close, get open() { return open; },
        };
      },
    };

    (manager as unknown as { unreadInputGraceMs: number }).unreadInputGraceMs = 300;
    const record = manager.startRun(SINGLE_STEP, { task: 'hold forever', runner: 'claude', worktree: false });
    const deadline = Date.now() + 8_000;
    while (!['done', 'review', 'failed', 'waiting'].includes(store.getRun(record.id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error(`run stuck ${store.getRun(record.id)?.status}`);
      await new Promise(r => setTimeout(r, 20));
    }
    expect(['done', 'review']).toContain(store.getRun(record.id)?.status);
    expect(store.readEvents(record.id).some(e => e.type === 'note' && String(e.message).includes('did not confirm reading'))).toBe(true);
    expect(store.readEvents(record.id).some(e => e.type === 'lifecycle' && String(e.message).includes('goal achieved'))).toBe(true);
  }, 15_000);
});
