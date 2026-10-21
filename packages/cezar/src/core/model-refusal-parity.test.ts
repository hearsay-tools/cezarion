import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { driveRun, driveSeam, MODEL_REFUSAL_CRITERIA, promptFor, waitFor } from './harness-parity.testkit.ts';

// Use each runner's native rejection. Claude alone has the selected-model +
// zero-usage result that this change classifies; other wires keep their existing
// rejection policy. None may swallow the error because an earlier turn worked.
describe('post-success provider refusal parity (hearsay-tools/cezarion#1351)', () => {
  for (const backend of RUNNER_IDS) {
    const criterion = MODEL_REFUSAL_CRITERIA[0];
    it(`${backend} ${criterion.id} ${criterion.name}`, async () => {
      const observed = await driveSeam(backend, criterion.scenario, {
        timeoutMs: 45_000,
        spec: { userPrompt: backend === 'claude' ? 'mock:model-refusal:seed' : promptFor(backend, 'baseline') },
        whileOpen: async (session, { v1 }) => {
          await waitFor(() => v1.some(e => e.type === 'turn-end'));
          expect(v1.some(e => e.type === 'error')).toBe(false);
          expect(session.sendMessage([{ type: 'text', text: promptFor(backend, criterion.scenario) }])).toBe(true);
          await waitFor(() => v1.some(e => e.type === 'error'), 40_000);
        },
      });
      expect(observed.v1.some(e => e.type === 'error' && e.message.trim() !== '')).toBe(true);
      if (backend === 'claude') {
        expect(observed.v1.filter(e => e.type === 'note' && /retrying.*\/2/.test(e.message))).toHaveLength(2);
        expect(observed.v1.filter(e => e.type === 'turn-end')).toHaveLength(2);
        expect(observed.v1.filter(e => e.type === 'error')).toEqual([{
          type: 'error', message: "There's an issue with the selected model (claude-test-model). It may not exist or you may not have access to it. Run --model to pick a different model.",
        }]);
        expect(observed.v2.filter(e => e.type === 'turn.started')).toHaveLength(4);
        expect(observed.v2.filter(e => e.type === 'turn.completed')).toHaveLength(4);
      }
    }, 60_000);
  }
});

// The workflow must remain active through the native error turn, rather than
// failing or parking on the intermediate v2 turn.completed(error).
it('Claude retry keeps the workflow step active until the recovered turn ends', async () => {
  let completed = false;
  const observation = await driveRun('claude', { prompt: 'mock:model-refusal:seed' },
    () => completed, 30_000, undefined, {
      during: async ({ store, manager, runId }) => {
        await waitFor(() => store.getRun(runId)?.status === 'waiting');
        expect(manager.sendMessage(runId, [{ type: 'text', text: 'mock:model-refusal:once' }])).toBe(true);
        await waitFor(() => store.readEvents(runId).some(e => e.type === 'note' && /retrying/.test(String(e.message))));
        expect(store.getRun(runId)?.status).toBe('running');
        expect(store.getRun(runId)?.steps[0]?.status).toBe('running');
        expect(store.readEvents(runId).some(e => e.type === 'error')).toBe(false);
        await waitFor(() => store.getRun(runId)?.status === 'waiting'
          && store.readEvents(runId).some(e => e.type === 'text' && e.text === 'Completed mock:model-refusal:once'), 15_000);
        completed = true;
      },
    });
  expect(observation.record?.status).toBe('waiting');
  expect(observation.statuses).not.toContain('failed');
  expect(observation.events.some(e => e.type === 'step-end' && e.status === 'failed')).toBe(false);
}, 45_000);
