import { describe, expect, it, vi } from 'vitest';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { AgentRunResult, AgentSession } from '../../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../../core/claude-cli-runner.ts';
import { runnerHook, setupMonitoringFixture, waitForProduct } from '../run-fixture.testkit.ts';

describe('session fault precedence through the public run', () => {
  const fixture = setupMonitoringFixture();

  it('keeps the first of two provider faults in the same turn', async () => {
    let emitFault!: (message: string) => void;
    let close!: () => void;
    let opened!: () => void;
    const opening = new Promise<void>(resolve => { opened = resolve; });
    const interrupt = vi.fn();
    runnerHook.runner = {
      backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => {},
      startSession(_spec, onEvent) {
        let finish!: (value: AgentRunResult) => void;
        const result = new Promise<AgentRunResult>(resolve => { finish = resolve; });
        let open = true;
        close = () => { open = false; finish({ text: '', toolCalls: [], tokensUsed: 0 }); };
        emitFault = message => onEvent?.({ type: 'error', message });
        const session: AgentSession = { get open() { return open; }, result, end: close, interrupt,
          sendMessage: () => true, sendAgentMessage: async () => {}, discardQueuedMessages: () => {}, holdsHumanInput: () => false };
        opened();
        return session;
      },
    };
    const run = fixture.manager.startRun(fixture.SINGLE_STEP, { task: 'two provider faults', worktree: false });
    fixture.currentId = run.id;
    await opening;
    emitFault('first provider fault');
    emitFault('second provider fault');
    expect(interrupt).toHaveBeenCalledTimes(2);
    close();
    // bound: the owned session result and bookkeeping release the run without polling.
    await waitForProduct(fixture.manager, fixture.store, () => !fixture.manager.isActive(run.id));
    expect(fixture.store.getRun(run.id)?.status).toBe(RUN_STATUS.failed);
    expect(fixture.store.getRun(run.id)?.error).toBe('step "task" failed: first provider fault');
    expect(fixture.store.getRun(run.id)?.steps[0]?.error).toBe('first provider fault');
    expect(fixture.store.readEvents(run.id).filter(event => event.type === 'error').map(event => event.message))
      .toEqual(['first provider fault', 'second provider fault']);
  });
});
