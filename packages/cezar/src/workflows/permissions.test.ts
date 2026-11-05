import { runnerHook, setupMonitoringFixture, waitForProduct } from './run-fixture.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunResult, AgentSession } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import type { UiEvent } from '../core/ui-events.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { createFixtureManager } from './fixture-cleanup.testkit.ts';

describe('human permission lifecycle', () => {
  const f = setupMonitoringFixture();
  let id: string;
  let session: AgentSession | undefined;
  let open: boolean;
  let emit: (event: UiEvent) => void;
  let agentEvent: (event: AgentEvent) => void;
  let semaphore: WorkspaceSemaphore;
  const request = (requestId: string) => emit({ type: 'permission.requested', requestId, title: 'Run command', options: [{ id: 'deny', label: 'Decline', kind: 'reject_once' }] });

  beforeEach(async () => {
    session = undefined;
    open = true;
    f.manager.dispose();
    semaphore = new WorkspaceSemaphore();
    f.manager = createFixtureManager(f.store, f.repoRoot, { semaphore });
    runnerHook.runner = {
      backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => {},
      startSession(_spec, onEvent, options) {
        let finish!: (result: AgentRunResult) => void;
        const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
        emit = event => options?.onUiEvent?.(event);
        agentEvent = event => onEvent?.(event);
        const close = () => { open = false; finish({ text: '', toolCalls: [], tokensUsed: 0 }); };
        session = { get open() { return open; }, result, sendMessage: vi.fn(() => true), sendAgentMessage: vi.fn(async () => {}),
          respondPermission: vi.fn((requestId, optionId) => {
            if (optionId !== 'deny') return false;
            emit({ type: 'permission.resolved', requestId, optionId }); return true;
          }), end: close, interrupt: close, discardQueuedMessages: vi.fn(), holdsHumanInput: () => false };
        queueMicrotask(() => agentEvent({ type: 'session', sessionId: 'permission-session' }));
        return session;
      },
    };
    const record = f.manager.startRun(f.SINGLE_STEP, { task: 'work', autonomous: true, runner: 'claude', worktree: false });
    id = record.id;
    f.currentId = id;
    await waitForProduct(f.manager, f.store, () => {
      const current = f.store.getRun(id);
      if (current?.status === 'failed') throw new Error(current.error);
      if (!session && current?.status !== 'queued' && current?.status !== 'running') throw new Error(`Unexpected startup status: ${current?.status}`);
      return !!session;
    });
  });

  function liveSession(): AgentSession {
    if (!session) throw new Error('runner session missing');
    return session;
  }

  it('parks concurrent requests until their exact IDs resolve and blocks all ordinary input', () => {
    const session = liveSession();
    // Without an exemption, a wrongly pooled permission park would cost a slot.
    const monitoringLimit = vi.spyOn(semaphore, 'maxMonitoringSessions').mockReturnValue(0);
    request('a'); request('b');
    expect(f.store.getRun(id)).toMatchObject({ status: RUN_STATUS.waiting, hasPendingPermission: true });
    expect(semaphore.busy()).toBe(0);
    expect(f.manager.sendMessage(id, [{ type: 'text', text: 'accept' }])).toBe(false);
    agentEvent({ type: 'turn-end' });
    expect(session.sendMessage).not.toHaveBeenCalled();
    expect(session.sendAgentMessage).not.toHaveBeenCalled();
    expect(f.store.readEvents(id).some(event => event.type === 'user-message')).toBe(false);
    expect(f.manager.respondPermission(id, 'a', 'invalid')).toBe(false);
    expect(f.manager.respondPermission(id, 'unknown', 'deny')).toBe(false);
    expect(f.manager.respondPermission(id, 'a', 'deny')).toBe(true);
    expect(f.store.getRun(id)).toMatchObject({ status: RUN_STATUS.waiting, hasPendingPermission: true });
    expect(f.manager.respondPermission(id, 'a', 'deny')).toBe(false);
    monitoringLimit.mockRestore();
    expect(f.manager.respondPermission(id, 'b', 'deny')).toBe(true);
    expect(f.store.getRun(id)).toMatchObject({ status: RUN_STATUS.running, hasPendingPermission: false });
    expect(semaphore.busy()).toBe(1);
  });

  it.each(['cancelled', 'stopping', 'closed'] as const)('%s refuses decisions and teardown clears attention', async reason => {
    const session = liveSession();
    request('a');
    if (reason === 'cancelled') f.manager.cancel(id);
    if (reason === 'stopping') f.store.updateRun(id, { stopping: true });
    if (reason === 'closed') open = false;
    expect(f.manager.respondPermission(id, 'a', 'deny')).toBe(false);
    expect(session.respondPermission).not.toHaveBeenCalled();
    f.manager.cancel(id);
    await waitForProduct(f.manager, f.store, () => !f.manager.isActive(id));
    expect(f.store.getRun(id)?.hasPendingPermission).toBe(false);
    expect(f.manager.respondPermission(id, 'a', 'deny')).toBe(false);
  });
});
