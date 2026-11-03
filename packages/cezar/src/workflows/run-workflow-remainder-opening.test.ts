import { runInternals } from './run-internals.testkit.ts';
import { describe, expect, it, vi } from 'vitest';
import type { ContentBlock } from '../core/agent-runner.ts';
import { CLAUDE_SPEC_SUPPORT } from '../core/claude-cli-runner.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import type { WorkflowDef } from './types.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { runnerHook, setupMonitoringFixture } from './run-fixture.testkit.ts';
describe('RunManager workflow remainder opening', () => {
  const fixture = setupMonitoringFixture();
  it('preserves startedAt when a resumed workflow remainder is held and requeued', () => {
    const startedAt = '2026-09-01T00:00:00.000Z';
    const workflow: WorkflowDef = { name: 'held-remainder', source: 'file', steps: [
      { id: 'task', name: 'Task', prompt: '{{task}}' },
      { id: 'later', name: 'Later', command: 'true' },
    ] };
    const record = fixture.store.createRun({
      title: 'held remainder', task: 'task', workflow: workflow.name,
      steps: [
        { id: 'task', name: 'Task', kind: STEP_KIND.agent },
        { id: 'later', name: 'Later', kind: STEP_KIND.check },
      ],
    });
    fixture.currentId = record.id;
    fixture.store.updateRun(record.id, { startedAt });
    const semaphore = (fixture.manager as unknown as { semaphore: WorkspaceSemaphore }).semaphore;
    vi.spyOn(semaphore, 'accountHolds').mockReturnValue({
      deadline: new Set(['claude:default']),
      inFlight: new Set(),
    });
    const held = runInternals(fixture.manager).stepLoop.requeueWhileHeld(record.id, workflow, { task: record.task }, 'claude', undefined, 1);

    expect(held).toBe(true);
    expect(fixture.store.getRun(record.id)).toMatchObject({ status: RUN_STATUS.queued, startedAt });
  });

  it('delivers opening images when recovery resumes after checks but before the first agent', async () => {
    const openingImage: ContentBlock = {
      type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
    };
    let receivedImages: ContentBlock[] | undefined;
    runnerHook.runner = {
      backend: 'claude',
      specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent',
      run: async () => ({ text: 'done', toolCalls: [], tokensUsed: 0 }),
      interrupt: async () => undefined,
      startSession: (spec) => {
        receivedImages = spec.images;
        return {
          result: Promise.resolve({ text: 'done', toolCalls: [], tokensUsed: 0 }),
          sendMessage: () => false,
          sendAgentMessage: () => false,
          discardQueuedMessages: () => undefined, holdsHumanInput: () => false,
          end: () => undefined,
          interrupt: () => undefined,
          open: false,
        };
      },
    };
    const workflow: WorkflowDef = { name: 'checks-before-agent', source: 'file', steps: [
      { id: 'preflight', name: 'Preflight', command: 'true' },
      { id: 'task', name: 'Task', prompt: '{{task}}' },
      { id: 'verify', name: 'Verify', command: 'true' },
    ] };
    const record = fixture.store.createRun({
      title: 'resume before agent', task: 'task', workflow: workflow.name,
      steps: [
        { id: 'preflight', name: 'Preflight', kind: STEP_KIND.check },
        { id: 'task', name: 'Task', kind: STEP_KIND.agent },
        { id: 'verify', name: 'Verify', kind: STEP_KIND.check },
      ],
    });
    fixture.currentId = record.id;
    fixture.store.updateStep(record.id, 'preflight', { status: STEP_STATUS.done, iterations: 1 });
    await (fixture.manager as unknown as {
      execute(id: string, definition: WorkflowDef, input: { task: string; worktree: boolean; images: ContentBlock[] }, startAt: number): Promise<void>;
    }).execute(record.id, workflow, { task: record.task, worktree: false, images: [openingImage] }, 1);

    expect(receivedImages).toEqual([openingImage]);
  }, 30_000);
});
