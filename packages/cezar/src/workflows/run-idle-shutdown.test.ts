import { describe, expect, it } from 'vitest';
import type { AgentRunResult } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import { RUN_STATUS, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { runnerHook, setupMonitoringFixture } from './run-fixture.testkit.ts';
describe('RunManager idle shutdown', () => {
  const fixture = setupMonitoringFixture();
  const { SINGLE_STEP, waitFor } = fixture;
  it('honors cancellation that races an idle-close callback', async () => {
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'plain markerless turn', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, candidate => candidate?.status === 'waiting');
    const state = (fixture.manager as unknown as { active: Map<string, { idleTimer?: NodeJS.Timeout }> }).active.get(record.id);
    const idleTimer = state?.idleTimer as (NodeJS.Timeout & { _onTimeout?: () => void }) | undefined;
    if (!idleTimer?._onTimeout) throw new Error('waiting session did not arm an idle timer');

    idleTimer._onTimeout();
    expect(fixture.manager.cancel(record.id)).toBe(true);
    await waitFor(record.id, candidate => candidate?.status === 'cancelled');
    expect(fixture.store.getRun(record.id)).toMatchObject({ status: RUN_STATUS.cancelled });
    expect(fixture.store.getRun(record.id)?.finishedAt).toBeDefined();
    expect(fixture.store.getRun(record.id)?.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'task', status: STEP_STATUS.cancelled }),
    ]));
  }, 30_000);

  it('publishes a runner failure that occurs during idle shutdown', async () => {
    runnerHook.runner = {
      backend: 'claude',
      specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }),
      interrupt: async () => undefined,
      startSession: (_spec, onEvent) => {
        let rejectResult: (error: Error) => void = () => undefined;
        const result = new Promise<AgentRunResult>((_resolve, reject) => { rejectResult = reject; });
        let open = true;
        queueMicrotask(() => onEvent?.({ type: 'turn-end' }));
        return {
          result,
          sendMessage: () => false,
          sendAgentMessage: () => false,
          discardQueuedMessages: () => undefined, holdsHumanInput: () => false,
          end: () => {
            open = false;
            rejectResult(new Error('provider failed during shutdown'));
          },
          interrupt: () => { open = false; },
          get open() { return open; },
        };
      },
    };
    const record = fixture.manager.startRun(SINGLE_STEP, { task: 'wait then fail', worktree: false });
    fixture.currentId = record.id;
    await waitFor(record.id, candidate => candidate?.status === 'waiting');
    const state = (fixture.manager as unknown as { active: Map<string, { idleTimer?: NodeJS.Timeout }> }).active.get(record.id);
    const idleTimer = state?.idleTimer as (NodeJS.Timeout & { _onTimeout?: () => void }) | undefined;
    if (!idleTimer?._onTimeout) throw new Error('waiting session did not arm an idle timer');

    idleTimer._onTimeout();
    await waitFor(record.id, candidate => candidate?.status === 'failed');
    expect(fixture.store.getRun(record.id)).toMatchObject({
      status: RUN_STATUS.failed, error: expect.stringContaining('provider failed during shutdown'),
    });
  }, 30_000);
});
