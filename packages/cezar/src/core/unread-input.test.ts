import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AgentInput } from '@open-mercato/cezar-contract';
import { HARNESS_ADAPTERS, waitFor, withOwnedInputRun } from './harness-parity.testkit.ts';

// #505: accepted input a finished turn never read goes back to the queue and is
// submitted again; DONE and park never finish over it.
describe('unread agent input is resubmitted (#505)', () => {
  const late = (parentRunId: string): AgentInput => ({ id: randomUUID(), source: 'agent', parentRunId,
    text: 'mock:agent-echo late parent guidance', createdAt: new Date().toISOString() });

  it('codex resubmits a steer the finished turn never read, then reads it once', async () => {
    await withOwnedInputRun('codex', 'steer-late', async ({ store, manager, runId, parentRunId }) => {
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes('late window')));
      const input = late(parentRunId);
      manager.steerWorker(runId, input);
      await waitFor(() => !!store.getRun(runId)?.agentInputs?.[0]?.consumedAt, 15_000);
      expect(store.readEvents(runId).some(e => e.type === 'note' && String(e.message).includes('did not read'))).toBe(true);
      expect(store.readEvents(runId).filter(e => e.type === 'text' && String(e.text).includes('late parent guidance'))).toHaveLength(1);
    });
  }, 60_000);

  it('codex keeps a CEZ:DONE session open until a resubmitted input is read', async () => {
    const adapter = HARNESS_ADAPTERS.codex as { scenarios: Record<string, string> };
    const original = adapter.scenarios['steer-late']!;
    adapter.scenarios['steer-late'] = 'mock:steer-late mock:done-late';
    try {
      await withOwnedInputRun('codex', 'steer-late', async ({ store, manager, runId, parentRunId }) => {
        manager.enqueueOwnedRun(runId);
        await waitFor(() => store.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes('late window')));
        manager.steerWorker(runId, late(parentRunId));
        await waitFor(() => !!store.getRun(runId)?.agentInputs?.[0]?.consumedAt, 15_000);
        // The goal-achieved close never ran over the unread input.
        const closed = store.readEvents(runId).findIndex(e => e.type === 'lifecycle' && String(e.message).includes('goal achieved'));
        const echoed = store.readEvents(runId).findIndex(e => e.type === 'text' && String(e.text).includes('late parent guidance'));
        expect(echoed).toBeGreaterThan(-1);
        if (closed >= 0) expect(closed).toBeGreaterThan(echoed);
      });
    } finally { adapter.scenarios['steer-late'] = original; }
  }, 60_000);
});
